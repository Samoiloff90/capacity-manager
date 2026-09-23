use super::*;
use crate::project_store::preflight::ScratchDirectory;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier,
    },
};

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Runtime::new().unwrap().block_on(future)
}

async fn connect(path: &Path) -> SqliteConnection {
    SqliteConnection::connect_with(&options(path).create_if_missing(true))
        .await
        .unwrap()
}

async fn history(path: &Path) -> Vec<(i64, Vec<u8>)> {
    let mut connection = connect(path).await;
    let result = sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    result
}

/// Exact logical rows, including every migration metadata field and BLOB. All
/// identifiers are read only from our own synthetic test database schema.
async fn dump(path: &Path) -> (Schema, BTreeMap<String, Vec<Vec<String>>>) {
    let mut connection = connect(path).await;
    let structure = schema(&mut connection).await.unwrap();
    let mut data = BTreeMap::new();
    for (_, name, _, _) in structure.iter().filter(|object| object.0 == "table") {
        let table = name.replace('"', "\"\"");
        let columns = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
            .fetch_all(&mut connection)
            .await
            .unwrap();
        let expressions: Vec<String> = columns
            .iter()
            .map(|row| {
                let name: String = row.get("name");
                format!("quote(\"{}\")", name.replace('"', "\"\""))
            })
            .collect();
        let rows = sqlx::query(&format!(
            "SELECT {} FROM \"{table}\" ORDER BY rowid",
            expressions.join(",")
        ))
        .fetch_all(&mut connection)
        .await
        .unwrap();
        data.insert(
            name.clone(),
            rows.into_iter()
                .map(|row| {
                    (0..expressions.len())
                        .map(|index| row.get::<String, _>(index))
                        .collect()
                })
                .collect(),
        );
    }
    connection.close().await.unwrap();
    (structure, data)
}

async fn initial_fixture(path: &Path, populated: bool) {
    let mut connection = connect(path).await;
    let mut migrations = pinned_migrations(INITIAL_SQL, CAPACITY_SQL).unwrap();
    migrations.truncate(1);
    migrate(&mut connection, migrations).await.unwrap();
    if populated {
        sqlx::raw_sql(
            "INSERT INTO competencies (id,code,name) VALUES (1,'test','Тестовая компетенция');
            INSERT INTO employees (id,full_name,competency_id,role_type,fte,default_focus_factor)
            VALUES (7,'Тестовый сотрудник',1,'member',0.75,0.7);
            INSERT INTO absences (id,employee_id,start_date,end_date,type,comment)
            VALUES (9,7,'2026-01-12','2026-01-13','training','Тестовое отсутствие');",
        )
        .execute(&mut connection)
        .await
        .unwrap();
    }
    connection.close().await.unwrap();
}

