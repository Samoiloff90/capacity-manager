PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS competencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  competency_id INTEGER NOT NULL,
  role_type TEXT NOT NULL CHECK(role_type IN ('member', 'lead')),
  fte REAL NOT NULL DEFAULT 1.0,
  default_focus_factor REAL NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  start_date TEXT,
  end_date TEXT,
  FOREIGN KEY (competency_id) REFERENCES competencies(id)
);

CREATE TABLE IF NOT EXISTS calendar_months (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  working_days INTEGER NOT NULL,
  hours_per_day INTEGER NOT NULL DEFAULT 8,
  sprint_length_days INTEGER NOT NULL DEFAULT 10,
  UNIQUE(year, month)
);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('vacation', 'sick_leave', 'day_off', 'training', 'other')),
  comment TEXT,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS project_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('product', 'support', 'tech_debt', 'initiative', 'other')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS allocation_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allocation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  bucket_id INTEGER NOT NULL,
  share REAL NOT NULL CHECK(share >= 0 AND share <= 1),
  FOREIGN KEY (profile_id) REFERENCES allocation_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (bucket_id) REFERENCES project_buckets(id),
  UNIQUE(profile_id, bucket_id)
);

CREATE TABLE IF NOT EXISTS actual_work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_source TEXT,
  external_id TEXT,
  title TEXT NOT NULL,
  employee_id INTEGER,
  bucket_id INTEGER,
  competency_id INTEGER,
  work_date TEXT NOT NULL,
  spent_hours REAL NOT NULL DEFAULT 0,
  estimate_hours REAL,
  status TEXT,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (bucket_id) REFERENCES project_buckets(id),
  FOREIGN KEY (competency_id) REFERENCES competencies(id)
);

CREATE TABLE IF NOT EXISTS capacity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_month_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (calendar_month_id) REFERENCES calendar_months(id)
);

CREATE TABLE IF NOT EXISTS focus_factor_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  focus_factor REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

