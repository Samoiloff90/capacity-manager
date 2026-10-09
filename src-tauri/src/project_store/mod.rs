//! Project lifecycle only; quarter business reads/CAS writes belong to src/db.
//! Never call the plugin's auto-creating `load` for a selected project.
mod backup;
pub mod commands;
pub mod legacy_compat;
mod preflight;
mod schema;
mod sql_guard;

pub use schema::{
    APPLICATION_ID, DATABASE_NAME, LEGACY_SCHEMA_VERSION, PAYLOAD_VERSION, SCHEMA_VERSION,
};

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteSynchronous},
    Connection, SqlitePool,
};
use std::{
    collections::HashMap,
    fmt,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_plugin_sql::{DbInstances, DbPool};
use tokio::sync::Mutex;

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Sql(sqlx::Error),
    InvalidProject(String),
    Busy,
    ClosedSession,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "Ошибка доступа к проекту: {error}"),
            Self::Sql(error) => write!(f, "Ошибка хранилища проекта: {error}"),
            Self::InvalidProject(message) => f.write_str(message),
            Self::Busy => f.write_str("Проект уже открыт в другом окне или экземпляре приложения"),
            Self::ClosedSession => f.write_str("Сессия проекта уже закрыта"),
        }
    }
}
impl std::error::Error for StoreError {}
impl From<std::io::Error> for StoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<sqlx::Error> for StoreError {
    fn from(value: sqlx::Error) -> Self {
        Self::Sql(value)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSession {
    pub session_key: String,
    pub project_id: String,
    pub name: String,
    pub folder_path: String,
    pub schema_version: i64,
    pub sqlite_version: String,
}

/// Result of `project_upgrade_format`; no backup when the file already had format 2.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatUpgrade {
    pub schema_version: i64,
    pub backup_path: Option<String>,
}

struct ActiveSession {
    pool: SqlitePool,
    /// What the window may run on `pool` (Q-001); the store's own work is trusted.
    guard: &'static sql_guard::SqlGuard,
    ownership: Option<preflight::Ownership>,
    /// The project database; its folder receives the format-1 backup.
    path: PathBuf,
    project_id: String,
    /// Format of the file as opened: 1 until the first save upgrades it (DEC-044).
    schema_version: i64,
    /// The checked format-1 backup this session made. A retry after a failed upgrade reuses
    /// it, so failing upgrades cannot multiply copies of the project (Q-001).
    backup: Option<PathBuf>,
}

impl Drop for ActiveSession {
    fn drop(&mut self) {
        if let Some(ownership) = self.ownership.take() {
            // A forgotten store must not free the lock while the SQL plugin
            // still retains a working clone. The registry clone becomes closed.
            let _ = start_cleanup(self.pool.clone(), ownership);
        }
    }
}

async fn close_pool(pool: &SqlitePool) -> StoreResult<()> {
    match pool.acquire().await {
        Ok(connection) => {
            let connection = connection.detach();
            pool.close().await;
            connection.close().await?;
            Ok(())
        }
        Err(error) => {
            pool.close().await;
            if matches!(error, sqlx::Error::PoolClosed) {
                Ok(())
            } else {
                Err(error.into())
            }
        }
    }
}

/// Cleanup must survive request cancellation and destruction of the caller's
/// Tokio runtime. If thread/runtime setup or close fails, retain ownership until
/// process exit rather than allow a second writer against an unclosed handle.
fn start_cleanup(
    pool: SqlitePool,
    ownership: preflight::Ownership,
) -> StoreResult<tokio::sync::oneshot::Receiver<StoreResult<()>>> {
    let resources = std::sync::Arc::new(std::sync::Mutex::new(Some((pool, ownership))));
    let worker_resources = resources.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("capacity-close".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let pool = worker_resources.lock().unwrap().as_ref().unwrap().0.clone();
                runtime.block_on(close_pool(&pool))
            }));
            let result = outcome.unwrap_or_else(|_| {
                Err(StoreError::InvalidProject("Сбой закрытия проекта".into()))
            });
            if result.is_ok() {
                worker_resources.lock().unwrap().take();
            } else {
                std::mem::forget(worker_resources);
            }
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        std::mem::forget(resources);
        return Err(error.into());
    }
    Ok(receiver)
}

