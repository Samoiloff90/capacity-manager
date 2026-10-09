use super::*;
use sqlx::{Connection, Executor, Row, SqliteConnection};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

fn run(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Runtime::new().unwrap().block_on(future);
}

fn fixture() -> preflight::ScratchDirectory {
    preflight::ScratchDirectory::new().unwrap()
}

async fn registered(instances: &DbInstances, key: &str) -> SqlitePool {
    let registry = instances.0.read().await;
    match registry.get(key).unwrap() {
        DbPool::Sqlite(pool) => pool.clone(),
    }
}

/// The store's own, trusted access to the only connection of an open session (Q-001):
/// what a test sets up there (PRAGMAs, schema changes, a crash in a transaction) is not
/// something the window may do through the SQL plugin.
async fn trusted(store: &ProjectStore, key: &str) -> sql_guard::Trusted {
    let (guard, pool) = {
        let sessions = store.sessions.lock().await;
        let session = sessions.get(key).unwrap();
        (session.guard, session.pool.clone())
    };
    guard.trust(pool.acquire().await.unwrap())
}

/// Reads the project file through a separate read-only connection, as an outside observer.
async fn observer(pool: &SqlitePool) -> SqliteConnection {
    SqliteConnection::connect_with(&connection_options(
        pool.connect_options().get_filename(),
        true,
    ))
    .await
    .unwrap()
}

fn contents(path: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_string_lossy().to_string(),
                fs::read(path).unwrap(),
            )
        })
        .collect()
}

async fn new_project() -> (
    preflight::ScratchDirectory,
    ProjectStore,
    DbInstances,
    ProjectSession,
) {
    let folder = fixture();
    let store = ProjectStore::new();
    let instances = DbInstances::default();
    let session = store
        .create(&instances, folder.path().to_owned(), "Команда".into())
        .await
        .unwrap();
    (folder, store, instances, session)
}

async fn insert(pool: &SqlitePool, id: &str, year: i64, quarter: i64, label: &str) {
    let payload = serde_json::json!({"year":year,"quarter":quarter,"label":label}).to_string();
    sqlx::query("INSERT INTO quarter_plans (plan_id, year, quarter, revision, payload_version, payload_json) VALUES (?, ?, ?, 1, 1, ?)")
        .bind(id).bind(year).bind(quarter).bind(payload).execute(pool).await.unwrap();
}

#[test]
fn native_path_registry_settings_and_stale_sessions() {
    run(async {
        let root = fixture();
        let directory = root.path().join("Команда 50% # папка");
        fs::create_dir(&directory).unwrap();
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let first = store
            .create(&instances, directory.clone(), "Команда".into())
            .await
            .unwrap();
        let pool = registered(&instances, &first.session_key).await;
        assert_eq!(pool.options().get_max_connections(), 1);
        // The settings of the session's own connection, read by the store, not by the window.
        let mut checked = trusted(&store, &first.session_key).await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
                .fetch_one(checked.connection())
                .await
                .unwrap(),
            "delete"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA synchronous")
                .fetch_one(checked.connection())
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(checked.connection())
                .await
                .unwrap(),
            1
        );
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(checked.connection())
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA max_page_count")
                .fetch_one(checked.connection())
                .await
                .unwrap(),
            (preflight::MAX_PROJECT_BYTES / page_size as u64) as i64
        );
        checked.finish().await.unwrap();
        assert!(!first.sqlite_version.is_empty());
        insert(&pool, "plan", 2026, 2, "сохранено").await;
        store.close(&instances, &first.session_key).await.unwrap();
        assert!(!instances.0.read().await.contains_key(&first.session_key));
        assert!(sqlx::query("SELECT 1").execute(&pool).await.is_err());
        assert!(matches!(
            store.close(&instances, &first.session_key).await,
            Err(StoreError::ClosedSession)
        ));
        let next = store.open(&instances, directory).await.unwrap();
        assert_ne!(first.session_key, next.session_key);
        assert_eq!(first.project_id, next.project_id);
        let pool = registered(&instances, &next.session_key).await;
        let payload: String = sqlx::query_scalar("SELECT payload_json FROM quarter_plans")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(payload.contains("сохранено"));
        store.close(&instances, &next.session_key).await.unwrap();
    });
}

