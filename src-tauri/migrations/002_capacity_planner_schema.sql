PRAGMA foreign_keys = OFF;

ALTER TABLE competencies ADD COLUMN color TEXT;

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lead_name TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  competency_id INTEGER NOT NULL,
  fte REAL NOT NULL DEFAULT 1,
  productive_ratio REAL NOT NULL DEFAULT 0.7,
  active_from TEXT,
  active_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id),
  FOREIGN KEY (competency_id) REFERENCES competencies(id)
);

INSERT INTO teams (name, lead_name, description, created_at, updated_at)
SELECT 'Моя команда', NULL, 'Команда разработки', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM teams);

INSERT OR IGNORE INTO people
  (id, team_id, full_name, competency_id, fte, productive_ratio, active_from, active_to, is_active, notes, created_at, updated_at)
SELECT
  e.id,
  (SELECT id FROM teams ORDER BY id LIMIT 1),
  e.full_name,
  e.competency_id,
  e.fte,
  e.default_focus_factor,
  e.start_date,
  e.end_date,
  e.is_active,
  NULL,
  datetime('now'),
  datetime('now')
FROM employees e;

CREATE TABLE IF NOT EXISTS quarter_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  quarter INTEGER NOT NULL CHECK(quarter IN (1, 2, 3, 4)),
  hours_per_day REAL NOT NULL DEFAULT 8,
  days_per_sprint REAL NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id),
  UNIQUE(team_id, year, quarter)
);

CREATE TABLE IF NOT EXISTS quarter_months (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quarter_plan_id INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK(month >= 1 AND month <= 12),
  month_name TEXT NOT NULL,
  working_days INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (quarter_plan_id) REFERENCES quarter_plans(id) ON DELETE CASCADE,
  UNIQUE(quarter_plan_id, month)
);

CREATE TABLE IF NOT EXISTS monthly_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quarter_plan_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK(month >= 1 AND month <= 12),
  available_days REAL,
  productive_ratio REAL,
  reason TEXT,
  FOREIGN KEY (quarter_plan_id) REFERENCES quarter_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  UNIQUE(quarter_plan_id, person_id, month)
);

ALTER TABLE absences RENAME TO legacy_absences;

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('vacation', 'sick_leave', 'day_off', 'business_trip', 'education', 'other')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO absences
  (id, person_id, type, start_date, end_date, comment, created_at, updated_at)
SELECT
  la.id,
  la.employee_id,
  CASE la.type
    WHEN 'training' THEN 'education'
    ELSE la.type
  END,
  la.start_date,
  la.end_date,
  la.comment,
  datetime('now'),
  datetime('now')
FROM legacy_absences la
WHERE EXISTS (SELECT 1 FROM people p WHERE p.id = la.employee_id);

CREATE TABLE IF NOT EXISTS workload_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quarter_plan_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  percent REAL NOT NULL CHECK(percent >= 0),
  kind TEXT NOT NULL DEFAULT 'regular',
  color TEXT,
  FOREIGN KEY (quarter_plan_id) REFERENCES quarter_plans(id) ON DELETE CASCADE,
  UNIQUE(quarter_plan_id, name)
);

CREATE TABLE IF NOT EXISTS actual_work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  title TEXT,
  assignee_name TEXT,
  person_id INTEGER,
  bucket_name TEXT,
  workload_category_id INTEGER,
  competency_name TEXT,
  competency_id INTEGER,
  work_date TEXT NOT NULL,
  spent_hours REAL,
  estimate_hours REAL,
  status TEXT,
  imported_at TEXT NOT NULL,
  FOREIGN KEY (person_id) REFERENCES people(id),
  FOREIGN KEY (workload_category_id) REFERENCES workload_categories(id),
  FOREIGN KEY (competency_id) REFERENCES competencies(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_actual_work_dedupe
ON actual_work (
  COALESCE(external_id, ''),
  COALESCE(assignee_name, ''),
  work_date,
  COALESCE(spent_hours, 0)
);

PRAGMA foreign_keys = ON;
