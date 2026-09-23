import Database from "@tauri-apps/plugin-sql";
import {
  Absence,
  ActualWorkItem,
  AllocationItem,
  AllocationProfile,
  BucketType,
  CalendarMonth,
  CapacityDataSource,
  Competency,
  DEFAULT_LEAD_FOCUS_FACTOR,
  DEFAULT_MEMBER_FOCUS_FACTOR,
  Employee,
  ProjectBucket,
  RoleType
} from "./types";
import { monthBounds } from "./date";

let dbPromise: Promise<Database> | null = null;

export function getDb() {
  dbPromise ??= Database.load("sqlite:capacity.db");
  return dbPromise;
}

export class SqliteCapacityRepository implements CapacityDataSource {
  async getCalendarMonths() {
    const db = await getDb();
    return db.select<CalendarMonth[]>("SELECT * FROM calendar_months ORDER BY year DESC, month DESC");
  }

  async getCalendarMonth(monthId: number) {
    const db = await getDb();
    const rows = await db.select<CalendarMonth[]>("SELECT * FROM calendar_months WHERE id = $1", [monthId]);
    return rows[0] ?? null;
  }

  async upsertCalendarMonth(input: Omit<CalendarMonth, "id"> & { id?: number }) {
    const db = await getDb();
    if (input.id) {
      await db.execute(
        "UPDATE calendar_months SET year = $1, month = $2, working_days = $3, hours_per_day = $4, sprint_length_days = $5 WHERE id = $6",
        [input.year, input.month, input.working_days, input.hours_per_day, input.sprint_length_days, input.id]
      );
      return input.id;
    }
    const result = await db.execute(
      "INSERT INTO calendar_months (year, month, working_days, hours_per_day, sprint_length_days) VALUES ($1, $2, $3, $4, $5)",
      [input.year, input.month, input.working_days, input.hours_per_day, input.sprint_length_days]
    );
    return Number(result.lastInsertId);
  }

  async getCompetencies() {
    const db = await getDb();
    return db.select<Competency[]>("SELECT * FROM competencies ORDER BY sort_order, code");
  }

  async addCompetency(code: string, name = code) {
    const db = await getDb();
    await db.execute("INSERT INTO competencies (code, name, sort_order) VALUES ($1, $2, 100)", [code.trim(), name.trim()]);
  }

  async getActiveEmployees() {
    const db = await getDb();
    return db.select<Employee[]>(
      `SELECT e.*, c.code AS competency_code
       FROM employees e
       LEFT JOIN competencies c ON c.id = e.competency_id
       WHERE e.is_active = 1
       ORDER BY e.full_name`
    );
  }

  async getEmployees() {
    const db = await getDb();
    return db.select<Employee[]>(
      `SELECT e.*, c.code AS competency_code
       FROM employees e
       LEFT JOIN competencies c ON c.id = e.competency_id
       ORDER BY e.is_active DESC, e.full_name`
    );
  }

  async saveEmployee(input: {
    id?: number;
    full_name: string;
    competency_id: number;
    role_type: RoleType;
    fte: number;
    default_focus_factor?: number;
  }) {
    const db = await getDb();
    const focus = input.default_focus_factor ?? (input.role_type === "lead" ? DEFAULT_LEAD_FOCUS_FACTOR : DEFAULT_MEMBER_FOCUS_FACTOR);
    if (input.id) {
      await db.execute(
        "UPDATE employees SET full_name = $1, competency_id = $2, role_type = $3, fte = $4, default_focus_factor = $5 WHERE id = $6",
        [input.full_name, input.competency_id, input.role_type, input.fte, focus, input.id]
      );
      return input.id;
    }
    const result = await db.execute(
      "INSERT INTO employees (full_name, competency_id, role_type, fte, default_focus_factor) VALUES ($1, $2, $3, $4, $5)",
      [input.full_name, input.competency_id, input.role_type, input.fte, focus]
    );
    return Number(result.lastInsertId);
  }

  async deactivateEmployee(id: number) {
    const db = await getDb();
    await db.execute("UPDATE employees SET is_active = 0, end_date = date('now') WHERE id = $1", [id]);
  }

  async getAbsencesForMonth(year: number, month: number) {
    const db = await getDb();
    const { startIso, endIso } = monthBounds(year, month);
    return db.select<Absence[]>(
      `SELECT a.*, e.full_name AS employee_name
       FROM absences a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.start_date <= $1 AND a.end_date >= $2
       ORDER BY a.start_date DESC`,
      [endIso, startIso]
    );
  }

