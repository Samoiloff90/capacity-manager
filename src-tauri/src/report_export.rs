//! Narrow native command for saving a report workbook.
//!
//! The frontend builds the XLSX workbook itself. This module only validates the
//! request, shows the native "Save as" dialog and writes the given bytes
//! atomically to the path the user chose. It contains no business logic, and the
//! WebView never receives `fs:*` or `dialog:allow-save` permissions.
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{Runtime, State, Webview};
use tauri_plugin_dialog::DialogExt;

/// Upper bound for one exported workbook received over IPC.
pub const MAX_REPORT_BYTES: usize = 2 * 1024 * 1024;

const MAX_NAME_UTF16_UNITS: usize = 200;
const ZIP_SIGNATURE: &[u8] = b"PK\x03\x04";
const FORBIDDEN_NAME_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const TEMP_PREFIX: &str = ".capacity-export-";
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(100);

const EMPTY_OR_TOO_LARGE: &str = "Отчёт пустой или слишком большой для выгрузки.";
const CORRUPTED: &str = "Файл отчёта повреждён.";
const INVALID_NAME: &str = "Недопустимое имя файла отчёта.";
const BUSY: &str = "Выгрузка отчёта уже выполняется.";
const NOT_XLSX: &str = "Сохраните отчёт с расширением .xlsx.";
const DIRECTORY: &str = "Выберите файл, а не папку.";
const UNKNOWN_PATH: &str = "Не удалось определить путь для сохранения.";
const DIALOG_UNAVAILABLE: &str = "Окно сохранения недоступно.";
const LOCKED: &str = "Не удалось сохранить отчёт: файл открыт в другой программе, например в Excel. Закройте его и повторите.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ReportSaveOutcome {
    Saved { path: String },
    Cancelled,
}

/// Rejects oversized, non-ZIP payloads and default names Windows cannot store.
pub fn validate_request(default_name: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_REPORT_BYTES {
        return Err(EMPTY_OR_TOO_LARGE.into());
    }
    if !bytes.starts_with(ZIP_SIGNATURE) {
        return Err(CORRUPTED.into());
    }
    if !valid_file_name(default_name) {
        return Err(INVALID_NAME.into());
    }
    Ok(())
}

fn valid_file_name(name: &str) -> bool {
    (1..=MAX_NAME_UTF16_UNITS).contains(&name.encode_utf16().count())
        && !name.trim().is_empty()
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || FORBIDDEN_NAME_CHARS.contains(&c))
}

/// One export at a time: a second request must not open a second dialog.
#[derive(Debug, Default)]
pub struct ReportExportGuard(AtomicBool);

impl ReportExportGuard {
    fn acquire(&self) -> Result<ExportToken<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ExportToken(&self.0))
            .map_err(|_| BUSY.to_string())
    }
}

struct ExportToken<'a>(&'a AtomicBool);

impl Drop for ExportToken<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Holds the guard for the whole dialog and write; `pick` returns `None` on cancel.
pub async fn save_report<F, Fut>(
    guard: &ReportExportGuard,
    default_name: &str,
    bytes: &[u8],
    pick: F,
) -> Result<ReportSaveOutcome, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<Option<PathBuf>, String>>,
{
    let _token = guard.acquire()?;
    let Some(path) = pick(format!("{default_name}.xlsx")).await? else {
        return Ok(ReportSaveOutcome::Cancelled);
    };
    let xlsx = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"));
    if !xlsx {
        return Err(NOT_XLSX.into());
    }
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(DIRECTORY.into());
    }
    write_atomically(&path, bytes)?;
    Ok(ReportSaveOutcome::Saved {
        path: path.to_string_lossy().into_owned(),
    })
}

