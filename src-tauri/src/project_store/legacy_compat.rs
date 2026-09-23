//! Compatibility for the two retired prototype migrations only.
//! Historical checksums are aliases in memory, never rewritten in a database.
//! The SQL plugin must preload only after this plugin's synchronous setup ends.
use super::{StoreError, StoreResult};
use sqlx::{
    migrate::{Migration, MigrationSource, MigrationType, Migrator},
    sqlite::SqliteConnectOptions,
    Connection, Row, SqliteConnection,
};
use std::{
    borrow::Cow,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

const INITIAL_SQL: &str = include_str!("../../migrations/001_initial.sql");
const CAPACITY_SQL: &str = include_str!("../../migrations/002_capacity_planner_schema.sql");
const INITIAL_LF: &str = "ac10ab391e200ea55a47dbc9e1c2472e7329d695e3a9c9f5c75027779dee41efb24182c691023e7ce0adf6cdd5f2ac3f";
const INITIAL_CRLF: &str = "7fc93a8c82a6b09fbadcae4c7069ab3b66d1d4ca0436ca9ce6061e86a0eb1582d4492a78e2a3d222039c7f71540798f8";
// Exact pre-publication script digests. Its former seed text is not retained.
const HISTORICAL_LF: &str = "d84c052af74a5c3ba345bd213717ebd8ad2cb85a19f40d90cdf4ccb020627b47b6f2cf124f5b406fda7c795bbd0fe9c6";
const HISTORICAL_CRLF: &str = "ad9ea545bef348ac97563ad8c8e339c56587a201675f7d32eeda6bec2a5250a8bd6311a9a904e5f96b50e674690be6bd";
const SANITIZED_LF: &str = "7b1e4a34c9674f81176bc9b59922605e66abe761cafa6cd1812998ef3b3895fd30681787e4c82c27d637bdfdcd6e6783";

type SetupError = Box<dyn std::error::Error>;
type Schema = Vec<(String, String, String, Option<String>)>;

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidProject(message.into())
}

fn digest(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&hex[offset..offset + 2], 16).expect("fixed SHA-384 digest")
        })
        .collect()
}

fn pinned_migrations(initial: &'static str, capacity: &'static str) -> StoreResult<Vec<Migration>> {
    let migrations = vec![
        Migration::new(
            1,
            "create initial prototype schema".into(),
            MigrationType::ReversibleUp,
            initial.into(),
            false,
        ),
        Migration::new(
            2,
            "create capacity planner schema".into(),
            MigrationType::ReversibleUp,
            capacity.into(),
            false,
        ),
    ];
    // A later SQL edit must not silently inherit the historical checksum alias.
    if migrations[0].checksum.as_ref() != digest(INITIAL_LF)
        || migrations[1].checksum.as_ref() != digest(SANITIZED_LF)
    {
        return Err(invalid("Изменены утверждённые исходники legacy-миграций"));
    }
    Ok(migrations)
}

#[derive(Debug)]
struct EmbeddedMigrations(Vec<Migration>);
impl MigrationSource<'static> for EmbeddedMigrations {
    fn resolve(
        self,
    ) -> Pin<
        Box<dyn Future<Output = Result<Vec<Migration>, sqlx::error::BoxDynError>> + Send + 'static>,
    > {
        Box::pin(async move { Ok(self.0) })
    }
}

async fn migrator(migrations: Vec<Migration>) -> StoreResult<Migrator> {
    Migrator::new(EmbeddedMigrations(migrations))
        .await
        .map_err(|error| invalid(&format!("Ошибка подготовки legacy-миграций: {error}")))
}

async fn migrate(connection: &mut SqliteConnection, migrations: Vec<Migration>) -> StoreResult<()> {
    migrator(migrations)
        .await?
        .run_direct(connection)
        .await
        .map_err(|error| invalid(&format!("Ошибка legacy-миграций: {error}")))
}

async fn schema(connection: &mut SqliteConnection) -> StoreResult<Schema> {
    let rows =
        sqlx::query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
            .fetch_all(connection)
            .await?;
    rows.into_iter()
        .map(|row| {
            let sql: Option<String> = row.try_get("sql")?;
            Ok((
                row.try_get("type")?,
                row.try_get("name")?,
                row.try_get("tbl_name")?,
                sql.map(|value| value.split_whitespace().collect::<Vec<_>>().join(" ")),
            ))
        })
        .collect()
}

/// Schema only: no historical personal values or copies of a user's rows.
async fn reference_schemas() -> StoreResult<[Schema; 3]> {
    let mut connection = SqliteConnection::connect("sqlite::memory:").await?;
    let result: StoreResult<[Schema; 3]> = async {
        migrate(&mut connection, vec![]).await?;
        let empty_history = schema(&mut connection).await?;
        let mut initial = pinned_migrations(INITIAL_SQL, CAPACITY_SQL)?;
        initial.truncate(1);
        migrate(&mut connection, initial).await?;
        let version_one = schema(&mut connection).await?;
        migrate(
            &mut connection,
            pinned_migrations(INITIAL_SQL, CAPACITY_SQL)?,
        )
        .await?;
        let version_two = schema(&mut connection).await?;
        Ok([empty_history, version_one, version_two])
    }
    .await;
    let closed = connection.close().await;
    let schemas = result?;
    closed?;
    Ok(schemas)
}