async fn populated_current(path: &Path) {
    initial_fixture(path, true).await;
    prepare(path).await.unwrap();
    let mut connection = connect(path).await;
    sqlx::raw_sql(
        "UPDATE teams SET name='Тестовая команда', lead_name='Тестовый руководитель';
        INSERT INTO quarter_plans (team_id,year,quarter,created_at,updated_at)
        VALUES (1,2026,2,'2026-01-01','2026-01-01');",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
}

#[test]
fn source_pins_prevent_aliasing_any_other_sql() {
    assert!(pinned_migrations(INITIAL_SQL, CAPACITY_SQL).is_ok());
    assert!(pinned_migrations("SELECT 1;", CAPACITY_SQL).is_err());
    assert!(pinned_migrations(INITIAL_SQL, "SELECT 1;").is_err());
}

#[test]
fn fresh_database_has_neutral_seed_and_new_checksum() {
    run(async {
        let directory = ScratchDirectory::new().unwrap();
        let path = directory.path().join("capacity.db");
        prepare(&path).await.unwrap();
        assert_eq!(
            history(&path).await,
            vec![(1, digest(INITIAL_LF)), (2, digest(SANITIZED_LF))]
        );
        let mut connection = connect(&path).await;
        let team: (String, Option<String>) = sqlx::query_as("SELECT name,lead_name FROM teams")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(team, ("Моя команда".into(), None));
        connection.close().await.unwrap();
        let before = dump(&path).await;
        prepare(&path).await.unwrap();
        assert_eq!(before, dump(&path).await);
    });
}

#[test]
fn fresh_schema_accepts_competency_and_person_repository_queries() {
    const INSERT_COMPETENCY: &str =
        "INSERT INTO competencies (code, name, sort_order, color) VALUES ($1, $2, $3, $4)";
    const UPDATE_COMPETENCY: &str =
        "UPDATE competencies SET name = $1, sort_order = $2, color = $3 WHERE id = $4";
    const INSERT_PERSON: &str = "INSERT INTO people (team_id, full_name, competency_id, fte, productive_ratio, active_from, active_to, is_active, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)";
    const SELECT_PERSON: &str = "SELECT * FROM people WHERE id = $1";
    let competencies = include_str!("../../../../src/db/repositories/competencies.repository.ts");
    let people = include_str!("../../../../src/db/repositories/people.repository.ts")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // Bind this SQLite/schema regression to the SQL used by the actual app.
    assert!(competencies.contains(INSERT_COMPETENCY));
    assert!(competencies.contains(UPDATE_COMPETENCY));
    assert!(people.contains(INSERT_PERSON));
    assert!(people.contains(SELECT_PERSON));
    run(async {
        let directory = ScratchDirectory::new().unwrap();
        let path = directory.path().join("capacity.db");
        prepare(&path).await.unwrap();
        let mut connection = connect(&path).await;
        let created = sqlx::query(INSERT_COMPETENCY)
            .bind("SA")
            .bind("SA")
            .bind(1_i64)
            .bind(None::<String>)
            .execute(&mut connection)
            .await
            .unwrap();
        let competency_id = created.last_insert_rowid();
        assert!(competency_id > 0);
        sqlx::query(UPDATE_COMPETENCY)
            .bind("Аналитика")
            .bind(1_i64)
            .bind(None::<String>)
            .bind(competency_id)
            .execute(&mut connection)
            .await
            .unwrap();
        let competency: (i64, String, String) =
            sqlx::query_as("SELECT id,code,name FROM competencies WHERE id=$1")
                .bind(competency_id)
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(competency, (competency_id, "SA".into(), "Аналитика".into()));
        let team_id: i64 = sqlx::query_scalar("SELECT id FROM teams ORDER BY id LIMIT 1")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let timestamp = "2026-09-23T00:00:00.000Z";
        let person = sqlx::query(INSERT_PERSON)
            .bind(team_id)
            .bind("Тестовый сотрудник")
            .bind(competency_id)
            .bind(0.75_f64)
            .bind(0.7_f64)
            .bind(None::<String>)
            .bind(None::<String>)
            .bind(1_i64)
            .bind(None::<String>)
            .bind(timestamp)
            .bind(timestamp)
            .execute(&mut connection)
            .await
            .unwrap();
        assert!(person.last_insert_rowid() > 0);
        let stored = sqlx::query(SELECT_PERSON)
            .bind(person.last_insert_rowid())
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(stored.get::<i64, _>("competency_id"), competency_id);
        assert_eq!(stored.get::<i64, _>("team_id"), team_id);
        assert_eq!(stored.get::<String, _>("full_name"), "Тестовый сотрудник");
        assert_eq!(stored.get::<f64, _>("fte"), 0.75);
        assert_eq!(stored.get::<f64, _>("productive_ratio"), 0.7);
        assert_eq!(stored.get::<i64, _>("is_active"), 1);
        for field in ["active_from", "active_to", "notes"] {
            assert_eq!(stored.get::<Option<String>, _>(field), None);
        }
        connection.close().await.unwrap();
    });
}

#[test]
fn populated_v1_migrates_without_losing_employee_or_absence() {
    run(async {
        let directory = ScratchDirectory::new().unwrap();
        let path = directory.path().join("capacity.db");
        initial_fixture(&path, true).await;
        let before = dump(&path).await;
        prepare(&path).await.unwrap();
        let mut connection = connect(&path).await;
        let person: (i64, String, f64) = sqlx::query_as("SELECT id,full_name,fte FROM people")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(person, (7, "Тестовый сотрудник".into(), 0.75));
        let absence: (i64, i64, String, String) =
            sqlx::query_as("SELECT id,person_id,type,comment FROM absences")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            absence,
            (9, 7, "education".into(), "Тестовое отсутствие".into())
        );
        connection.close().await.unwrap();
        let after = dump(&path).await;
        assert_eq!(before.1["employees"], after.1["employees"]);
        assert_eq!(before.1["absences"], after.1["legacy_absences"]);
        assert_eq!(
            before.1["_sqlx_migrations"][0],
            after.1["_sqlx_migrations"][0]
        );
        assert_eq!(history(&path).await[1].1, digest(SANITIZED_LF));
    });
}

#[test]
fn known_historical_lf_and_crlf_keep_all_data_and_metadata() {
    run(async {
        for (first, second) in [(INITIAL_LF, HISTORICAL_LF), (INITIAL_CRLF, HISTORICAL_CRLF)] {
            let directory = ScratchDirectory::new().unwrap();
            let path = directory.path().join("capacity.db");
            populated_current(&path).await;
            // Synthetic history only. The obsolete seed text is unnecessary.
            let mut connection = connect(&path).await;
            for (version, checksum) in [(1, first), (2, second)] {
                sqlx::query("UPDATE _sqlx_migrations SET checksum=? WHERE version=?")
                    .bind(digest(checksum))
                    .bind(version)
                    .execute(&mut connection)
                    .await
                    .unwrap();
            }
            connection.close().await.unwrap();
            let before = dump(&path).await;
            prepare(&path).await.unwrap();
            prepare(&path).await.unwrap();
            assert_eq!(before, dump(&path).await);
            assert_eq!(
                history(&path).await,
                vec![(1, digest(first)), (2, digest(second))]
            );
        }
    });
}

