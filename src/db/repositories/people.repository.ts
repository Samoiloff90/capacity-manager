import { getDatabase, nowIso } from "../database";
import { Person } from "../types";

export type SavePersonInput = {
  id?: number;
  team_id: number;
  full_name: string;
  competency_id: number;
  fte: number;
  productive_ratio: number;
  active_from?: string | null;
  active_to?: string | null;
  is_active?: number;
  notes?: string | null;
};

export const peopleRepository = {
  async list(teamId?: number) {
    const db = await getDatabase();
    if (teamId) {
      return db.select<Person[]>("SELECT * FROM people WHERE team_id = $1 ORDER BY is_active DESC, full_name", [teamId]);
    }
    return db.select<Person[]>("SELECT * FROM people ORDER BY is_active DESC, full_name");
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<Person[]>("SELECT * FROM people WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SavePersonInput) {
    const db = await getDatabase();
    const timestamp = nowIso();
    if (input.id) {
      await db.execute(
        `UPDATE people
         SET team_id = $1, full_name = $2, competency_id = $3, fte = $4, productive_ratio = $5,
             active_from = $6, active_to = $7, is_active = $8, notes = $9, updated_at = $10
         WHERE id = $11`,
        [
          input.team_id,
          input.full_name,
          input.competency_id,
          input.fte,
          input.productive_ratio,
          input.active_from ?? null,
          input.active_to ?? null,
          input.is_active ?? 1,
          input.notes ?? null,
          timestamp,
          input.id
        ]
      );
      return input.id;
    }

    const result = await db.execute(
      `INSERT INTO people
       (team_id, full_name, competency_id, fte, productive_ratio, active_from, active_to, is_active, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.team_id,
        input.full_name,
        input.competency_id,
        input.fte,
        input.productive_ratio,
        input.active_from ?? null,
        input.active_to ?? null,
        input.is_active ?? 1,
        input.notes ?? null,
        timestamp,
        timestamp
      ]
    );
    return Number(result.lastInsertId);
  },

  async deactivate(id: number, activeTo = nowIso().slice(0, 10)) {
    const db = await getDatabase();
    await db.execute("UPDATE people SET is_active = 0, active_to = $1, updated_at = $2 WHERE id = $3", [
      activeTo,
      nowIso(),
      id
    ]);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM people WHERE id = $1", [id]);
  }
};

