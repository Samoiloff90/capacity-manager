import { getDatabase } from "../database";
import { QuarterMonth } from "../types";

export type SaveQuarterMonthInput = {
  id?: number;
  quarter_plan_id: number;
  month: number;
  month_name: string;
  working_days: number;
};

export const quarterMonthsRepository = {
  async list(quarterPlanId: number) {
    const db = await getDatabase();
    return db.select<QuarterMonth[]>("SELECT * FROM quarter_months WHERE quarter_plan_id = $1 ORDER BY month", [
      quarterPlanId
    ]);
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<QuarterMonth[]>("SELECT * FROM quarter_months WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveQuarterMonthInput) {
    const db = await getDatabase();
    if (input.id) {
      await db.execute(
        "UPDATE quarter_months SET quarter_plan_id = $1, month = $2, month_name = $3, working_days = $4 WHERE id = $5",
        [input.quarter_plan_id, input.month, input.month_name, input.working_days, input.id]
      );
      return input.id;
    }

    const result = await db.execute(
      "INSERT INTO quarter_months (quarter_plan_id, month, month_name, working_days) VALUES ($1, $2, $3, $4)",
      [input.quarter_plan_id, input.month, input.month_name, input.working_days]
    );
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM quarter_months WHERE id = $1", [id]);
  }
};