/// An empty vector means a fresh database. Applied entries are exact aliases
/// that may be used only for this connection's already-applied migrations.
async fn classify(
    connection: &mut SqliteConnection,
    expected: &[Schema; 3],
) -> StoreResult<Vec<(i64, Vec<u8>)>> {
    let actual_schema = schema(connection).await?;
    if actual_schema.is_empty() {
        return Ok(vec![]);
    }
    // Validate the ledger's own table before querying untrusted schema objects.
    let expected_ledger = expected[0]
        .iter()
        .find(|object| object.1 == "_sqlx_migrations")
        .expect("SQLx migration table");
    if actual_schema
        .iter()
        .find(|object| object.1 == "_sqlx_migrations")
        != Some(expected_ledger)
    {
        return Err(invalid("Неизвестная структура legacy-базы"));
    }
    let rows: Vec<(i64, i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *connection)
            .await?;
    let versions: Vec<i64> = rows.iter().map(|row| row.0).collect();
    if !versions.is_empty() && versions != [1] && versions != [1, 2] {
        return Err(invalid("Неизвестная история legacy-миграций"));
    }
    for (version, success, checksum) in &rows {
        if *success != 1 {
            return Err(invalid("Незавершённая legacy-миграция"));
        }
        let allowed = if *version == 1 {
            [INITIAL_LF, INITIAL_CRLF]
                .iter()
                .any(|hash| checksum == &digest(hash))
        } else {
            [HISTORICAL_LF, HISTORICAL_CRLF, SANITIZED_LF]
                .iter()
                .any(|hash| checksum == &digest(hash))
        };
        if !allowed {
            return Err(invalid("Неизвестная контрольная сумма legacy-миграции"));
        }
    }
    if actual_schema != expected[rows.len()] {
        return Err(invalid(
            "Структура legacy-базы не соответствует её миграциям",
        ));
    }
    Ok(rows
        .into_iter()
        .map(|(version, _, checksum)| (version, checksum))
        .collect())
}

fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .pragma("trusted_schema", "OFF")
    // Never change journal mode of an existing legacy database.
}

async fn prepare(path: &Path) -> StoreResult<()> {
    pinned_migrations(INITIAL_SQL, CAPACITY_SQL)?;
    let expected = reference_schemas().await?;
    if path.try_exists()? {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(invalid("Ожидался обычный файл legacy-базы"));
        }
        let mut connection =
            SqliteConnection::connect_with(&options(path).create_if_missing(false).read_only(true))
                .await?;
        let checked = classify(&mut connection, &expected).await;
        let closed = connection.close().await;
        checked?;
        closed?;
    }
    let mut connection =
        SqliteConnection::connect_with(&options(path).create_if_missing(true)).await?;
    let result: StoreResult<()> = async {
        // SQLx's SQLite migration lock is a no-op. This real write reservation
        // serializes concurrent startup and pins the final validation snapshot.
        // begin_with also tracks nesting so Migrator uses SAVEPOINTs correctly.
        let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
        let migrated = async {
            let applied = classify(&mut transaction, &expected).await?;
            let mut migrations = pinned_migrations(INITIAL_SQL, CAPACITY_SQL)?;
            for (version, checksum) in applied {
                migrations[(version - 1) as usize].checksum = Cow::Owned(checksum);
            }
            migrate(&mut transaction, migrations).await
        }
        .await;
        match migrated {
            Ok(()) => {
                transaction.commit().await?;
                Ok(())
            }
            Err(error) => {
                transaction.rollback().await?;
                Err(error)
            }
        }
    }
    .await;
    // Physical close finishes before SQL-plugin preload may create its pool.
    let closed = connection.close().await;
    result?;
    closed?;
    Ok(())
}

fn block_on<F: Future>(future: F) -> F::Output {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        tokio::task::block_in_place(|| handle.block_on(future))
    } else {
        tauri::async_runtime::block_on(future)
    }
}

fn init_with_path<R, F>(resolve: F) -> TauriPlugin<R>
where
    R: Runtime,
    F: FnOnce(&AppHandle<R>) -> Result<PathBuf, SetupError> + Send + 'static,
{
    tauri::plugin::Builder::<R>::new("legacy-compat")
        .setup(move |app, _api| {
            let path = resolve(app)?;
            let directory = path.parent().ok_or("Отсутствует папка legacy-базы")?;
            std::fs::create_dir_all(directory)?;
            block_on(prepare(&path))?;
            Ok(())
        })
        .build()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Exactly the directory used by tauri-plugin-sql's SQLite path mapper.
    init_with_path(|app| Ok(app.path().app_config_dir()?.join("capacity.db")))
}

#[cfg(test)]
mod tests;