/// Removes an unfinished temporary file unless the rename succeeded.
struct TempFile {
    path: PathBuf,
    armed: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| UNKNOWN_PATH.to_string())?;
    let temp_path = parent.join(format!("{TEMP_PREFIX}{}.tmp", uuid::Uuid::new_v4()));
    let file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
    {
        Ok(file) => file,
        // A sandboxed save panel (macOS TCC) may grant the chosen file but not
        // its folder. Only this failure falls back to an in-place write.
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let target = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(path)
                .map_err(|error| io_failure(&error))?;
            return write_and_sync(target, bytes).map_err(|error| io_failure(&error));
        }
        Err(error) => return Err(io_failure(&error)),
    };
    let mut temp = TempFile {
        path: temp_path,
        armed: true,
    };
    // The handle is closed inside write_and_sync before any rename or cleanup.
    write_and_sync(file, bytes).map_err(|error| io_failure(&error))?;
    rename_with_retry(&temp.path, path).map_err(|error| {
        if is_locked(&error) {
            LOCKED.to_string()
        } else {
            io_failure(&error)
        }
    })?;
    temp.armed = false;
    Ok(())
}

fn write_and_sync(mut file: File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

/// Antivirus scanners or Excel may briefly hold the target file.
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < RENAME_ATTEMPTS && is_locked(&error) => {
                attempt += 1;
                std::thread::sleep(RENAME_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
}

/// Access denied, or a Windows sharing (32) / lock (33) violation.
fn is_locked(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}

fn io_failure(error: &io::Error) -> String {
    format!("Не удалось сохранить отчёт ({:?}).", error.kind())
}

/// The WebView passes only a default name and ready bytes; the path comes from
/// the native dialog, so the frontend never gets filesystem access.
#[tauri::command]
pub async fn report_save_xlsx<R: Runtime>(
    view: Webview<R>,
    guard: State<'_, ReportExportGuard>,
    default_name: String,
    bytes: Vec<u8>,
) -> Result<ReportSaveOutcome, String> {
    crate::project_store::commands::require_main(&view)?;
    validate_request(&default_name, &bytes)?;
    let window = view.window();
    save_report(&guard, &default_name, &bytes, move |file_name| async move {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Сохранить отчёт")
            .set_file_name(file_name)
            .add_filter("Книга Excel", &["xlsx"])
            .save_file(move |path| {
                let _ = tx.send(path);
            });
        match rx.await {
            Ok(Some(path)) => path
                .into_path()
                .map(Some)
                .map_err(|_| UNKNOWN_PATH.to_string()),
            Ok(None) => Ok(None),
            Err(_) => Err(DIALOG_UNAVAILABLE.to_string()),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::ready, sync::Arc};
    use tokio::sync::oneshot;

    const WORKBOOK: &[u8] = b"PK\x03\x04 test workbook";

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("capacity-report-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn picked(
        path: PathBuf,
    ) -> impl FnOnce(String) -> std::future::Ready<Result<Option<PathBuf>, String>> {
        move |_| ready(Ok(Some(path)))
    }

    fn leftover_temps(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(TEMP_PREFIX))
            .collect()
    }

    fn saved(path: &Path) -> Result<ReportSaveOutcome, String> {
        Ok(ReportSaveOutcome::Saved {
            path: path.to_string_lossy().into_owned(),
        })
    }

    #[test]
    fn outcome_serializes_to_the_ipc_contract() {
        assert_eq!(
            serde_json::to_value(ReportSaveOutcome::Saved {
                path: "C:\\Отчёт.xlsx".into()
            })
            .unwrap(),
            serde_json::json!({"status": "saved", "path": "C:\\Отчёт.xlsx"})
        );
        assert_eq!(
            serde_json::to_value(ReportSaveOutcome::Cancelled).unwrap(),
            serde_json::json!({"status": "cancelled"})
        );
    }

    #[test]
    fn payload_size_and_signature_are_checked() {
        let name = "Capacity Команда 2026 Q4";
        assert_eq!(validate_request(name, b""), Err(EMPTY_OR_TOO_LARGE.into()));
        let mut largest = vec![0; MAX_REPORT_BYTES];
        largest[..4].copy_from_slice(ZIP_SIGNATURE);
        assert_eq!(validate_request(name, &largest), Ok(()));
        largest.push(0);
        assert_eq!(
            validate_request(name, &largest),
            Err(EMPTY_OR_TOO_LARGE.into())
        );
        for bytes in [
            &b"PK"[..],
            b"PK\x05\x06",
            b"XLSX workbook",
            b"\x00PK\x03\x04",
        ] {
            assert_eq!(validate_request(name, bytes), Err(CORRUPTED.into()));
        }
        assert_eq!(validate_request(name, WORKBOOK), Ok(()));
    }

    #[test]
    fn default_names_follow_windows_file_name_rules() {
        for name in [
            "Capacity Команда 2026 Q4",
            "Отчёт",
            "a",
            ".отчёт",
            "Отчёт (копия) — итог, 50%",
        ] {
            assert_eq!(validate_request(name, WORKBOOK), Ok(()), "{name}");
        }
        let mut invalid = vec![
            String::new(),
            " ".into(),
            "   ".into(),
            "Отчёт.".into(),
            "Отчёт ".into(),
            "Отчёт\u{7}".into(),
            "От\nчёт".into(),
            "От\tчёт".into(),
            "\u{7f}Отчёт".into(),
            "Отчёт\u{9c}".into(),
        ];
        invalid.extend(FORBIDDEN_NAME_CHARS.iter().map(|c| format!("От{c}чёт")));
        for name in &invalid {
            assert_eq!(
                validate_request(name, WORKBOOK),
                Err(INVALID_NAME.into()),
                "{name:?}"
            );
        }
        // The limit is 200 UTF-16 units, not bytes and not chars.
        assert_eq!(validate_request(&"ж".repeat(200), WORKBOOK), Ok(()));
        assert_eq!(validate_request(&"a".repeat(200), WORKBOOK), Ok(()));
        assert_eq!(validate_request(&"😀".repeat(100), WORKBOOK), Ok(()));
        for name in [
            "a".repeat(201),
            "ж".repeat(201),
            format!("{}😀", "a".repeat(199)),
            format!("{}a", "😀".repeat(100)),
        ] {
            assert_eq!(
                validate_request(&name, WORKBOOK),
                Err(INVALID_NAME.into()),
                "{} units",
                name.encode_utf16().count()
            );
        }
    }

    #[test]
    fn cancel_and_picker_errors_write_nothing() {
        let dir = TempDir::new();
        let guard = ReportExportGuard::default();
        let outcome = run(save_report(&guard, "Отчёт", WORKBOOK, |name| {
            assert_eq!(name, "Отчёт.xlsx");
            ready(Ok(None))
        }));
        assert_eq!(outcome, Ok(ReportSaveOutcome::Cancelled));
        let outcome = run(save_report(&guard, "Отчёт", WORKBOOK, |_| {
            ready(Err(DIALOG_UNAVAILABLE.to_string()))
        }));
        assert_eq!(outcome, Err(DIALOG_UNAVAILABLE.into()));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn chosen_path_must_be_an_xlsx_file() {
        let dir = TempDir::new();
        let guard = ReportExportGuard::default();
        for name in ["Отчёт", "Отчёт.xls", "Отчёт.xlsx.txt", "Отчёт.csv"] {
            let target = dir.0.join(name);
            assert_eq!(
                run(save_report(&guard, "Отчёт", WORKBOOK, picked(target))),
                Err(NOT_XLSX.into()),
                "{name}"
            );
        }
        let folder = dir.0.join("Папка.xlsx");
        fs::create_dir(&folder).unwrap();
        assert_eq!(
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(folder.clone())
            )),
            Err(DIRECTORY.into())
        );
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);

        let upper = dir.0.join("Отчёт.XLSX");
        assert_eq!(
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(upper.clone())
            )),
            saved(&upper)
        );
        assert_eq!(fs::read(&upper).unwrap(), WORKBOOK);
    }

    #[test]
    fn saves_exact_bytes_and_replaces_existing_file() {
        let dir = TempDir::new();
        let folder = dir.0.join("Отчёт команды 2026");
        fs::create_dir(&folder).unwrap();
        let target = folder.join("Capacity Команда 2026 Q4.xlsx");
        let guard = ReportExportGuard::default();
        let first = run(save_report(
            &guard,
            "Capacity Команда 2026 Q4",
            WORKBOOK,
            |name| {
                assert_eq!(name, "Capacity Команда 2026 Q4.xlsx");
                ready(Ok(Some(target.clone())))
            },
        ));
        assert_eq!(first, saved(&target));
        assert_eq!(fs::read(&target).unwrap(), WORKBOOK);

        let mut replacement = b"PK\x03\x04".to_vec();
        replacement.extend((0..=255u8).cycle().take(300_000));
        let second = run(save_report(
            &guard,
            "Capacity Команда 2026 Q4",
            &replacement,
            picked(target.clone()),
        ));
        assert_eq!(second, saved(&target));
        assert_eq!(fs::read(&target).unwrap(), replacement);
        assert!(leftover_temps(&folder).is_empty());
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
    }

    #[test]
    fn failed_write_leaves_no_temporary_file() {
        let dir = TempDir::new();
        let guard = ReportExportGuard::default();
        let missing = dir.0.join("Нет такой папки").join("Отчёт.xlsx");
        assert_eq!(
            run(save_report(&guard, "Отчёт", WORKBOOK, picked(missing))),
            Err("Не удалось сохранить отчёт (NotFound).".into())
        );
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn locked_target_keeps_original_and_asks_to_close_it() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TempDir::new();
        let target = dir.0.join("Отчёт.xlsx");
        fs::write(&target, b"old workbook").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let guard = ReportExportGuard::default();
        let outcome = run(save_report(
            &guard,
            "Отчёт",
            WORKBOOK,
            picked(target.clone()),
        ));
        drop(lock);
        assert_eq!(outcome, Err(LOCKED.into()));
        assert_eq!(fs::read(&target).unwrap(), b"old workbook");
        assert!(leftover_temps(&dir.0).is_empty());
        // The guard was released, so the retry after closing the file works.
        assert_eq!(
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(target.clone())
            )),
            saved(&target)
        );
    }

    #[test]
    fn guard_is_released_after_every_outcome() {
        let dir = TempDir::new();
        let guard = ReportExportGuard::default();
        let target = dir.0.join("Отчёт.xlsx");
        let folder = dir.0.join("Папка.xlsx");
        fs::create_dir(&folder).unwrap();
        let outcomes = [
            run(save_report(&guard, "Отчёт", WORKBOOK, |_| {
                ready(Ok(None))
            })),
            run(save_report(&guard, "Отчёт", WORKBOOK, |_| {
                ready(Err("сбой окна".to_string()))
            })),
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(dir.0.join("Отчёт.txt")),
            )),
            run(save_report(&guard, "Отчёт", WORKBOOK, picked(folder))),
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(dir.0.join("нет").join("Отчёт.xlsx")),
            )),
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(target.clone()),
            )),
        ];
        assert_eq!(
            outcomes,
            [
                Ok(ReportSaveOutcome::Cancelled),
                Err("сбой окна".into()),
                Err(NOT_XLSX.into()),
                Err(DIRECTORY.into()),
                Err("Не удалось сохранить отчёт (NotFound).".into()),
                saved(&target),
            ]
        );
        assert!(!guard.0.load(Ordering::Acquire));
    }

    #[test]
    fn concurrent_export_is_rejected_without_opening_a_dialog() {
        let dir = TempDir::new();
        let target = dir.0.join("Отчёт.xlsx");
        let guard = Arc::new(ReportExportGuard::default());
        let (entered_tx, entered_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<Option<PathBuf>>();
        run(async {
            let first = tokio::spawn({
                let guard = guard.clone();
                async move {
                    save_report(&guard, "Отчёт", WORKBOOK, move |_| async move {
                        let _ = entered_tx.send(());
                        release_rx.await.map_err(|_| "тест прерван".to_string())
                    })
                    .await
                }
            });
            entered_rx.await.unwrap();
            let busy = save_report(&guard, "Отчёт", WORKBOOK, |_| async {
                Err::<Option<PathBuf>, _>("второе окно не должно открываться".to_string())
            })
            .await;
            assert_eq!(busy, Err(BUSY.into()));
            release_tx.send(Some(target.clone())).unwrap();
            assert_eq!(first.await.unwrap(), saved(&target));
        });
        assert_eq!(fs::read(&target).unwrap(), WORKBOOK);
        assert_eq!(
            run(save_report(
                &guard,
                "Отчёт",
                WORKBOOK,
                picked(target.clone())
            )),
            saved(&target)
        );
    }
}
