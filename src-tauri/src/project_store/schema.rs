#[cfg(test)]
use sqlx::Connection;
use sqlx::{Row, SqliteConnection, SqlitePool};

use super::{StoreError, StoreResult};

pub const DATABASE_NAME: &str = "capacity.sqlite";
/// Format 2 (quarter planner): quarter rows hold JSON of format 1 or 2.
pub const SCHEMA_VERSION: i64 = 2;
/// Format 1 (0.1.0–0.3.0): opened as is and upgraded only on the first save (DEC-044).
pub const LEGACY_SCHEMA_VERSION: i64 = 1;
/// Version of the quarter JSON this version writes; format-1 rows stay until saved.
pub const PAYLOAD_VERSION: i64 = 2;
pub const APPLICATION_ID: i64 = 0x43504c4e;

pub const META_SCHEMA: &str = "CREATE TABLE project_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    format_version INTEGER NOT NULL CHECK (format_version = 1)
)";

/// Exactly as 0.1.0–0.3.0 created it; such a file is never rewritten in place except by the upgrade.
pub const QUARTER_SCHEMA_V1: &str = "CREATE TABLE quarter_plans (
    plan_id TEXT PRIMARY KEY NOT NULL,
    year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 9999),
    quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload_version INTEGER NOT NULL CHECK (payload_version = 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (year, quarter)
)";

pub const QUARTER_SCHEMA: &str = "CREATE TABLE quarter_plans (
    plan_id TEXT PRIMARY KEY NOT NULL,
    year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 9999),
    quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload_version INTEGER NOT NULL CHECK (payload_version IN (1, 2)),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (year, quarter)
)";

/// Table definition and stored JSON versions accepted for each file format.
fn format(version: i64) -> Option<(&'static str, &'static [i64])> {
    match version {
        LEGACY_SCHEMA_VERSION => Some((QUARTER_SCHEMA_V1, &[1])),
        SCHEMA_VERSION => Some((QUARTER_SCHEMA, &[1, 2])),
        _ => None,
    }
}

pub(super) async fn initialize(pool: &SqlitePool, id: &str, name: &str) -> StoreResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(META_SCHEMA).execute(&mut *tx).await?;
    sqlx::query(QUARTER_SCHEMA).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO project_meta (singleton, project_id, name, format_version) VALUES (1, ?, ?, 1)")
        .bind(id).bind(name).execute(&mut *tx).await?;
    sqlx::query(&format!("PRAGMA application_id = {APPLICATION_ID}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Debug)]
pub(super) struct Metadata {
    pub id: String,
    pub name: String,
    pub schema_version: i64,
}

fn normalized(sql: &str) -> String {
    sql.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Only the precise owned schema is writable. In particular, never let a file
/// supply triggers/views/extra indexes that would run during our static writes.
pub(super) async fn validate(connection: &mut SqliteConnection) -> StoreResult<Metadata> {
    let application_id: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&mut *connection)
        .await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await?;
    let Some((quarter_schema, payload_versions)) = format(version)
        .filter(|_| application_id == APPLICATION_ID)
    else {
        return Err(StoreError::InvalidProject(
            "Неподдерживаемый формат проекта".into(),
        ));
    };
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await?;
    if mode != "delete" {
        return Err(StoreError::InvalidProject(
            "Поддерживается только журнал DELETE".into(),
        ));
    }
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(&mut *connection)
        .await?;
    if integrity != ["ok"] {
        return Err(StoreError::InvalidProject(
            "Нарушена целостность проекта".into(),
        ));
    }
    let objects = sqlx::query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
        .fetch_all(&mut *connection)
        .await?;
    if objects.len() != 4 {
        return Err(StoreError::InvalidProject(
            "Неожиданная структура проекта".into(),
        ));
    }
    for object in objects {
        let kind: String = object.try_get("type")?;
        let name: String = object.try_get("name")?;
        let table: String = object.try_get("tbl_name")?;
        let sql: Option<String> = object.try_get("sql")?;
        let valid = match name.as_str() {
            "project_meta" => {
                kind == "table"
                    && table == name
                    && sql.as_deref().map(normalized) == Some(normalized(META_SCHEMA))
            }
            "quarter_plans" => {
                kind == "table"
                    && table == name
                    && sql.as_deref().map(normalized) == Some(normalized(quarter_schema))
            }
            "sqlite_autoindex_quarter_plans_1" | "sqlite_autoindex_quarter_plans_2" => {
                kind == "index" && table == "quarter_plans" && sql.is_none()
            }
            _ => false,
        };
        if !valid {
            return Err(StoreError::InvalidProject(
                "Неожиданная структура проекта".into(),
            ));
        }
    }
    let metadata =
        sqlx::query("SELECT singleton, project_id, name, format_version FROM project_meta")
            .fetch_all(&mut *connection)
            .await?;
    if metadata.len() != 1 {
        return Err(StoreError::InvalidProject(
            "Отсутствуют сведения о проекте".into(),
        ));
    }
    let row = &metadata[0];
    let id: String = row.try_get("project_id")?;
    let name: String = row.try_get("name")?;
    if row.try_get::<i64, _>("singleton")? != 1
        || row.try_get::<i64, _>("format_version")? != 1
        || uuid::Uuid::parse_str(&id).is_err()
        || name.trim().is_empty()
    {
        return Err(StoreError::InvalidProject(
            "Некорректные сведения о проекте".into(),
        ));
    }
    let quarters = sqlx::query(
        "SELECT year, quarter, revision, payload_version, payload_json FROM quarter_plans",
    )
    .fetch_all(&mut *connection)
    .await?;
    for row in quarters {
        let year: i64 = row.try_get("year")?;
        let quarter: i64 = row.try_get("quarter")?;
        let payload: String = row.try_get("payload_json")?;
        let json: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|_| StoreError::InvalidProject("Повреждён снимок квартала".into()))?;
        if !payload_versions.contains(&row.try_get::<i64, _>("payload_version")?)
            || row.try_get::<i64, _>("revision")? < 1
            || !(1..=9999).contains(&year)
            || !(1..=4).contains(&quarter)
            || json.get("year").and_then(|x| x.as_i64()) != Some(year)
            || json.get("quarter").and_then(|x| x.as_i64()) != Some(quarter)
        {
            return Err(StoreError::InvalidProject(
                "Неподдерживаемый снимок квартала".into(),
            ));
        }
    }
    Ok(Metadata {
        id,
        name,
        schema_version: version,
    })
}

/// Test-only failure points of the format upgrade; production always passes `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UpgradeFault {
    None,
    #[cfg(test)]
    Backup,
    #[cfg(test)]
    Migration,
    /// The process dies inside the transaction, leaving a genuine hot journal.
    #[cfg(test)]
    Exit,
}