#[test]
fn cas_is_atomic_conflicts_do_not_overwrite_and_quarters_are_independent() {
    run(async {
        let (_folder, store, instances, session) = new_project().await;
        let pool = registered(&instances, &session.session_key).await;
        insert(&pool, "q2", 2026, 2, "first").await;
        insert(&pool, "q3", 2026, 3, "untouched").await;
        let statement = "UPDATE quarter_plans SET payload_json = ?, revision = revision + 1 WHERE plan_id = ? AND revision = ?";
        let updated = sqlx::query(statement)
            .bind(r#"{"year":2026,"quarter":2,"label":"new"}"#)
            .bind("q2")
            .bind(1_i64)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(updated.rows_affected(), 1);
        let stale = sqlx::query(statement)
            .bind(r#"{"year":2026,"quarter":2,"label":"lost"}"#)
            .bind("q2")
            .bind(1_i64)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(stale.rows_affected(), 0);
        assert!(sqlx::query(statement)
            .bind("invalid json")
            .bind("q2")
            .bind(2_i64)
            .execute(&pool)
            .await
            .is_err());
        let row =
            sqlx::query("SELECT revision, payload_json FROM quarter_plans WHERE plan_id='q2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.get::<i64, _>("revision"), 2);
        assert!(row.get::<String, _>("payload_json").contains("new"));
        let other: String =
            sqlx::query_scalar("SELECT payload_json FROM quarter_plans WHERE plan_id='q3'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(other.contains("untouched"));
        store.close(&instances, &session.session_key).await.unwrap();
    });
}

#[test]
fn missing_foreign_corrupt_future_wal_and_trigger_files_remain_unchanged() {
    run(async {
        for kind in [
            "missing", "foreign", "corrupt", "future", "format3", "mismatch", "wal", "trigger",
            "payload",
        ] {
            let (folder, store, instances, session) = new_project().await;
            store.close(&instances, &session.session_key).await.unwrap();
            // Prove rejected open does not even create a new lock file.
            fs::remove_file(folder.path().join(".capacity.lock")).unwrap();
            let path = folder.path().join(DATABASE_NAME);
            match kind {
                "missing" => fs::remove_file(&path).unwrap(),
                "foreign" => {
                    fs::remove_file(&path).unwrap();
                    let mut db = SqliteConnection::connect_with(
                        &connection_options(&path, false).create_if_missing(true),
                    )
                    .await
                    .unwrap();
                    db.execute("CREATE TABLE unrelated (value TEXT)")
                        .await
                        .unwrap();
                    db.close().await.unwrap();
                }
                "corrupt" => fs::write(&path, b"not a sqlite database").unwrap(),
                other => {
                    let mut db = SqliteConnection::connect_with(&connection_options(&path, false))
                        .await
                        .unwrap();
                    match other {
                        "future" => {
                            db.execute("PRAGMA user_version=999").await.unwrap();
                        }
                        "format3" => {
                            db.execute("PRAGMA user_version=3").await.unwrap();
                        }
                        "mismatch" => {
                            db.execute("PRAGMA user_version=1").await.unwrap();
                        }
                        "wal" => {
                            db.execute("PRAGMA journal_mode=WAL").await.unwrap();
                        }
                        "trigger" => {
                            db.execute("CREATE TRIGGER malicious AFTER INSERT ON quarter_plans BEGIN DELETE FROM project_meta; END").await.unwrap();
                        }
                        "payload" => {
                            db.execute("INSERT INTO quarter_plans VALUES ('bad',2026,1,1,1,'{\"year\":2027,\"quarter\":1}')").await.unwrap();
                        }
                        _ => unreachable!(),
                    }
                    db.close().await.unwrap();
                }
            }
            let before = contents(folder.path());
            assert!(
                store
                    .open(&instances, folder.path().to_owned())
                    .await
                    .is_err(),
                "{kind}"
            );
            assert_eq!(
                before,
                contents(folder.path()),
                "changed rejected {kind} folder"
            );
        }
    });
}

#[test]
fn create_refuses_nonempty_folder_without_changes() {
    run(async {
        let folder = fixture();
        fs::write(folder.path().join("чужой.txt"), b"keep").unwrap();
        let before = contents(folder.path());
        assert!(ProjectStore::new()
            .create(
                &DbInstances::default(),
                folder.path().to_owned(),
                "new".into()
            )
            .await
            .is_err());
        assert_eq!(before, contents(folder.path()));
    });
}

#[test]
fn create_accepts_folder_with_only_os_metadata_and_leaves_it_unchanged() {
    run(async {
        let folder = fixture();
        fs::write(folder.path().join(".DS_Store"), b"finder").unwrap();
        fs::write(folder.path().join("desktop.ini"), b"[.ShellClassInfo]").unwrap();
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let session = store
            .create(&instances, folder.path().to_owned(), "Команда".into())
            .await
            .unwrap();
        store.close(&instances, &session.session_key).await.unwrap();
        let after = contents(folder.path());
        assert_eq!(
            after.get(".DS_Store").map(Vec::as_slice),
            Some(&b"finder"[..])
        );
        assert_eq!(
            after.get("desktop.ini").map(Vec::as_slice),
            Some(&b"[.ShellClassInfo]"[..])
        );
        assert!(after.contains_key(DATABASE_NAME));
    });
}

#[test]
fn create_refuses_os_metadata_next_to_another_file_and_ignores_case() {
    run(async {
        let folder = fixture();
        fs::write(folder.path().join("THUMBS.DB"), b"cache").unwrap();
        fs::write(folder.path().join(".localized"), b"").unwrap();
        fs::write(folder.path().join("план.txt"), b"keep").unwrap();
        let before = contents(folder.path());
        assert!(ProjectStore::new()
            .create(
                &DbInstances::default(),
                folder.path().to_owned(),
                "new".into()
            )
            .await
            .is_err());
        assert_eq!(before, contents(folder.path()));
        assert!(ignorable_in_empty_folder(std::ffi::OsStr::new(
            "Desktop.ini"
        )));
        assert!(!ignorable_in_empty_folder(std::ffi::OsStr::new(
            ".CAPACITY.LOCK"
        )));
    });
}

#[test]
fn open_folder_with_only_a_stale_lock_says_there_is_no_project() {
    run(async {
        let folder = fixture();
        fs::write(folder.path().join(".capacity.lock"), b"").unwrap();
        let before = contents(folder.path());
        let error = ProjectStore::new()
            .open(&DbInstances::default(), folder.path().to_owned())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("нет проекта Capacity Planner"), "{error}");
        assert_eq!(before, contents(folder.path()));
    });
}

#[test]
fn open_folder_without_project_explains_it_in_russian_and_changes_nothing() {
    run(async {
        let folder = fixture();
        fs::write(folder.path().join("заметки.txt"), b"keep").unwrap();
        let before = contents(folder.path());
        let error = ProjectStore::new()
            .open(&DbInstances::default(), folder.path().to_owned())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("нет проекта Capacity Planner"), "{error}");
        assert_eq!(before, contents(folder.path()));
    });
}

#[test]
fn close_waits_pending_connection_and_only_closes_its_project() {
    run(async {
        let (a, store, instances, session) = new_project().await;
        let b = fixture();
        let other = store
            .create(&instances, b.path().to_owned(), "Другая".into())
            .await
            .unwrap();
        let pool = registered(&instances, &session.session_key).await;
        let pending = pool.acquire().await.unwrap();
        let closing = store.close(&instances, &session.session_key);
        tokio::pin!(closing);
        assert!(
            tokio::time::timeout(Duration::from_millis(40), &mut closing)
                .await
                .is_err()
        );
        assert!(!instances.0.read().await.contains_key(&session.session_key));
        // OS ownership survives until the checked-out connection is returned.
        assert!(matches!(
            preflight::Ownership::acquire(a.path()),
            Err(StoreError::Busy)
        ));
        drop(pending);
        closing.await.unwrap();
        assert!(preflight::Ownership::acquire(a.path()).is_ok());
        let other_pool = registered(&instances, &other.session_key).await;
        sqlx::query("SELECT 1").execute(&other_pool).await.unwrap();
        store.close(&instances, &other.session_key).await.unwrap();
    });
}

#[test]
fn migration_failure_rolls_back_schema_and_version_and_copy_reopens_independently() {
    run(async {
        let (folder, store, instances, session) = new_project().await;
        let pool = registered(&instances, &session.session_key).await;
        insert(&pool, "q", 2026, 1, "original").await;
        let mut trusted = trusted(&store, &session.session_key).await;
        let connection = trusted.connection();
        assert!(schema::migration_fixture(
            &mut *connection,
            &[
                "CREATE TABLE added (id INTEGER)",
                "INSERT INTO missing VALUES (1)"
            ],
            3
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&mut *connection)
                .await
                .unwrap(),
            SCHEMA_VERSION
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE name='added'")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
        assert_eq!(count, 0);
        trusted.finish().await.unwrap();
        store.close(&instances, &session.session_key).await.unwrap();
        let copy = fixture();
        for entry in fs::read_dir(folder.path()).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), copy.path().join(entry.file_name())).unwrap();
        }
        let first = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        let second = store
            .open(&instances, copy.path().to_owned())
            .await
            .unwrap();
        let copied = registered(&instances, &second.session_key).await;
        sqlx::query("UPDATE quarter_plans SET revision=2 WHERE plan_id='q'")
            .execute(&copied)
            .await
            .unwrap();
        let original = registered(&instances, &first.session_key).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT revision FROM quarter_plans")
                .fetch_one(&original)
                .await
                .unwrap(),
            1
        );
        store.close(&instances, &first.session_key).await.unwrap();
        store.close(&instances, &second.session_key).await.unwrap();
    });
}