#[derive(Default)]
pub struct ProjectStore {
    sessions: Mutex<HashMap<String, ActiveSession>>,
    /// The folder the user has just chosen in the system dialog, and what for (Q-001).
    chosen: std::sync::Mutex<Option<(FolderPurpose, String)>>,
}

/// What a folder chosen in the system dialog is for: the window may then open or create
/// a project there once, and nowhere else (Q-001).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderPurpose {
    Open,
    Create,
}

impl FolderPurpose {
    pub fn dialog_title(self) -> &'static str {
        match self {
            FolderPurpose::Open => "Выберите папку проекта",
            FolderPurpose::Create => "Выберите пустую папку для команды",
        }
    }
}

pub(super) fn connection_options(path: &Path, read_only: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(read_only)
        .foreign_keys(true)
        .synchronous(SqliteSynchronous::Extra)
        .busy_timeout(Duration::from_secs(2))
        .pragma("trusted_schema", "OFF")
    // Do not set journal_mode here: even connecting must not silently
    // rewrite the header of a file awaiting validation/recovery.
}

/// `guard`: the pool is given to the SQL plugin, so every connection gets the window's
/// rules (Q-001). A staging pool that only the store uses has none.
async fn pool(path: &Path, guard: Option<&'static sql_guard::SqlGuard>) -> StoreResult<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(5))
        .after_connect(move |connection, _| {
            Box::pin(async move {
                let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
                    .fetch_one(&mut *connection)
                    .await?;
                let pages = preflight::MAX_PROJECT_BYTES / page_size as u64;
                sqlx::query(&format!("PRAGMA max_page_count={pages}"))
                    .execute(&mut *connection)
                    .await?;
                if let Some(guard) = guard {
                    guard.install(connection).await?;
                }
                Ok(())
            })
        })
        .connect_with(connection_options(path, false))
        .await?)
}

/// Do not cancel mutable SQLite connection setup midway through hot-journal
/// recovery or after_connect. A discarded receiver drops the completed session
/// through the same independent close worker used by explicit close and Drop.
fn start_open(
    path: PathBuf,
    ownership: preflight::Ownership,
) -> StoreResult<tokio::sync::oneshot::Receiver<StoreResult<ActiveSession>>> {
    let resources = std::sync::Arc::new(std::sync::Mutex::new(Some(ownership)));
    let worker_resources = resources.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let guard = sql_guard::SqlGuard::leaked();
    let spawned = std::thread::Builder::new()
        .name("capacity-open".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                runtime.block_on(pool(&path, Some(guard)))
            }));
            let result = match outcome {
                Ok(Ok(pool)) => Ok(ActiveSession {
                    pool,
                    guard,
                    ownership: worker_resources.lock().unwrap().take(),
                    path: path.clone(),
                    project_id: String::new(),
                    schema_version: SCHEMA_VERSION,
                    backup: None,
                }),
                Ok(Err(error)) => {
                    worker_resources.lock().unwrap().take();
                    Err(error)
                }
                Err(_) => {
                    std::mem::forget(worker_resources);
                    let _ = sender.send(Err(StoreError::InvalidProject(
                        "Сбой открытия проекта".into(),
                    )));
                    return;
                }
            };
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        std::mem::forget(resources);
        return Err(error.into());
    }
    Ok(receiver)
}