impl UpgradeFault {
    pub(super) fn fails_backup(self) -> bool {
        #[cfg(test)]
        if self == Self::Backup {
            return true;
        }
        false
    }
}

/// Format 1 → 2 in one transaction on the session's only connection: the quarter table
/// gets the new version check, every row moves unchanged, then the file version. SQLite
/// rolls back an error or an interruption, so the file stays a valid format-1 project.
pub(super) async fn upgrade_from_v1(
    connection: &mut SqliteConnection,
    fault: UpgradeFault,
) -> StoreResult<()> {
    #[cfg(test)]
    if fault == UpgradeFault::Exit {
        // Make SQLite write pages before commit, as a large real upgrade would.
        sqlx::query("PRAGMA cache_size=1").execute(&mut *connection).await?;
        sqlx::query("PRAGMA cache_spill=ON").execute(&mut *connection).await?;
    }
    let mut tx = sqlx::Connection::begin(&mut *connection).await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *tx)
        .await?;
    if version != LEGACY_SCHEMA_VERSION {
        return Err(StoreError::InvalidProject(
            "Формат проекта изменился во время обновления".into(),
        ));
    }
    for statement in [
        "ALTER TABLE quarter_plans RENAME TO quarter_plans_format1",
        QUARTER_SCHEMA,
        "INSERT INTO quarter_plans (plan_id, year, quarter, revision, payload_version, payload_json) \
         SELECT plan_id, year, quarter, revision, payload_version, payload_json FROM quarter_plans_format1",
        "DROP TABLE quarter_plans_format1",
    ] {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    match fault {
        UpgradeFault::None => {}
        #[cfg(test)]
        UpgradeFault::Backup => {}
        #[cfg(test)]
        UpgradeFault::Migration => {
            sqlx::query("INSERT INTO missing_table VALUES (1)")
                .execute(&mut *tx)
                .await?;
        }
        #[cfg(test)]
        UpgradeFault::Exit => std::process::exit(24),
    }
    sqlx::query(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// A file as 0.1.0–0.3.0 created it, for compatibility tests only.
#[cfg(test)]
pub(super) async fn initialize_format1(pool: &SqlitePool, id: &str, name: &str) -> StoreResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(META_SCHEMA).execute(&mut *tx).await?;
    sqlx::query(QUARTER_SCHEMA_V1).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO project_meta (singleton, project_id, name, format_version) VALUES (1, ?, ?, 1)")
        .bind(id).bind(name).execute(&mut *tx).await?;
    sqlx::query(&format!("PRAGMA application_id = {APPLICATION_ID}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!("PRAGMA user_version = {LEGACY_SCHEMA_VERSION}"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Trusted schema changes only: one connection and one transaction for all SQL
/// plus its version. Not exposed to IPC, and no upgrade from the old prototype.
#[cfg(test)]
pub(super) async fn migration_fixture(
    connection: &mut SqliteConnection,
    statements: &[&str],
    version: i64,
) -> StoreResult<()> {
    let mut tx = connection.begin().await?;
    for statement in statements {
        if let Err(error) = sqlx::raw_sql(statement).execute(&mut *tx).await {
            tx.rollback().await?;
            return Err(error.into());
        }
    }
    sqlx::query(&format!("PRAGMA user_version = {version}"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
