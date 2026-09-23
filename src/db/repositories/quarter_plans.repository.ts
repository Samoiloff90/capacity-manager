import { getDatabase, nowIso } from "../database";
import { QuarterPlan } from "../types";

export type SaveQuarterPlanInput = {
  id?: number;
  team_id: number;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  hours_per_day: number;
  days_per_sprint: number;
};

export const quarterPlansRepository = {
  async list(teamId?: number) {
    const db = await getDatabase();
    if (teamId) {
      return db.select<QuarterPlan[]>(
        "SELECT * FROM quarter_plans WHERE team_id = $1 ORDER BY year DESC, quarter DESC",
        [teamId]
      );
    }
    return db.select<QuarterPlan[]>("SELECT * FROM quarter_plans ORDER BY year DESC, quarter DESC");
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<QuarterPlan[]>("SELECT * FROM quarter_plans WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveQuarterPlanInput) {
    const db = await getDatabase();
    const timestamp = nowIso();
    if (input.id) {
      await db.execute(
        `UPDATE quarter_plans
         SET team_id = $1, year = $2, quarter = $3, hours_per_day = $4, days_per_sprint = $5, updated_at = $6
         WHERE id = $7`,
        [input.team_id, input.year, input.quarter, input.hours_per_day, input.days_per_sprint, timestamp, input.id]
      );
      return input.id;
    }

    const result = await db.execute(
      `INSERT INTO quarter_plans
       (team_id, year, quarter, hours_per_day, days_per_sprint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.team_id, input.year, input.quarter, input.hours_per_day, input.days_per_sprint, timestamp, timestamp]
    );
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM quarter_plans WHERE id = $1", [id]);
  }
};

