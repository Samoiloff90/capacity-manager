//! Backup of a format-1 project before its format upgrade (DEC-044): a byte copy of
//! `capacity.sqlite` in the project folder, checked before the original is changed.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use sqlx::{Connection, SqliteConnection};

use super::{connection_options, schema, StoreError, StoreResult};

/// Gregorian date of a day count since 1970-01-01 (H. Hinnant's civil_from_days).
pub(super) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe as i64 + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `capacity-backup-format1-2026-10-06.sqlite`, then `…-2.sqlite` and so on (UTC date).
pub(super) fn file_name((year, month, day): (i64, u32, u32), attempt: u32) -> String {
    let suffix = if attempt == 0 {
        String::new()
    } else {
        format!("-{}", attempt + 1)
    };
    format!("capacity-backup-format1-{year:04}-{month:02}-{day:02}{suffix}.sqlite")
}

/// The path as the user sees it in Explorer: without the `\\?\` prefix of a canonical Windows path.
pub(super) fn shown(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

fn today() -> (i64, u32, u32) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    civil_from_days(seconds.div_euclid(86_400))
}

pub(super) fn same_bytes(left: &Path, right: &Path) -> StoreResult<bool> {
    let (mut a, mut b) = (File::open(left)?, File::open(right)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut x, mut y) = (vec![0_u8; 64 * 1024], vec![0_u8; 64 * 1024]);
    loop {
        let read = a.read(&mut x)?;
        if read == 0 {
            return Ok(true);
        }
        b.read_exact(&mut y[..read])?;
        if x[..read] != y[..read] {
            return Ok(false);
        }
    }
}

/// Gives the checked copy its backup name without replacing any existing file.
fn publish(partial: &Path, path: &Path) -> io::Result<()> {
    match fs::hard_link(partial, path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(error),
        // A volume without hard links: the folder is owned by this process (.capacity.lock).
        Err(_) if !path.try_exists()? => fs::rename(partial, path),
        Err(_) => Err(io::ErrorKind::AlreadyExists.into()),
    }
}

/// Copies the idle database into the project folder: under a temporary name first, written
/// to disk and compared byte by byte, then published under a new backup name, never over an
/// existing file. An interrupted copy therefore never looks like a backup.
///
/// Reading the file through extra handles is safe on macOS too, where closing any handle
/// drops this process's POSIX locks on the file: the idle connection holds no lock, and
/// `.capacity.lock` keeps other instances out.
pub(super) fn create(database: &Path, fail: bool) -> StoreResult<PathBuf> {
    let directory = database
        .parent()
        .ok_or_else(|| StoreError::InvalidProject("Не найдена папка проекта".into()))?;
    let partial = directory.join(format!(".capacity-backup-{}.partial", uuid::Uuid::new_v4()));
    let written = (|| -> StoreResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)?;
        if fail {
            return Err(StoreError::InvalidProject(
                "Имитированная ошибка записи копии".into(),
            ));
        }
        io::copy(&mut File::open(database)?, &mut file)?;
        file.sync_all()?;
        drop(file);
        if same_bytes(database, &partial)? {
            Ok(())
        } else {
            Err(StoreError::InvalidProject(
                "Копия не совпадает с исходным файлом".into(),
            ))
        }
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    let date = today();
    let mut published = Err(StoreError::InvalidProject(
        "Не удалось подобрать имя для резервной копии".into(),
    ));
    for attempt in 0..1000 {
        let path = directory.join(file_name(date, attempt));
        match publish(&partial, &path) {
            Ok(()) => {
                published = Ok(path);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                published = Err(error.into());
                break;
            }
        }
    }
    let _ = fs::remove_file(&partial);
    published
}

/// The copy must open, read-only, as the same project in format 1.
pub(super) async fn verify(path: &Path, project_id: &str) -> StoreResult<()> {
    let options = connection_options(path, true).immutable(true);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    let checked = schema::validate(&mut connection).await;
    connection.close().await?;
    let metadata = checked?;
    if metadata.id != project_id || metadata.schema_version != schema::LEGACY_SCHEMA_VERSION {
        return Err(StoreError::InvalidProject(
            "Копия не открывается как исходный проект".into(),
        ));
    }
    Ok(())
}
