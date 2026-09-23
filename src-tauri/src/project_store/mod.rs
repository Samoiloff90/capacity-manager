//! Project lifecycle only; quarter business reads/CAS writes belong to src/db.
//! Never call the plugin's auto-creating `load` for a selected project.
pub mod legacy_compat;
mod preflight;
mod schema;

pub use schema::{APPLICATION_ID, DATABASE_NAME, PAYLOAD_VERSION, SCHEMA_VERSION};

use serde::Serialize;
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

struct ActiveSession {
    pool: SqlitePool,
    ownership: Option<preflight::Ownership>,
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

async fn pool(path: &Path) -> StoreResult<SqlitePool> {
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(5))
        .after_connect(|connection, _| {
            Box::pin(async move {
                let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
                    .fetch_one(&mut *connection)
                    .await?;
                let pages = preflight::MAX_PROJECT_BYTES / page_size as u64;
                sqlx::query(&format!("PRAGMA max_page_count={pages}"))
                    .execute(&mut *connection)
                    .await?;
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
    let spawned = std::thread::Builder::new()
        .name("capacity-open".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                runtime.block_on(pool(&path))
            }));
            let result = match outcome {
                Ok(Ok(pool)) => Ok(ActiveSession {
                    pool,
                    ownership: worker_resources.lock().unwrap().take(),
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

/// Create a complete closed database before publishing it. Publication uses a
/// same-filesystem hard link (no overwrite); failures remove only our UUID stage.
async fn prepare_create(
    directory: PathBuf,
    id: String,
    name: String,
    fail_initialization: bool,
) -> StoreResult<SqlitePool> {
    let stage = preflight::ScratchDirectory::new_in(&directory)?;
    let staged_path = stage.path().join(DATABASE_NAME);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged_path)?
        .sync_all()?;
    let staged_pool = pool(&staged_path).await?;
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
    pool(&path).await
}

impl ProjectStore {
    pub fn new() -> Self {
        Self::default()
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
                .map(|e| e.file_name() != ".capacity.lock")
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
                    ))
                }));
                let result = match outcome {
                    Ok(Ok(pool)) => Ok(ActiveSession {
                        pool,
                        ownership: worker_resources.lock().unwrap().take(),
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
        let active = start_open(path, ownership)?
            .await
            .map_err(|_| StoreError::InvalidProject("Не удалось открыть проект".into()))??;
        // SQLite may now recover the owned hot journal; repeat full validation
        // before making the pool reachable through the plugin registry.
        let checked = {
            let mut connection = active.pool.acquire().await?;
            schema::validate(&mut connection).await
        };
        let metadata = match checked {
            Ok(metadata) if metadata.id == before.id => metadata,
            Ok(_) => {
                return Err(StoreError::InvalidProject(
                    "Проект заменён при открытии".into(),
                ));
            }
            Err(error) => {
                return Err(error);
            }
        };
        self.register(instances, directory, active, metadata.id, metadata.name)
            .await
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
            schema_version: SCHEMA_VERSION,
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