/// Our lock file and files the OS adds to folders it shows: Finder writes .DS_Store into a
/// folder that looks empty. They stay untouched; any other file means the folder is not empty.
fn ignorable_in_empty_folder(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    name == ".capacity.lock"
        || [".DS_Store", ".localized", "desktop.ini", "Thumbs.db"]
            .iter()
            .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

/// Create a complete closed database before publishing it. Publication uses a
/// same-filesystem hard link (no overwrite); failures remove only our UUID stage.
async fn prepare_create(
    directory: PathBuf,
    id: String,
    name: String,
    fail_initialization: bool,
    guard: &'static sql_guard::SqlGuard,
) -> StoreResult<SqlitePool> {
    let stage = preflight::ScratchDirectory::new_in(&directory)?;
    let staged_path = stage.path().join(DATABASE_NAME);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged_path)?
        .sync_all()?;
    // Only the store uses the staging pool: it creates the schema, nothing else runs there.
    let staged_pool = pool(&staged_path, None).await?;
    let initialized = if fail_initialization {
        Err(StoreError::InvalidProject(
            "Имитированная ошибка создания".into(),
        ))
    } else {
        schema::initialize(&staged_pool, &id, &name).await
    };
    close_pool(&staged_pool).await?;
    initialized?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&staged_path)?
        .sync_all()?;
    let path = directory.join(DATABASE_NAME);
    fs::hard_link(&staged_path, &path)?;
    drop(stage);
    pool(&path, Some(guard)).await
}