fn child(folder: &Path, role: &str) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "project_store::tests::process_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("CAPACITY_STORAGE_TEST_FOLDER", folder)
        .env("CAPACITY_STORAGE_TEST_ROLE", role)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .stdin(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
#[ignore = "child-process fixture, invoked by the parent tests with a temporary folder"]
fn process_fixture() {
    let folder = PathBuf::from(
        std::env::var_os("CAPACITY_STORAGE_TEST_FOLDER").expect("test fixture folder"),
    );
    let role = std::env::var("CAPACITY_STORAGE_TEST_ROLE").unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async move {
        let instances = DbInstances::default();
        let store = ProjectStore::new();
        let session = store.open(&instances, folder).await.unwrap();
        if role == "upgrade-crash" {
            let _ = store
                .upgrade_format_inner(&session.session_key, schema::UpgradeFault::Exit)
                .await;
            unreachable!("the upgrade must exit inside its transaction");
        }
        if role == "crash" {
            let mut trusted = trusted(&store, &session.session_key).await;
            let connection = trusted.connection();
            (&mut *connection).execute("PRAGMA cache_size=1").await.unwrap();
            (&mut *connection).execute("PRAGMA cache_spill=ON").await.unwrap();
            (&mut *connection).execute("BEGIN IMMEDIATE").await.unwrap();
            let data = serde_json::json!({"year":2026,"quarter":1,"label":"uncommitted".repeat(50000)}).to_string();
            sqlx::query("UPDATE quarter_plans SET payload_json=?, revision=99 WHERE plan_id='q'").bind(data).execute(&mut *connection).await.unwrap();
            // Deliberately no Rust destructors/SQLite close: genuine hot journal.
            std::process::exit(23);
        }
        println!("STORAGE_READY"); std::io::stdout().flush().unwrap();
        let mut line = String::new(); std::io::stdin().read_line(&mut line).unwrap();
        store.close(&instances, &session.session_key).await.unwrap();
    });
}

