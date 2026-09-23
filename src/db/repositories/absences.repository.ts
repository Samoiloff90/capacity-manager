import { getDatabase, nowIso } from "../database";
import { Absence, AbsenceType } from "../types";

export type SaveAbsenceInput = {
  id?: number;
  person_id: number;
  type: AbsenceType;
  start_date: string;
  end_date: string;
  comment?: string | null;
};

export const absencesRepository = {
  async list(personId?: number) {
    const db = await getDatabase();
    if (personId) {
      return db.select<Absence[]>("SELECT * FROM absences WHERE person_id = $1 ORDER BY start_date DESC", [personId]);
    }
    return db.select<Absence[]>("SELECT * FROM absences ORDER BY start_date DESC");
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<Absence[]>("SELECT * FROM absences WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveAbsenceInput) {
    const db = await getDatabase();
    const timestamp = nowIso();
    if (input.id) {
      await db.execute(
        `UPDATE absences
         SET person_id = $1, type = $2, start_date = $3, end_date = $4, comment = $5, updated_at = $6
         WHERE id = $7`,
        [input.person_id, input.type, input.start_date, input.end_date, input.comment ?? null, timestamp, input.id]
      );
      return input.id;
    }

    const result = await db.execute(
      `INSERT INTO absences (person_id, type, start_date, end_date, comment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.person_id, input.type, input.start_date, input.end_date, input.comment ?? null, timestamp, timestamp]
    );
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM absences WHERE id = $1", [id]);
  }
};

