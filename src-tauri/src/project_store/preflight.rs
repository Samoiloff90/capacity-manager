use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

use sqlx::{Connection, SqliteConnection};

use super::{connection_options, schema, StoreError, StoreResult};

pub(super) const MAX_PROJECT_BYTES: u64 = 128 * 1024 * 1024;

pub(super) fn folder(path: &Path) -> StoreResult<PathBuf> {
    let path = fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(StoreError::InvalidProject("Выберите папку проекта".into()));
    }
    #[cfg(windows)]
    if matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::UNC(..) | std::path::Prefix::VerbatimUNC(..)))
    {
        return Err(StoreError::InvalidProject(
            "Сетевая папка не поддерживается".into(),
        ));
    }
    Ok(path)
}

fn regular_file(path: &Path) -> StoreResult<fs::Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(StoreError::InvalidProject(
            "Ожидался обычный файл проекта".into(),
        ));
    }
    Ok(meta)
}

/// The first check does not open SQLite or create a lock file. Never use a SQLite
/// URL supplied by the caller; '?' and '%' are valid native filename characters.
pub(super) fn header(path: &Path) -> StoreResult<()> {
    let metadata = regular_file(path)?;
    if metadata.len() < 100 || metadata.len() > MAX_PROJECT_BYTES {
        return Err(StoreError::InvalidProject(
            "Некорректный размер файла проекта".into(),
        ));
    }
    let mut bytes = [0_u8; 100];
    File::open(path)?.read_exact(&mut bytes)?;
    let id = u32::from_be_bytes(bytes[68..72].try_into().unwrap()) as i64;
    let version = u32::from_be_bytes(bytes[60..64].try_into().unwrap()) as i64;
    if &bytes[..16] != b"SQLite format 3\0" || id != schema::APPLICATION_ID {
        return Err(StoreError::InvalidProject(
            "Файл не является проектом Capacity Manager".into(),
        ));
    }
    if version != schema::SCHEMA_VERSION {
        return Err(StoreError::InvalidProject(
            "Версия проекта не поддерживается".into(),
        ));
    }
    // Refuse WAL before any mutable connection; do not convert arbitrary files.
    if bytes[18] != 1
        || bytes[19] != 1
        || sidecar(path, "-wal").exists()
        || sidecar(path, "-shm").exists()
    {
        return Err(StoreError::InvalidProject(
            "Проект с журналом WAL не поддерживается".into(),
        ));
    }
    Ok(())
}

pub(super) fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

/// A private scratch copy allows SQLite to recover an owned rollback journal
/// without touching the selected folder until its recovered schema is validated.
pub(super) async fn inspect(path: &Path) -> StoreResult<schema::Metadata> {
    header(path)?;
    let journal = sidecar(path, "-journal");
    if journal.try_exists()? && regular_file(&journal)?.len() > 0 {
        let scratch = ScratchDirectory::new()?;
        let copied = scratch.path().join(schema::DATABASE_NAME);
        fs::copy(path, &copied)?;
        fs::copy(&journal, sidecar(&copied, "-journal"))?;
        let mut connection =
            SqliteConnection::connect_with(&connection_options(&copied, false)).await?;
        // Any hot-journal recovery and changes happen in the disposable copy.
        let result = schema::validate(&mut connection).await;
        connection.close().await?;
        result
    } else {
        let options = connection_options(path, true).immutable(true);
        let mut connection = SqliteConnection::connect_with(&options).await?;
        let result = schema::validate(&mut connection).await;
        connection.close().await?;
        result
    }
}

pub(super) struct Ownership(File);

impl Ownership {
    pub fn acquire_existing(directory: &Path) -> StoreResult<Option<Self>> {
        let path = directory.join(".capacity.lock");
        if !path.try_exists()? {
            return Ok(None);
        }
        regular_file(&path)?;
        let file = OpenOptions::new().read(true).write(true).open(path)?;
        Self::lock(file).map(Some)
    }

    pub fn acquire(directory: &Path) -> StoreResult<Self> {
        let path = directory.join(".capacity.lock");
        if path.try_exists()? {
            regular_file(&path)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        Self::lock(file)
    }

    fn lock(file: File) -> StoreResult<Self> {
        match file.try_lock() {
            Ok(()) => Ok(Self(file)),
            Err(std::fs::TryLockError::WouldBlock) => Err(StoreError::Busy),
            Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}

impl Drop for Ownership {
    fn drop(&mut self) {
        let _ = self.0.unlock();
        // Keep the zero-byte inode: unlinking it creates races between waiters.
    }
}

/// Only directories created by this object can be recursively removed.
pub(super) struct ScratchDirectory {
    root: PathBuf,
    path: PathBuf,
}

impl ScratchDirectory {
    pub fn new() -> StoreResult<Self> {
        let root = fs::canonicalize(std::env::temp_dir())?;
        Self::new_in(&root)
    }
    pub fn new_in(root: &Path) -> StoreResult<Self> {
        let root = fs::canonicalize(root)?;
        let path = root.join(format!("capacity-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self { root, path })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        if self.path.parent() == Some(self.root.as_path())
            && self
                .path
                .file_name()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.starts_with("capacity-storage-"))
        {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
