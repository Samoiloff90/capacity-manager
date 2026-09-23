import { getDatabase, nowIso } from "../database";
import { ActualWork } from "../types";

export type SaveActualWorkInput = {
  id?: number;
  external_id?: string | null;
  title?: string | null;
  assignee_name?: string | null;
  person_id?: number | null;
  bucket_name?: string | null;
  workload_category_id?: number | null;
  competency_name?: string | null;
  competency_id?: number | null;
  work_date: string;
  spent_hours?: number | null;
  estimate_hours?: number | null;
  status?: string | null;
  imported_at?: string;
};

export const actualWorkRepository = {
  async listByDateRange(startDate: string, endDate: string) {
    const db = await getDatabase();
    return db.select<ActualWork[]>("SELECT * FROM actual_work WHERE work_date BETWEEN $1 AND $2 ORDER BY work_date DESC", [
      startDate,
      endDate
    ]);
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<ActualWork[]>("SELECT * FROM actual_work WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveActualWorkInput) {
    const db = await getDatabase();
    if (input.id) {
      await db.execute(
        `UPDATE actual_work
         SET external_id = $1, title = $2, assignee_name = $3, person_id = $4, bucket_name = $5,
             workload_category_id = $6, competency_name = $7, competency_id = $8, work_date = $9,
             spent_hours = $10, estimate_hours = $11, status = $12, imported_at = $13
         WHERE id = $14`,
        [
          input.external_id ?? null,
          input.title ?? null,
          input.assignee_name ?? null,
          input.person_id ?? null,
          input.bucket_name ?? null,
          input.workload_category_id ?? null,
          input.competency_name ?? null,
          input.competency_id ?? null,
          input.work_date,
          input.spent_hours ?? null,
          input.estimate_hours ?? null,
          input.status ?? null,
          input.imported_at ?? nowIso(),
          input.id
        ]
      );
      return input.id;
    }

    const result = await db.execute(
      `INSERT INTO actual_work
       (external_id, title, assignee_name, person_id, bucket_name, workload_category_id, competency_name, competency_id,
        work_date, spent_hours, estimate_hours, status, imported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.external_id ?? null,
        input.title ?? null,
        input.assignee_name ?? null,
        input.person_id ?? null,
        input.bucket_name ?? null,
        input.workload_category_id ?? null,
        input.competency_name ?? null,
        input.competency_id ?? null,
        input.work_date,
        input.spent_hours ?? null,
        input.estimate_hours ?? null,
        input.status ?? null,
        input.imported_at ?? nowIso()
      ]
    );
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM actual_work WHERE id = $1", [id]);
  }
};