  async getAbsences() {
    const db = await getDb();
    return db.select<Absence[]>(
      `SELECT a.*, e.full_name AS employee_name
       FROM absences a
       JOIN employees e ON e.id = a.employee_id
       ORDER BY a.start_date DESC`
    );
  }

  async addAbsence(input: Omit<Absence, "id" | "employee_name">) {
    const db = await getDb();
    await db.execute(
      "INSERT INTO absences (employee_id, start_date, end_date, type, comment) VALUES ($1, $2, $3, $4, $5)",
      [input.employee_id, input.start_date, input.end_date, input.type, input.comment ?? null]
    );
  }

  async getBuckets() {
    const db = await getDb();
    return db.select<ProjectBucket[]>("SELECT * FROM project_buckets ORDER BY is_active DESC, name");
  }

  async upsertBucket(input: { id?: number; name: string; type: BucketType; is_active?: number }) {
    const db = await getDb();
    if (input.id) {
      await db.execute("UPDATE project_buckets SET name = $1, type = $2, is_active = $3 WHERE id = $4", [
        input.name,
        input.type,
        input.is_active ?? 1,
        input.id
      ]);
      return input.id;
    }
    const result = await db.execute("INSERT INTO project_buckets (name, type) VALUES ($1, $2)", [input.name, input.type]);
    return Number(result.lastInsertId);
  }

  async getActiveAllocationProfile(month: CalendarMonth) {
    const db = await getDb();
    const monthDate = `${month.year}-${String(month.month).padStart(2, "0")}-01`;
    const rows = await db.select<AllocationProfile[]>(
      `SELECT * FROM allocation_profiles
       WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1)
       ORDER BY valid_from DESC, id DESC
       LIMIT 1`,
      [monthDate]
    );
    return rows[0] ?? null;
  }

  async getAllocationProfiles() {
    const db = await getDb();
    return db.select<AllocationProfile[]>("SELECT * FROM allocation_profiles ORDER BY valid_from DESC, id DESC");
  }

  async getAllocationItems(profileId: number) {
    const db = await getDb();
    return db.select<AllocationItem[]>(
      `SELECT ai.*, b.name AS bucket_name
       FROM allocation_items ai
       JOIN project_buckets b ON b.id = ai.bucket_id
       WHERE ai.profile_id = $1
       ORDER BY b.name`,
      [profileId]
    );
  }

  async saveAllocationProfile(input: {
    name: string;
    valid_from: string;
    valid_to?: string | null;
    items: Array<{ bucket_id: number; share: number }>;
  }) {
    const shareSum = input.items.reduce((sum, item) => sum + item.share, 0);
    if (Math.abs(shareSum - 1) > 0.0001) {
      throw new Error(`Allocation must equal 100%, current value is ${(shareSum * 100).toFixed(2)}%`);
    }
    const db = await getDb();
    const result = await db.execute(
      "INSERT INTO allocation_profiles (name, valid_from, valid_to, created_at) VALUES ($1, $2, $3, datetime('now'))",
      [input.name, input.valid_from, input.valid_to ?? null]
    );
    const profileId = Number(result.lastInsertId);
    for (const item of input.items) {
      await db.execute("INSERT INTO allocation_items (profile_id, bucket_id, share) VALUES ($1, $2, $3)", [
        profileId,
        item.bucket_id,
        item.share
      ]);
    }
    return profileId;
  }

  async getActualWorkForMonth(year: number, month: number) {
    const db = await getDb();
    const { startIso, endIso } = monthBounds(year, month);
    return db.select<ActualWorkItem[]>(
      `SELECT aw.*, e.full_name AS employee_name, b.name AS bucket_name, c.code AS competency_code
       FROM actual_work_items aw
       LEFT JOIN employees e ON e.id = aw.employee_id
       LEFT JOIN project_buckets b ON b.id = aw.bucket_id
       LEFT JOIN competencies c ON c.id = aw.competency_id
       WHERE aw.work_date BETWEEN $1 AND $2
       ORDER BY aw.work_date DESC`,
      [startIso, endIso]
    );
  }

  async insertActualWork(items: Array<Omit<ActualWorkItem, "id">>) {
    const db = await getDb();
    for (const item of items) {
      await db.execute(
        `INSERT INTO actual_work_items
         (external_source, external_id, title, employee_id, bucket_id, competency_id, work_date, spent_hours, estimate_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          item.external_source ?? "csv",
          item.external_id ?? null,
          item.title,
          item.employee_id ?? null,
          item.bucket_id ?? null,
          item.competency_id ?? null,
          item.work_date,
          item.spent_hours,
          item.estimate_hours ?? null,
          item.status ?? null
        ]
      );
    }
  }
}

export const repository = new SqliteCapacityRepository();
