import { getDatabase } from "../database";
import { Competency } from "../types";

export type SaveCompetencyInput = {
  id?: number;
  name: string;
  // Used only when creating a competency; renaming keeps its stored code.
  code?: string;
  sort_order?: number;
  color?: string | null;
};

type StoredCompetency = Competency & { code: string };

export const competenciesRepository = {
  async list() {
    const db = await getDatabase();
    return db.select<StoredCompetency[]>("SELECT * FROM competencies ORDER BY sort_order, name");
  },

  async getById(id: number) {
    const db = await getDatabase();
    const rows = await db.select<StoredCompetency[]>("SELECT * FROM competencies WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async save(input: SaveCompetencyInput) {
    const db = await getDatabase();
    if (input.id) {
      await db.execute("UPDATE competencies SET name = $1, sort_order = $2, color = $3 WHERE id = $4", [
        input.name,
        input.sort_order ?? 0,
        input.color ?? null,
        input.id
      ]);
      return input.id;
    }

    const code = (input.code ?? input.name).trim();
    if (!code) throw new Error("Укажите непустой код компетенции");
    const result = await db.execute("INSERT INTO competencies (code, name, sort_order, color) VALUES ($1, $2, $3, $4)", [
      code,
      input.name,
      input.sort_order ?? 0,
      input.color ?? null
    ]);
    return Number(result.lastInsertId);
  },

  async remove(id: number) {
    const db = await getDatabase();
    await db.execute("DELETE FROM competencies WHERE id = $1", [id]);
  }
};