impl ProjectStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// The folder the user chose in the system dialog; it replaces an earlier choice.
    pub fn remember_choice(&self, purpose: FolderPurpose, folder: &str) {
        *self.chosen.lock().unwrap() = Some((purpose, folder.to_owned()));
    }

    pub fn forget_choice(&self) {
        self.chosen.lock().unwrap().take();
    }

    /// Takes the choice once: true only for the same folder and purpose.
    pub fn take_choice(&self, purpose: FolderPurpose, folder: &str) -> bool {
        self.chosen
            .lock()
            .unwrap()
            .take()
            .is_some_and(|(chosen_for, chosen)| chosen_for == purpose && chosen == folder)
    }

    /// Explicit creation requires an empty existing directory. We never reuse or
    /// overwrite another file, or auto-upgrade the old prototype's database.
    pub async fn create(
        &self,
        instances: &DbInstances,
        folder_path: PathBuf,
        name: String,
    ) -> StoreResult<ProjectSession> {
        self.create_inner(instances, folder_path, name, false).await
    }

    async fn create_inner(
        &self,
        instances: &DbInstances,
        folder_path: PathBuf,
        name: String,
        fail_initialization: bool,
    ) -> StoreResult<ProjectSession> {
        if name.trim().is_empty() {
            return Err(StoreError::InvalidProject(
                "Укажите название проекта".into(),
            ));
        }
        let directory = preflight::folder(&folder_path)?;
        if fs::read_dir(&directory)?.any(|entry| {
            entry
                .map(|e| !ignorable_in_empty_folder(&e.file_name()))
                .unwrap_or(true)
        }) {
            return Err(StoreError::InvalidProject(
                "Для нового проекта выберите пустую папку".into(),
            ));
        }
        let ownership = preflight::Ownership::acquire(&directory)?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = name.trim().to_owned();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let resources = std::sync::Arc::new(std::sync::Mutex::new(Some(ownership)));
        let worker_resources = resources.clone();
        let worker_directory = directory.clone();
        let worker_id = id.clone();
        let worker_name = name.clone();
        let worker_path = directory.join(DATABASE_NAME);
        let worker_project_id = id.clone();
        let guard = sql_guard::SqlGuard::leaked();
        // A cancelled caller may receive no session, but leaves either no DB or
        // a complete valid project. The worker always closes its staging DB.
        let spawned = std::thread::Builder::new()
            .name("capacity-create".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    runtime.block_on(prepare_create(
                        worker_directory,
                        worker_id,
                        worker_name,
                        fail_initialization,
                        guard,
                    ))
                }));
                let result = match outcome {
                    Ok(Ok(pool)) => Ok(ActiveSession {
                        pool,
                        guard,
                        ownership: worker_resources.lock().unwrap().take(),
                        path: worker_path,
                        project_id: worker_project_id,
                        schema_version: SCHEMA_VERSION,
                        backup: None,
                    }),
                    Ok(Err(error)) => {
                        // Release before notifying the caller, so immediate retry
                        // cannot race the worker's final stack destruction.
                        worker_resources.lock().unwrap().take();
                        Err(error)
                    }
                    Err(_) => {
                        std::mem::forget(worker_resources);
                        let _ = sender.send(Err(StoreError::InvalidProject(
                            "Сбой создания проекта".into(),
                        )));
                        return;
                    }
                };
                let _ = sender.send(result);
            });
        if let Err(error) = spawned {
            std::mem::forget(resources);
            return Err(error.into());
        }
        drop(resources);
        let active = receiver
            .await
            .map_err(|_| StoreError::InvalidProject("Не удалось создать проект".into()))??;
        self.register(instances, directory, active, id, name).await
    }

    pub async fn open(
        &self,
        instances: &DbInstances,
        folder_path: PathBuf,
    ) -> StoreResult<ProjectSession> {
        let directory = preflight::folder(&folder_path)?;
        let path = directory.join(DATABASE_NAME);
        if matches!(fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Err(StoreError::InvalidProject(format!(
                "В этой папке нет проекта Capacity Planner (файла {DATABASE_NAME}). Выберите папку проекта или создайте новый проект"
            )));
        }
        // A pre-existing lock can be acquired without creating/changing files.
        // This prevents immutable reads racing an active cooperating writer.
        let existing_ownership = preflight::Ownership::acquire_existing(&directory)?;
        let before = preflight::inspect(&path).await?;
        // Only an identified, validated project may get a lock file.
        let ownership = match existing_ownership {
            Some(ownership) => ownership,
            None => preflight::Ownership::acquire(&directory)?,
        };
        let after = preflight::inspect(&path).await?;
        if before.id != after.id {
            return Err(StoreError::InvalidProject(
                "Проект изменился во время открытия".into(),
            ));
        }
        let mut active = start_open(path, ownership)?
            .await
            .map_err(|_| StoreError::InvalidProject("Не удалось открыть проект".into()))??;
        // SQLite may now recover the owned hot journal; repeat full validation
        // before making the pool reachable through the plugin registry.
        let checked = {
            let mut trusted = active.guard.trust(active.pool.acquire().await?);
            let checked = schema::validate(trusted.connection()).await;
            trusted.finish().await?;
            checked
        };
        let metadata = match checked {
            Ok(metadata)
                if metadata.id == before.id && metadata.schema_version == before.schema_version =>
            {
                metadata
            }
            Ok(_) => {
                return Err(StoreError::InvalidProject(
                    "Проект заменён при открытии".into(),
                ));
            }
            Err(error) => {
                return Err(error);
            }
        };
        active.project_id = metadata.id.clone();
        active.schema_version = metadata.schema_version;
        self.register(instances, directory, active, metadata.id, metadata.name)
            .await
    }

    /// Format 1 → 2 for an open session (DEC-044): checked backup first, then one
    /// transaction. On any error the project file is as it was opened.
    pub async fn upgrade_format(&self, session_key: &str) -> StoreResult<FormatUpgrade> {
        self.upgrade_format_inner(session_key, schema::UpgradeFault::None)
            .await
    }

    async fn upgrade_format_inner(
        &self,
        session_key: &str,
        fault: schema::UpgradeFault,
    ) -> StoreResult<FormatUpgrade> {
        // Holding the registry of sessions keeps close() waiting until the upgrade ends.
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(session_key)
            .ok_or(StoreError::ClosedSession)?;
        if session.schema_version == SCHEMA_VERSION {
            return Ok(FormatUpgrade {
                schema_version: SCHEMA_VERSION,
                backup_path: None,
            });
        }
        // The pool has one connection: no other SQL of this project runs meanwhile,
        // so the file is idle and consistent while it is copied. The store's own
        // statements run trusted; the window's rules come back with `finish` (Q-001).
        let mut trusted = session.guard.trust(session.pool.acquire().await?);
        let upgraded = Self::upgrade_on(session, trusted.connection(), fault).await;
        // A failed clear closes the connection, so the window's rules hold either way. The
        // caller needs the upgrade's own result: a committed upgrade with its backup.
        let _ = trusted.finish().await;
        upgraded
    }

    async fn upgrade_on(
        session: &mut ActiveSession,
        connection: &mut sqlx::SqliteConnection,
        fault: schema::UpgradeFault,
    ) -> StoreResult<FormatUpgrade> {
        let current = schema::validate(&mut *connection).await?;
        if current.id != session.project_id || current.schema_version != LEGACY_SCHEMA_VERSION {
            return Err(StoreError::InvalidProject(
                "Проект изменился до обновления формата".into(),
            ));
        }
        let made = async {
            // One backup per session (Q-001): a retry reuses the checked copy while the file
            // is the same. A file changed since then gets a new copy only after reopening,
            // which needs the user's choice of the folder.
            if let Some(path) = session.backup.as_ref().filter(|path| path.is_file()) {
                return if backup::same_bytes(&session.path, path)? {
                    Ok(path.clone())
                } else {
                    Err(StoreError::InvalidProject(
                        "проект изменился после прошлой попытки обновления; закройте его и откройте снова".into(),
                    ))
                };
            }
            let path = backup::create(&session.path, fault.fails_backup())?;
            if let Err(error) = backup::verify(&path, &session.project_id).await {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            session.backup = Some(path.clone());
            Ok(path)
        }
        .await
        .map_err(|error| {
            StoreError::InvalidProject(format!(
                "Не удалось создать резервную копию проекта: {error}. Исходный файл не изменён."
            ))
        })?;
        let shown = backup::shown(&made);
        schema::upgrade_from_v1(&mut *connection, fault)
            .await
            .map_err(|error| {
                StoreError::InvalidProject(format!(
                    "Не удалось обновить формат проекта: {error}. Исходный файл не изменён, резервная копия: {shown}."
                ))
            })?;
        // Committed: the session follows the file even if the check below fails, so a
        // retry does not try to upgrade a file that is already format 2.
        session.schema_version = SCHEMA_VERSION;
        let checked = schema::validate(&mut *connection).await;
        if !matches!(&checked, Ok(upgraded) if upgraded.id == session.project_id && upgraded.schema_version == SCHEMA_VERSION)
        {
            let reason = checked
                .err()
                .map(|error| format!(": {error}"))
                .unwrap_or_default();
            return Err(StoreError::InvalidProject(format!(
                "Формат проекта обновлён, но проверка после обновления не прошла{reason}. Резервная копия: {shown}."
            )));
        }
        Ok(FormatUpgrade {
            schema_version: SCHEMA_VERSION,
            backup_path: Some(shown),
        })
    }

    async fn register(
        &self,
        instances: &DbInstances,
        directory: PathBuf,
        active: ActiveSession,
        project_id: String,
        name: String,
    ) -> StoreResult<ProjectSession> {
        let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&active.pool)
            .await?;
        let session_key = format!("project:{}", uuid::Uuid::new_v4());
        let session = ProjectSession {
            session_key: session_key.clone(),
            project_id,
            name,
            folder_path: directory.to_string_lossy().into_owned(),
            schema_version: active.schema_version,
            sqlite_version,
        };
        // Consistent lock order with close(); plugin handlers hold only registry.
        let mut sessions = self.sessions.lock().await;
        let mut registry = instances.0.write().await;
        registry.insert(session_key.clone(), DbPool::Sqlite(active.pool.clone()));
        sessions.insert(session_key, active);
        Ok(session)
    }

    pub async fn close(&self, instances: &DbInstances, session_key: &str) -> StoreResult<()> {
        let mut sessions = self.sessions.lock().await;
        // Acquiring the write lock drains in-flight plugin commands. Removing the
        // key rejects every subsequent command, including stale handles.
        let mut registry = instances.0.write().await;
        let mut session = sessions
            .remove(session_key)
            .ok_or(StoreError::ClosedSession)?;
        registry.remove(session_key);
        drop(registry);
        drop(sessions);
        let closing = start_cleanup(session.pool.clone(), session.ownership.take().unwrap())?;
        closing.await.map_err(|_| {
            StoreError::InvalidProject("Не удалось завершить закрытие проекта".into())
        })?
    }
}

#[cfg(test)]
mod tests;
