import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { z } from "zod";
import { QUARTER_PAYLOAD_VERSION, readStoredQuarterSnapshot } from "../domain/capacity/quarter-snapshot-format";
import { validateQuarterSnapshot } from "../domain/capacity/quarter-snapshot.validation";
import type { QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";

/** Project file format 1 (0.1.0–0.3.0) is read as is; the first save upgrades it to 2 (DEC-044). */
export const PROJECT_SCHEMA_VERSION = 2;
const sessionSchema = z.object({
  sessionKey: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  folderPath: z.string().min(1),
  schemaVersion: z.union([z.literal(1), z.literal(PROJECT_SCHEMA_VERSION)]),
  sqliteVersion: z.string().min(1)
}).strict();
export type ProjectSession = z.infer<typeof sessionSchema>;

const upgradeSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  backupPath: z.string().min(1).nullable()
}).strict();
export type FormatUpgrade = z.infer<typeof upgradeSchema>;

const rowSchema = z.object({
  plan_id: z.string().min(1),
  year: z.number().int(),
  quarter: z.number().int().min(1).max(4),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  payload_version: z.union([z.literal(1), z.literal(QUARTER_PAYLOAD_VERSION)]),
  payload_json: z.string()
}).strict();

export interface StoredQuarterPlan {
  planId: string;
  revision: number;
  /** Format of the stored JSON: 1 until this quarter is saved by this version. */
  payloadVersion: 1 | 2;
  snapshot: QuarterSnapshot;
}

export class ProjectPersistenceError extends Error {
  constructor(public readonly code: "INVALID_DATA" | "CONFLICT" | "CLOSED" | "UNSAVED_CHANGES" | "FORMAT_UPGRADE_REQUIRED", message: string) {
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

/** A quarter of format 1 is converted in memory; its stored JSON stays as it was. */
function decodeRow(input: unknown): StoredQuarterPlan {
  const parsed = rowSchema.safeParse(input);
  if (!parsed.success) throw new ProjectPersistenceError("INVALID_DATA", "Неподдерживаемая или повреждённая запись квартала.");
  const row = parsed.data;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); }
  catch { throw new ProjectPersistenceError("INVALID_DATA", "Не удалось прочитать данные квартала."); }
  const read = readStoredQuarterSnapshot(row.payload_version, payload);
  if (!read.ok) throw new ProjectPersistenceError("INVALID_DATA", "Данные квартала не прошли проверку.");
  const snapshot = JSON.parse(JSON.stringify(read.snapshot)) as QuarterSnapshot;
  if (snapshot.year !== row.year || snapshot.quarter !== row.quarter) {
    throw new ProjectPersistenceError("INVALID_DATA", "Период в записи не совпадает с данными квартала.");
  }
  return { planId: row.plan_id, revision: row.revision, payloadVersion: row.payload_version, snapshot };
}

const columns = "plan_id, year, quarter, revision, payload_version, payload_json";

/** Uses only an already opened native session; never calls plugin load/close. */
export class ProjectSnapshots {
  private currentSession: Readonly<ProjectSession>;
  get session(): Readonly<ProjectSession> { return this.currentSession; }
  private readonly database: Database;
  private tail: Promise<void> = Promise.resolve();
  private state: "open" | "closing" | "closed" = "open";
  private readonly failedWrites = new Set<string>();
  private closing: Promise<void> | null = null;

  constructor(session: ProjectSession) {
    this.currentSession = Object.freeze(sessionSchema.parse(session));
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

  /** Quarters are written only in format 2, so a format-1 file must be upgraded first. */
  private requireCurrentFormat(): void {
    if (this.session.schemaVersion !== PROJECT_SCHEMA_VERSION) {
      throw new ProjectPersistenceError("FORMAT_UPGRADE_REQUIRED", "Сначала нужно обновить формат проекта.");
    }
  }

  async list(): Promise<StoredQuarterPlan[]> {
    return this.enqueue(async () => {
      const rows = await this.database.select<unknown[]>(`SELECT ${columns} FROM quarter_plans ORDER BY year, quarter`);
      return rows.map(decodeRow);
    });
  }

  async rename(name: string): Promise<Readonly<ProjectSession>> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 1000) {
      throw new ProjectPersistenceError("INVALID_DATA", "Название команды должно содержать от 1 до 1000 символов.");
    }
    return this.write("project-name", async () => {
      const result = await this.database.execute(
        "UPDATE project_meta SET name = $1 WHERE singleton = 1 AND project_id = $2",
        [trimmed, this.session.projectId]
      );
      if (result.rowsAffected !== 1) throw new ProjectPersistenceError("CONFLICT", "Не удалось изменить название команды.");
      this.currentSession = Object.freeze({ ...this.session, name: trimmed });
      return this.session;
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

  /**
   * Format 1 → 2 by the native store: a verified backup next to the project, then one transaction.
   * Quarter rows keep their JSON; each becomes format 2 when it is saved.
   */
  async upgradeFormat(): Promise<FormatUpgrade> {
    return this.enqueue(async () => {
      const upgrade = upgradeSchema.parse(await invoke("project_upgrade_format", { sessionKey: this.session.sessionKey }));
      this.currentSession = Object.freeze({ ...this.session, schemaVersion: upgrade.schemaVersion });
      return upgrade;
    });
  }

  async create(planId: string, input: unknown): Promise<StoredQuarterPlan> {
    const id = checkedId(planId);
    const snapshot = checkedSnapshot(input);
    const json = JSON.stringify(snapshot);
    return this.write(id, async () => {
      this.requireCurrentFormat();
      const result = await this.database.execute(
        "INSERT INTO quarter_plans (plan_id, year, quarter, revision, payload_version, payload_json) VALUES ($1, $2, $3, 1, $4, $5)",
        [id, snapshot.year, snapshot.quarter, QUARTER_PAYLOAD_VERSION, json]
      );
      if (result.rowsAffected !== 1) throw new ProjectPersistenceError("CONFLICT", "План не был создан.");
      return { planId: id, revision: 1, payloadVersion: QUARTER_PAYLOAD_VERSION, snapshot };
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
      this.requireCurrentFormat();
      const result = await this.database.execute(
        "UPDATE quarter_plans SET payload_json = $1, payload_version = $6, revision = revision + 1 WHERE plan_id = $2 AND revision = $3 AND year = $4 AND quarter = $5",
        [json, id, expectedRevision, snapshot.year, snapshot.quarter, QUARTER_PAYLOAD_VERSION]
      );
      if (result.rowsAffected !== 1) {
        throw new ProjectPersistenceError("CONFLICT", "План изменился или недоступен. Откройте актуальную запись перед сохранением.");
      }
      return { planId: id, revision: expectedRevision + 1, payloadVersion: QUARTER_PAYLOAD_VERSION, snapshot };
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