#[test]
fn incompatible_history_and_schema_are_rejected_before_any_write() {
    run(async {
        for statement in [
            "DELETE FROM _sqlx_migrations WHERE version=1",
            "UPDATE _sqlx_migrations SET checksum=zeroblob(48) WHERE version=1",
            "UPDATE _sqlx_migrations SET checksum=zeroblob(48) WHERE version=2",
            "UPDATE _sqlx_migrations SET success=0 WHERE version=1",
            "UPDATE _sqlx_migrations SET success=0 WHERE version=2",
            "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(3,'future',1,zeroblob(48),0)",
            "CREATE TABLE unexpected(value TEXT)",
            "CREATE TRIGGER unexpected AFTER UPDATE ON _sqlx_migrations BEGIN DELETE FROM people; END",
        ] {
            let directory = ScratchDirectory::new().unwrap();
            let path = directory.path().join("capacity.db");
            populated_current(&path).await;
            let mut connection = connect(&path).await;
            sqlx::raw_sql(statement).execute(&mut connection).await.unwrap();
            connection.close().await.unwrap();
            let before = std::fs::read(&path).unwrap();
            assert!(prepare(&path).await.is_err(), "{statement}");
            assert_eq!(before, std::fs::read(&path).unwrap(), "{statement}");
        }
    });
}

#[test]
fn foreign_and_corrupt_database_are_not_adopted() {
    run(async {
        for corrupt in [false, true] {
            let directory = ScratchDirectory::new().unwrap();
            let path = directory.path().join("capacity.db");
            if corrupt {
                std::fs::write(&path, b"not a database").unwrap();
            } else {
                let mut connection = connect(&path).await;
                sqlx::query("CREATE TABLE foreign_data(value TEXT)")
                    .execute(&mut connection)
                    .await
                    .unwrap();
                connection.close().await.unwrap();
            }
            let before = std::fs::read(&path).unwrap();
            assert!(prepare(&path).await.is_err());
            assert_eq!(before, std::fs::read(&path).unwrap());
        }
    });
}

#[test]
fn migration_failure_rolls_back_ddl_data_and_history() {
    run(async {
        let directory = ScratchDirectory::new().unwrap();
        let path = directory.path().join("capacity.db");
        initial_fixture(&path, false).await;
        let mut connection = connect(&path).await;
        sqlx::raw_sql(
            "PRAGMA foreign_keys=OFF;
            INSERT INTO employees(full_name,competency_id,role_type,default_focus_factor)
            VALUES('Тестовый сотрудник',999,'member',0.7);",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();
        let before = dump(&path).await;
        assert!(prepare(&path).await.is_err());
        assert_eq!(before, dump(&path).await);
    });
}

#[test]
fn concurrent_startup_serializes_fresh_and_v1_migrations() {
    for version_one in [false, true] {
        let directory = ScratchDirectory::new().unwrap();
        let path = directory.path().join("capacity.db");
        if version_one {
            run(initial_fixture(&path, true));
        }
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    run(prepare(&path))
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(
            run(history(&path)),
            vec![(1, digest(INITIAL_LF)), (2, digest(SANITIZED_LF))]
        );
    }
}

#[test]
fn plugin_waits_for_close_and_stops_later_setup_on_failure() {
    for invalid_database in [false, true] {
        let directory = ScratchDirectory::new().unwrap();
        let path = directory.path().join("capacity.db");
        if invalid_database {
            std::fs::write(&path, b"invalid").unwrap();
        }
        let prepared_path = path.clone();
        let observed = Arc::new(AtomicBool::new(false));
        let next_observed = observed.clone();
        let app = tauri::test::mock_builder()
            .plugin(init_with_path(move |_| Ok(prepared_path)))
            .plugin(
                tauri::plugin::Builder::<tauri::test::MockRuntime>::new("preload-observer")
                    .setup(move |_, _| {
                        // Windows refuses this move while SQLite still owns the
                        // physical file handle; this also verifies setup ordering.
                        let moved = path.with_extension("closed");
                        std::fs::rename(&path, &moved)?;
                        std::fs::rename(&moved, &path)?;
                        next_observed.store(true, Ordering::SeqCst);
                        Ok(())
                    })
                    .build(),
            )
            .build(tauri::test::mock_context(tauri::test::noop_assets()));
        assert_eq!(app.is_err(), invalid_database);
        assert_eq!(observed.load(Ordering::SeqCst), !invalid_database);
    }
}
