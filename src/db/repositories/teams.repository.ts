import { getDatabase, nowIso } from "../database";
import { Team } from "../types";

export type SaveTeamInput = {
  id?: number;
  name: string;
  lead_name?: string | null;
  description?: string | null;
};

export const teamsRepository = {
  async list() {
    const db = await getDatabase();
    return db.select<Team[]>("SELECT * FROM teams ORDER BY name");
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<Team[]>("SELECT * FROM teams WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveTeamInput) {
    const db = await getDatabase();
    const timestamp = nowIso();
    if (input.id) {
      await db.execute(
        "UPDATE teams SET name = $1, lead_name = $2, description = $3, updated_at = $4 WHERE id = $5",
        [input.name, input.lead_name ?? null, input.description ?? null, timestamp, input.id]
      );
      return input.id;
    }

    const result = await db.execute(
      "INSERT INTO teams (name, lead_name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
      [input.name, input.lead_name ?? null, input.description ?? null, timestamp, timestamp]
    );
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM teams WHERE id = $1", [id]);
  }
};

