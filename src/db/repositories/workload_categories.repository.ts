import { getDatabase } from "../database";
import { WorkloadCategory } from "../types";

export type SaveWorkloadCategoryInput = {
  id?: number;
  quarter_plan_id: number;
  name: string;
  percent: number;
  kind?: string;
  color?: string | null;
};

export const workloadCategoriesRepository = {
  async list(quarterPlanId: number) {
    const db = await getDatabase();
    return db.select<WorkloadCategory[]>(
      "SELECT * FROM workload_categories WHERE quarter_plan_id = $1 ORDER BY name",
      [quarterPlanId]
    );
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<WorkloadCategory[]>("SELECT * FROM workload_categories WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveWorkloadCategoryInput) {
    const db = await getDatabase();
    if (input.id) {
      await db.execute(
        "UPDATE workload_categories SET quarter_plan_id = $1, name = $2, percent = $3, kind = $4, color = $5 WHERE id = $6",
        [input.quarter_plan_id, input.name, input.percent, input.kind ?? "regular", input.color ?? null, input.id]
      );
      return input.id;
    }

    const result = await db.execute(
      "INSERT INTO workload_categories (quarter_plan_id, name, percent, kind, color) VALUES ($1, $2, $3, $4, $5)",
      [input.quarter_plan_id, input.name, input.percent, input.kind ?? "regular", input.color ?? null]
    );
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM workload_categories WHERE id = $1", [id]);
  }
};

