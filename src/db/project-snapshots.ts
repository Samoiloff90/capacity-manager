import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { z } from "zod";
import { validateQuarterSnapshot } from "../domain/capacity/quarter-snapshot.validation";
import type { QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";

const PAYLOAD_VERSION = 1;
const sessionSchema = z.object({
  sessionKey: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  folderPath: z.string().min(1),
  schemaVersion: z.literal(1),
  sqliteVersion: z.string().min(1)
}).strict();
export type ProjectSession = z.infer<typeof sessionSchema>;

const rowSchema = z.object({
  plan_id: z.string().min(1),
  year: z.number().int(),
  quarter: z.number().int().min(1).max(4),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  payload_version: z.literal(PAYLOAD_VERSION),
  payload_json: z.string()
}).strict();

export interface StoredQuarterPlan {
  planId: string;
  revision: number;
  snapshot: QuarterSnapshot;
}

export class ProjectPersistenceError extends Error {
  constructor(public readonly code: "INVALID_DATA" | "CONFLICT" | "CLOSED" | "UNSAVED_CHANGES", message: string) {
    super(message);
    this.name = "ProjectPersistenceError";
  }
}

/** JSON-safe detached input: a queued write must not observe later edits by the caller. */
function checkedSnapshot(input: unknown): QuarterSnapshot {
  const validated = validateQuarterSnapshot(input);
  if (!validated.ok) {
    throw new ProjectPersistenceError("INVALID_DATA", "Данные квартала не прошли проверку.");
  }
  return JSON.parse(JSON.stringify(validated.snapshot)) as QuarterSnapshot;
}

function checkedId(id: string): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ProjectPersistenceError("INVALID_DATA", "Не указан идентификатор плана.");
  }
  return id;
}

function decodeRow(input: unknown): StoredQuarterPlan {
  const parsed = rowSchema.safeParse(input);
  if (!parsed.success) throw new ProjectPersistenceError("INVALID_DATA", "Неподдерживаемая или повреждённая запись квартала.");
  const row = parsed.data;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); }
  catch { throw new ProjectPersistenceError("INVALID_DATA", "Не удалось прочитать данные квартала."); }
  const snapshot = checkedSnapshot(payload);
  if (snapshot.year !== row.year || snapshot.quarter !== row.quarter) {
    throw new ProjectPersistenceError("INVALID_DATA", "Период в записи не совпадает с данными квартала.");
  }
  return { planId: row.plan_id, revision: row.revision, snapshot };
}

const columns = "plan_id, year, quarter, revision, payload_version, payload_json";

/** Uses only an already opened native session; never calls plugin load/close. */
export class ProjectSnapshots {
  readonly session: Readonly<ProjectSession>;
  private readonly database: Database;
  private tail: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private readonly failedWrites = new Set<string>();
  private closing: Promise<void> | null = null;

  constructor(session: ProjectSession) {
    this.session = Object.freeze(sessionSchema.parse(session));
    this.database = Database.get(this.session.sessionKey);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "open") return Promise.reject(new ProjectPersistenceError("CLOSED", "Проект закрыт или закрывается."));
    const pending = this.tail.then(operation);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private write<T>(planId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      try {
        const result = await operation();
        this.failedWrites.delete(planId);
        return result;
      } catch (error) {
        this.failedWrites.add(planId);
        throw error;
      }
    });
  }

  async list(): Promise<StoredQuarterPlan[]> {
    return this.enqueue(async () => {
      const rows = await this.database.select<unknown[]>(`SELECT ${columns} FROM quarter_plans ORDER BY year, quarter`);
      return rows.map(decodeRow);
    });
  }

  async get(planId: string): Promise<StoredQuarterPlan | null> {
    const id = checkedId(planId);
    return this.enqueue(async () => {
      const rows = await this.database.select<unknown[]>(`SELECT ${columns} FROM quarter_plans WHERE plan_id = $1`, [id]);
      if (rows.length > 1) throw new ProjectPersistenceError("INVALID_DATA", "Найдено несколько записей одного плана.");
      return rows.length === 0 ? null : decodeRow(rows[0]);
    });
  }

  async create(planId: string, input: unknown): Promise<StoredQuarterPlan> {
    const id = checkedId(planId);
    const snapshot = checkedSnapshot(input);
    const json = JSON.stringify(snapshot);
    return this.write(id, async () => {
      const result = await this.database.execute(
        "INSERT INTO quarter_plans (plan_id, year, quarter, revision, payload_version, payload_json) VALUES ($1, $2, $3, 1, $4, $5)",
        [id, snapshot.year, snapshot.quarter, PAYLOAD_VERSION, json]
      );
      if (result.rowsAffected !== 1) throw new ProjectPersistenceError("CONFLICT", "План не был создан.");
      return { planId: id, revision: 1, snapshot };
    });
  }

  async save(planId: string, expectedRevision: number, input: unknown): Promise<StoredQuarterPlan> {
    const id = checkedId(planId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new ProjectPersistenceError("INVALID_DATA", "Недопустимая ревизия плана.");
    }
    const snapshot = checkedSnapshot(input);
    const json = JSON.stringify(snapshot);
    return this.write(id, async () => {
      const result = await this.database.execute(
        "UPDATE quarter_plans SET payload_json = $1, revision = revision + 1 WHERE plan_id = $2 AND revision = $3 AND year = $4 AND quarter = $5 AND payload_version = $6",
        [json, id, expectedRevision, snapshot.year, snapshot.quarter, PAYLOAD_VERSION]
      );
      if (result.rowsAffected !== 1) {
        throw new ProjectPersistenceError("CONFLICT", "План изменился или недоступен. Откройте актуальную запись перед сохранением.");
      }
      return { planId: id, revision: expectedRevision + 1, snapshot };
    });
  }

  /**
   * The caller owns form dirty state, including edits never submitted and edits
   * rejected by validation before enqueue. This only guards accepted write attempts.
   * A resolved older save must not mark later form edits as saved.
   */
  close(options: { discardFailedWrites?: boolean } = {}): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    if (this.closing) return this.closing;
    this.state = "closing";
    this.closing = this.tail.then(async () => {
      if (this.failedWrites.size && !options.discardFailedWrites) {
        throw new ProjectPersistenceError("UNSAVED_CHANGES", "Есть изменения, которые не удалось сохранить.");
      }
      await invoke("project_close", { sessionKey: this.session.sessionKey });
      this.state = "closed";
    }).catch((error: unknown) => {
      this.state = "open";
      throw error;
    }).finally(() => { this.closing = null; });
    return this.closing;
  }
}

export async function createProject(folderPath: string, name: string): Promise<ProjectSnapshots> {
  return new ProjectSnapshots(sessionSchema.parse(await invoke("project_create", { folderPath, name })));
}

export async function openProject(folderPath: string): Promise<ProjectSnapshots> {
  return new ProjectSnapshots(sessionSchema.parse(await invoke("project_open", { folderPath })));
}
