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
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "delete"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA synchronous")
                .fetch_one(&pool)
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA max_page_count")
                .fetch_one(&pool)
                .await
                .unwrap(),
            (preflight::MAX_PROJECT_BYTES / page_size as u64) as i64
        );
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
            "missing", "foreign", "corrupt", "future", "wal", "trigger", "payload",
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
        let mut connection = pool.acquire().await.unwrap();
        assert!(schema::migration_fixture(
            &mut connection,
            &[
                "CREATE TABLE added (id INTEGER)",
                "INSERT INTO missing VALUES (1)"
            ],
            2
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&mut *connection)
                .await
                .unwrap(),
            1
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE name='added'")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
        assert_eq!(count, 0);
        drop(connection);
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
        if role == "crash" {
            let pool = registered(&instances, &session.session_key).await;
            let mut connection = pool.acquire().await.unwrap();
            connection.execute("PRAGMA cache_size=1").await.unwrap();
            connection.execute("PRAGMA cache_spill=ON").await.unwrap();
            connection.execute("BEGIN IMMEDIATE").await.unwrap();
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
        sqlx::query("PRAGMA max_page_count=8")
            .execute(&pool)
            .await
            .unwrap();
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