#[test]
fn process_ownership_is_exclusive_and_released_after_kill() {
    run(async {
        let (folder, store, instances, session) = new_project().await;
        store.close(&instances, &session.session_key).await.unwrap();
        let mut child = child(folder.path(), "hold");
        let mut output = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0);
            if line.contains("STORAGE_READY") {
                break;
            }
        }
        assert!(matches!(
            store.open(&instances, folder.path().to_owned()).await,
            Err(StoreError::Busy)
        ));
        child.kill().unwrap();
        child.wait().unwrap();
        let recovered = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        store
            .close(&instances, &recovered.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn hot_journal_after_real_process_crash_recovers_last_commit() {
    run(async {
        let (folder, store, instances, session) = new_project().await;
        let pool = registered(&instances, &session.session_key).await;
        insert(&pool, "q", 2026, 1, "committed").await;
        store.close(&instances, &session.session_key).await.unwrap();
        let status = child(folder.path(), "crash").wait().unwrap();
        assert_eq!(status.code(), Some(23));
        let journal = preflight::sidecar(&folder.path().join(DATABASE_NAME), "-journal");
        assert!(
            fs::metadata(&journal).unwrap().len() > 512,
            "must really leave a rollback journal"
        );
        let recovered = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        let pool = registered(&instances, &recovered.session_key).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT revision FROM quarter_plans")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        let json: String = sqlx::query_scalar("SELECT payload_json FROM quarter_plans")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(json.contains("committed"));
        assert!(!json.contains("uncommitted"));
        store
            .close(&instances, &recovered.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn failed_create_can_retry_same_folder_without_partial_database() {
    run(async {
        let folder = fixture();
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        assert!(store
            .create_inner(&instances, folder.path().to_owned(), "Команда".into(), true)
            .await
            .is_err());
        assert_eq!(
            contents(folder.path()).keys().cloned().collect::<Vec<_>>(),
            vec![".capacity.lock"]
        );
        let session = store
            .create(&instances, folder.path().to_owned(), "Повтор".into())
            .await
            .unwrap();
        store.close(&instances, &session.session_key).await.unwrap();
        let reopened = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        assert_eq!(reopened.name, "Повтор");
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn size_limit_rejects_write_atomically_instead_of_unreadable_success() {
    run(async {
        let (folder, store, instances, session) = new_project().await;
        let pool = registered(&instances, &session.session_key).await;
        insert(&pool, "q", 2026, 1, "before").await;
        // Same max_page_count mechanism as production, smaller to avoid allocating
        // 128 MiB in the regression test. It limits writes, not just later reads.
        let mut trusted = trusted(&store, &session.session_key).await;
        sqlx::query("PRAGMA max_page_count=8")
            .execute(trusted.connection())
            .await
            .unwrap();
        trusted.finish().await.unwrap();
        let payload =
            serde_json::json!({"year":2026,"quarter":1,"label":"x".repeat(65536)}).to_string();
        assert!(sqlx::query(
            "UPDATE quarter_plans SET payload_json=?, revision=2 WHERE plan_id='q'"
        )
        .bind(payload)
        .execute(&pool)
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT revision FROM quarter_plans")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        store.close(&instances, &session.session_key).await.unwrap();
        let reopened = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn dropping_store_closes_registry_clone_before_releasing_ownership() {
    run(async {
        let (folder, store, instances, session) = new_project().await;
        let pool = registered(&instances, &session.session_key).await;
        let pending = pool.acquire().await.unwrap();
        drop(store);
        assert!(matches!(
            preflight::Ownership::acquire(folder.path()),
            Err(StoreError::Busy)
        ));
        drop(pending);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if preflight::Ownership::acquire(folder.path()).is_ok() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "drop cleanup did not release ownership"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(sqlx::query("SELECT 1").execute(&pool).await.is_err());
        let replacement = ProjectStore::new();
        let reopened = replacement
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        assert_ne!(reopened.session_key, session.session_key);
        replacement
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn cancelled_close_finishes_on_independent_runtime() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (folder, instances, pool) = runtime.block_on(async {
        let (folder, store, instances, session) = new_project().await;
        let pool = registered(&instances, &session.session_key).await;
        let pending = pool.acquire().await.unwrap();
        {
            let closing = store.close(&instances, &session.session_key);
            tokio::pin!(closing);
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut closing)
                    .await
                    .is_err()
            );
        } // Cancel the original request while cleanup is waiting.
        drop(pending);
        (folder, instances, pool)
    });
    drop(runtime); // The caller's runtime cannot cancel the close worker.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if preflight::Ownership::acquire(folder.path()).is_ok() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "cancelled close stranded ownership"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    run(async {
        assert!(sqlx::query("SELECT 1").execute(&pool).await.is_err());
        let store = ProjectStore::new();
        let reopened = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn abandoned_open_worker_closes_pool_and_releases_ownership() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (folder, instances) = runtime.block_on(async {
        let (folder, store, instances, session) = new_project().await;
        store.close(&instances, &session.session_key).await.unwrap();
        let ownership = preflight::Ownership::acquire(folder.path()).unwrap();
        let opening = start_open(folder.path().join(DATABASE_NAME), ownership).unwrap();
        // The receiver represents the cancelled caller. Its runtime may also
        // disappear before the independently owned connect/close completes.
        drop(opening);
        (folder, instances)
    });
    drop(runtime);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if preflight::Ownership::acquire(folder.path()).is_ok() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "abandoned open stranded ownership"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    run(async {
        let store = ProjectStore::new();
        let reopened = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

/// A project exactly as 0.1.0–0.3.0 created it, with quarter rows of format 1.
async fn format1_project(rows: &[(&str, i64, i64, &str)]) -> (preflight::ScratchDirectory, String) {
    let folder = fixture();
    let path = folder.path().join(DATABASE_NAME);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connection_options(&path, false).create_if_missing(true))
        .await
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    schema::initialize_format1(&pool, &id, "Команда 0.3.0")
        .await
        .unwrap();
    for (plan, year, quarter, label) in rows {
        insert(&pool, plan, *year, *quarter, label).await;
    }
    pool.close().await;
    (folder, id)
}

fn database(folder: &Path) -> Vec<u8> {
    fs::read(folder.join(DATABASE_NAME)).unwrap()
}

/// Temporary copies in progress; none may stay after a finished or failed backup.
fn partials(folder: &Path) -> Vec<String> {
    fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".capacity-backup-"))
        .collect()
}

fn backups(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("capacity-backup-format1-"))
        .collect();
    names.sort();
    names
}

type QuarterRow = (String, i64, i64, i64, String);

async fn rows(pool: &SqlitePool) -> Vec<QuarterRow> {
    sqlx::query_as(
        "SELECT plan_id, year, quarter, revision, payload_json FROM quarter_plans ORDER BY plan_id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn versions(pool: &SqlitePool) -> (i64, Vec<i64>, String) {
    let mut connection = observer(pool).await;
    let user: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    let payloads: Vec<i64> =
        sqlx::query_scalar("SELECT payload_version FROM quarter_plans ORDER BY plan_id")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    let table: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name = 'quarter_plans'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    (user, payloads, table)
}

const LEGACY_ROWS: &[(&str, i64, i64, &str)] =
    &[("q1", 2026, 1, "первый"), ("q2", 2026, 2, "второй")];

#[test]
fn format1_project_opens_unchanged_and_is_upgraded_with_a_verified_backup() {
    run(async {
        let (folder, project_id) = format1_project(LEGACY_ROWS).await;
        let original = database(folder.path());
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let session = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        assert_eq!(session.schema_version, LEGACY_SCHEMA_VERSION);
        assert_eq!(session.project_id, project_id);
        let before = rows(&registered(&instances, &session.session_key).await).await;
        store.close(&instances, &session.session_key).await.unwrap();
        assert_eq!(
            database(folder.path()),
            original,
            "opening must not change the file"
        );
        assert!(backups(folder.path()).is_empty());

        let session = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        let pool = registered(&instances, &session.session_key).await;
        // Format 1 has no room for a quarter of format 2 until the upgrade.
        assert!(
            sqlx::query("UPDATE quarter_plans SET payload_version = 2 WHERE plan_id = 'q1'")
                .execute(&pool)
                .await
                .is_err()
        );
        let upgrade = store.upgrade_format(&session.session_key).await.unwrap();
        assert_eq!(upgrade.schema_version, SCHEMA_VERSION);
        let shown = upgrade.backup_path.clone().unwrap();
        assert!(
            !shown.starts_with(r"\\?\"),
            "the path is shown as in Explorer: {shown}"
        );
        let names = backups(folder.path());
        assert_eq!(names.len(), 1);
        assert!(partials(folder.path()).is_empty());
        assert!(shown.ends_with(&names[0]));
        assert_eq!(
            fs::read(folder.path().join(&names[0])).unwrap(),
            original,
            "the backup is the original file"
        );
        let (user, payloads, table) = versions(&pool).await;
        assert_eq!((user, payloads), (SCHEMA_VERSION, vec![1, 1]));
        assert!(table.contains("payload_version IN (1, 2)"));
        assert_eq!(rows(&pool).await, before, "rows move unchanged");
        sqlx::query("UPDATE quarter_plans SET payload_version = 2, revision = revision + 1 WHERE plan_id = 'q1'")
            .execute(&pool)
            .await
            .unwrap();
        // Asked again, nothing happens and no second copy appears.
        let again = store.upgrade_format(&session.session_key).await.unwrap();
        assert!(again.backup_path.is_none());
        assert_eq!(backups(folder.path()).len(), 1);
        store.close(&instances, &session.session_key).await.unwrap();

        let header = &database(folder.path())[..100];
        assert_eq!(
            u32::from_be_bytes(header[60..64].try_into().unwrap()),
            2,
            "0.3.0 refuses any version but 1"
        );
        assert_eq!(
            u32::from_be_bytes(header[68..72].try_into().unwrap()) as i64,
            APPLICATION_ID
        );
        let reopened = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        assert_eq!(reopened.schema_version, SCHEMA_VERSION);
        let pool = registered(&instances, &reopened.session_key).await;
        assert_eq!(
            versions(&pool).await.1,
            vec![2, 1],
            "quarters of both formats live in one file"
        );
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn failed_backup_leaves_the_project_untouched_and_a_retry_succeeds() {
    run(async {
        let (folder, _) = format1_project(LEGACY_ROWS).await;
        let original = database(folder.path());
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let session = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        let error = store
            .upgrade_format_inner(&session.session_key, schema::UpgradeFault::Backup)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with("Не удалось создать резервную копию проекта"),
            "{error}"
        );
        assert!(error.ends_with("Исходный файл не изменён."), "{error}");
        assert!(backups(folder.path()).is_empty(), "no backup appears");
        assert!(
            partials(folder.path()).is_empty(),
            "no partial copy is left"
        );
        let pool = registered(&instances, &session.session_key).await;
        assert_eq!(versions(&pool).await.0, LEGACY_SCHEMA_VERSION);
        store.upgrade_format(&session.session_key).await.unwrap();
        store.close(&instances, &session.session_key).await.unwrap();
        assert_eq!(
            fs::read(folder.path().join(&backups(folder.path())[0])).unwrap(),
            original
        );
    });
}

#[test]
fn failed_upgrade_rolls_back_and_keeps_the_checked_backup() {
    run(async {
        let (folder, _) = format1_project(LEGACY_ROWS).await;
        let original = database(folder.path());
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let session = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        let pool = registered(&instances, &session.session_key).await;
        let before = rows(&pool).await;
        let error = store
            .upgrade_format_inner(&session.session_key, schema::UpgradeFault::Migration)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with("Не удалось обновить формат проекта"),
            "{error}"
        );
        assert!(
            error.contains("Исходный файл не изменён, резервная копия: "),
            "{error}"
        );
        let (user, payloads, table) = versions(&pool).await;
        assert_eq!((user, payloads), (LEGACY_SCHEMA_VERSION, vec![1, 1]));
        assert!(table.contains("payload_version = 1"));
        assert_eq!(rows(&pool).await, before);
        let leftovers: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_schema WHERE name = 'quarter_plans_format1'",
        )
        .fetch_one(&mut observer(&pool).await)
        .await
        .unwrap();
        assert_eq!(leftovers, 0);
        store.close(&instances, &session.session_key).await.unwrap();
        assert_eq!(
            database(folder.path()),
            original,
            "the rolled back file is the original"
        );
        assert_eq!(
            fs::read(folder.path().join(&backups(folder.path())[0])).unwrap(),
            original
        );
        let reopened = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        assert_eq!(reopened.schema_version, LEGACY_SCHEMA_VERSION);
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn upgrade_interrupted_by_a_process_crash_reopens_as_the_format1_project() {
    run(async {
        let big = "x".repeat(200_000);
        let (folder, project_id) =
            format1_project(&[("q1", 2026, 1, "первый"), ("q2", 2026, 2, &big)]).await;
        let original = database(folder.path());
        let status = child(folder.path(), "upgrade-crash").wait().unwrap();
        assert_eq!(status.code(), Some(24));
        let journal = preflight::sidecar(&folder.path().join(DATABASE_NAME), "-journal");
        assert!(
            fs::metadata(&journal).unwrap().len() > 512,
            "must really leave a rollback journal"
        );
        assert_eq!(
            fs::read(folder.path().join(&backups(folder.path())[0])).unwrap(),
            original
        );
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let recovered = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        assert_eq!(recovered.schema_version, LEGACY_SCHEMA_VERSION);
        assert_eq!(recovered.project_id, project_id);
        let pool = registered(&instances, &recovered.session_key).await;
        let (user, payloads, _) = versions(&pool).await;
        assert_eq!((user, payloads), (LEGACY_SCHEMA_VERSION, vec![1, 1]));
        let restored = rows(&pool).await;
        assert!(restored[1].4.contains(&big));
        // The recovered project can be upgraded again.
        store.upgrade_format(&recovered.session_key).await.unwrap();
        store
            .close(&instances, &recovered.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn restoring_the_backup_brings_back_the_project_as_saved_by_0_3_0() {
    run(async {
        let (folder, project_id) = format1_project(LEGACY_ROWS).await;
        let original = database(folder.path());
        let store = ProjectStore::new();
        let instances = DbInstances::default();
        let session = store
            .open(&instances, folder.path().to_owned())
            .await
            .unwrap();
        let before = rows(&registered(&instances, &session.session_key).await).await;
        store.upgrade_format(&session.session_key).await.unwrap();
        store.close(&instances, &session.session_key).await.unwrap();
        // The documented restore: the copy becomes capacity.sqlite of a closed project.
        let restored = fixture();
        fs::copy(
            folder.path().join(&backups(folder.path())[0]),
            restored.path().join(DATABASE_NAME),
        )
        .unwrap();
        assert_eq!(database(restored.path()), original);
        let reopened = store
            .open(&instances, restored.path().to_owned())
            .await
            .unwrap();
        assert_eq!(reopened.schema_version, LEGACY_SCHEMA_VERSION);
        assert_eq!(reopened.project_id, project_id);
        assert_eq!(
            rows(&registered(&instances, &reopened.session_key).await).await,
            before
        );
        store
            .close(&instances, &reopened.session_key)
            .await
            .unwrap();
    });
}

#[test]
fn backup_names_use_the_utc_date_and_never_reuse_a_file() {
    assert_eq!(backup::civil_from_days(0), (1970, 1, 1));
    assert_eq!(backup::civil_from_days(-1), (1969, 12, 31));
    assert_eq!(backup::civil_from_days(11_016), (2000, 2, 29));
    assert_eq!(backup::civil_from_days(20_732), (2026, 10, 6));
    assert_eq!(
        backup::file_name((2026, 10, 6), 0),
        "capacity-backup-format1-2026-10-06.sqlite"
    );
    assert_eq!(
        backup::file_name((2026, 10, 6), 1),
        "capacity-backup-format1-2026-10-06-2.sqlite"
    );
    assert_eq!(
        backup::shown(Path::new(r"\\?\D:\Команды\А\x.sqlite")),
        r"D:\Команды\А\x.sqlite"
    );
    assert_eq!(
        backup::shown(Path::new(r"\\?\UNC\server\share\x.sqlite")),
        r"\\server\share\x.sqlite"
    );
    assert_eq!(
        backup::shown(Path::new("/Users/po/Команда/x.sqlite")),
        "/Users/po/Команда/x.sqlite"
    );
    let folder = fixture();
    let source = folder.path().join(DATABASE_NAME);
    fs::write(&source, b"SQLite format 3\0 test bytes").unwrap();
    let first = backup::create(&source, false).unwrap();
    let second = backup::create(&source, false).unwrap();
    assert_ne!(first, second);
    assert!(
        second.to_string_lossy().ends_with("-2.sqlite"),
        "{}",
        second.display()
    );
    assert!(partials(folder.path()).is_empty());
    assert_eq!(fs::read(&first).unwrap(), fs::read(&source).unwrap());
    assert_eq!(fs::read(&second).unwrap(), fs::read(&source).unwrap());
}

/// Fictional demo projects for a preview build, written by the store exactly as the app
/// writes them. Payloads come from tests/demo-projects.test.ts. CI only:
/// `CAPACITY_DEMO_OUT=<empty dir> cargo test --lib write_demo_projects -- --ignored`.
#[test]
#[ignore = "writes the demo projects of a preview build into CAPACITY_DEMO_OUT"]
fn write_demo_projects() {
    const CURRENT: &str = include_str!("../../../tests/fixtures/demo/current-2027-q1.json");
    const LEGACY: &str = include_str!("../../../tests/fixtures/demo/legacy-2026-q4.format1.json");
    let out = PathBuf::from(std::env::var("CAPACITY_DEMO_OUT").expect("CAPACITY_DEMO_OUT"));
    let minified = |text: &str| {
        serde_json::from_str::<serde_json::Value>(text)
            .unwrap()
            .to_string()
    };
    run(async {
        let store = ProjectStore::new();
        let instances = DbInstances::default();

        let current = out.join("Alpha-new-format");
        fs::create_dir_all(&current).unwrap();
        let session = store
            .create(
                &instances,
                current.clone(),
                "Учебная команда «Альфа»".into(),
            )
            .await
            .unwrap();
        assert_eq!(session.schema_version, SCHEMA_VERSION);
        let pool = registered(&instances, &session.session_key).await;
        sqlx::query("INSERT INTO quarter_plans (plan_id, year, quarter, revision, payload_version, payload_json) VALUES (?, 2027, 1, 1, ?, ?)")
            .bind("demo-alpha-2027-q1").bind(schema::PAYLOAD_VERSION).bind(minified(CURRENT))
            .execute(&pool).await.unwrap();
        drop(pool);
        store.close(&instances, &session.session_key).await.unwrap();

        // As 0.1.0–0.3.0 created it: schema 1, payload 1.
        let legacy = out.join("Beta-format-0.3.0");
        fs::create_dir_all(&legacy).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                connection_options(&legacy.join(DATABASE_NAME), false).create_if_missing(true),
            )
            .await
            .unwrap();
        schema::initialize_format1(
            &pool,
            "8c0f5d2e-6a71-4c39-9d0e-3b1f2a4c5d6e",
            "Учебная команда «Бета» (формат 0.3.0)",
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO quarter_plans (plan_id, year, quarter, revision, payload_version, payload_json) VALUES (?, 2026, 4, 1, 1, ?)")
            .bind("demo-beta-2026-q4").bind(minified(LEGACY))
            .execute(&pool).await.unwrap();
        pool.close().await;

        // Both open as projects of their format and are left closed, without a lock file.
        for (folder, version) in [(&current, SCHEMA_VERSION), (&legacy, LEGACY_SCHEMA_VERSION)] {
            let session = store.open(&instances, folder.to_path_buf()).await.unwrap();
            assert_eq!(session.schema_version, version);
            store.close(&instances, &session.session_key).await.unwrap();
            let _ = fs::remove_file(folder.join(".capacity.lock"));
            let mut names: Vec<String> = fs::read_dir(folder)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            assert_eq!(
                names,
                vec![DATABASE_NAME.to_string()],
                "{}",
                folder.display()
            );
        }
    });
}
