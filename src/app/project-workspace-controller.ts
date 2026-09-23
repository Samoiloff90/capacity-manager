import { createProject, openProject, type ProjectSession, type StoredQuarterPlan } from "../db/project-snapshots";
import type { Quarter } from "../domain/capacity/calendar-quarter";
import { createQuarterCalendar, type CalendarMode } from "../domain/capacity/project-calendar";
import { calculateQuarterCapacity } from "../domain/capacity/quarter-capacity.calculator";
import type { CalculateQuarterCapacityResult, QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";
import { validateQuarterSnapshot } from "../domain/capacity/quarter-snapshot.validation";

export interface WorkspaceRepository {
  readonly session: Readonly<ProjectSession>;
  list(): Promise<StoredQuarterPlan[]>;
  create(planId: string, input: unknown): Promise<StoredQuarterPlan>;
  save(planId: string, expectedRevision: number, input: unknown): Promise<StoredQuarterPlan>;
  close(options?: { discardFailedWrites?: boolean }): Promise<void>;
  rename(name: string): Promise<Readonly<ProjectSession>>;
}

export interface WorkspaceState {
  project: Readonly<ProjectSession> | null;
  plans: StoredQuarterPlan[];
  activePlanId: string | null;
  draft: QuarterSnapshot | null;
  dirty: boolean;
  busy: boolean;
  closeProtectionReady: boolean;
  error: string;
  notice: string;
  calculation: CalculateQuarterCapacityResult | null;
  confirmation: { message: string } | null;
}

interface Dependencies {
  createProject: (folderPath: string, name: string) => Promise<WorkspaceRepository>;
  openProject: (folderPath: string) => Promise<WorkspaceRepository>;
  id: () => string;
  confirmDiscard?: (message: string) => Promise<boolean>;
  readSelectedPlan?: (projectId: string) => string | null;
  writeSelectedPlan?: (projectId: string, planId: string) => void;
}

function emptyState(): WorkspaceState {
  return { project: null, plans: [], activePlanId: null, draft: null, dirty: false,
    busy: false, closeProtectionReady: true, error: "", notice: "", calculation: null, confirmation: null };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Не удалось выполнить операцию с проектом.";
}

/** Owns navigation, raw drafts and persistence revisions; React only renders it. */
export class ProjectWorkspaceController {
  private state = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly pendingForms = new Set<string>();
  private readonly deps: Dependencies;
  private repository: WorkspaceRepository | null = null;
  private operation: Promise<boolean> | null = null;
  private operationKind: "save" | "transition" | null = null;
  private resolveDiscard: ((discard: boolean) => void) | null = null;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { createProject, openProject, id: () => crypto.randomUUID(), ...deps };
  }
  getSnapshot = (): WorkspaceState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<WorkspaceState>) {
    this.state = { ...this.state, ...patch };
    const saved = this.state.plans.find((plan) => plan.planId === this.state.activePlanId);
    this.state.dirty = this.pendingForms.size > 0 || (this.state.draft !== null
      && JSON.stringify(this.state.draft) !== JSON.stringify(saved?.snapshot));
    for (const listener of this.listeners) listener();
  }

  private run(kind: "save" | "transition", task: () => Promise<boolean>): Promise<boolean> {
    if (this.operation || !this.state.closeProtectionReady) return Promise.resolve(false);
    this.operationKind = kind;
    this.publish({ busy: true, error: "", notice: "" });
    const pending = Promise.resolve().then(task).catch((error: unknown) => {
      this.publish({ error: errorMessage(error) });
      return false;
    }).finally(() => {
      this.operation = null;
      this.operationKind = null;
      this.publish({ busy: false });
    });
    this.operation = pending;
    return pending;
  }

  private async canDiscard(): Promise<boolean> {
    if (!this.state.dirty) return true;
    const message = "Есть несохранённые изменения. Если продолжить, они будут потеряны.";
    if (this.deps.confirmDiscard) return this.deps.confirmDiscard(message);
    return new Promise<boolean>((resolve) => {
      this.resolveDiscard = resolve;
      this.publish({ confirmation: { message } });
    });
  }

  private select(plan: StoredQuarterPlan | undefined) {
    this.pendingForms.clear();
    const draft = plan ? clone(plan.snapshot) : null;
    this.publish({ activePlanId: plan?.planId ?? null, draft,
      calculation: draft ? calculateQuarterCapacity(draft) : null });
    if (plan && this.state.project) {
      try { this.deps.writeSelectedPlan?.(this.state.project.projectId, plan.planId); }
      catch { /* A local UI preference must never invalidate a saved plan. */ }
    }
  }

  private async replaceProject(open: () => Promise<WorkspaceRepository>): Promise<boolean> {
    if (!await this.canDiscard()) return false;
    let candidate: WorkspaceRepository | null = null;
    try {
      candidate = await open();
      const plans = clone(await candidate.list());
      // Preserve the current project/draft until the new one is readable and
      // the old session has really closed. Failed open must lose nothing.
      await this.repository?.close({ discardFailedWrites: true });
      this.repository = candidate;
      this.pendingForms.clear();
      this.publish({ project: clone(candidate.session), plans });
      let preference: string | null = null;
      try { preference = this.deps.readSelectedPlan?.(candidate.session.projectId) ?? null; }
      catch { /* Optional application-local preference. */ }
      const preferred = plans.find((plan) => plan.planId === preference);
      const latest = [...plans].sort((a, b) => b.snapshot.year - a.snapshot.year || b.snapshot.quarter - a.snapshot.quarter)[0];
      this.select(preferred ?? latest);
      return true;
    } catch (error) {
      if (candidate && candidate !== this.repository) {
        try { await candidate.close({ discardFailedWrites: true }); }
        catch (cleanupError) { throw new Error(`${errorMessage(error)} Не удалось закрыть новый проект: ${errorMessage(cleanupError)}`); }
      }
      throw error;
    }
  }

  readonly actions = {
    createProject: (folderPath: string, name: string): Promise<boolean> => this.run("transition", async () => {
      if (!name.trim() || name.trim().length > 1000) throw new Error("Укажите название команды от 1 до 1000 символов.");
      return this.replaceProject(() => this.deps.createProject(folderPath, name.trim()));
    }),
    openProject: (folderPath: string): Promise<boolean> => this.run("transition", () =>
      this.replaceProject(() => this.deps.openProject(folderPath))),
    closeProject: async (): Promise<boolean> => {
      // Window-close can arrive during a save: wait, then guard the latest draft.
      if (this.operation) await this.operation;
      return this.run("transition", async () => {
        if (!await this.canDiscard()) return false;
        await this.repository?.close({ discardFailedWrites: true });
        this.repository = null;
        this.pendingForms.clear();
        this.publish({ ...emptyState(), busy: true });
        return true;
      });
    },
    selectPlan: (planId: string): Promise<boolean> => this.run("transition", async () => {
      if (planId === this.state.activePlanId) return true;
      const plan = this.state.plans.find((item) => item.planId === planId);
      if (!plan) throw new Error("Квартал не найден.");
      if (!await this.canDiscard()) return false;
      this.select(plan);
      return true;
    }),
    createPlan: (year: number, quarter: Quarter, mode: CalendarMode = "ru-official"): Promise<boolean> => this.run("transition", async () => {
      if (!this.repository) throw new Error("Сначала откройте проект.");
      const existing = this.state.plans.find((plan) => plan.snapshot.year === year && plan.snapshot.quarter === quarter);
      if (existing?.planId === this.state.activePlanId) return true;
      if (existing) {
        if (!await this.canDiscard()) return false;
        this.select(existing);
        return true;
      }
      const calendar = createQuarterCalendar(year, quarter, mode);
      if (!calendar.ok) throw new Error(calendar.message);
      if (!await this.canDiscard()) return false;
      const snapshot: QuarterSnapshot = {
        year, quarter, calendar: calendar.calendar, calendarSource: calendar.calendarSource,
        competencies: ["SA", "BPMN", "Frontend", "Java", "Python", "QA"].map((name) => ({ id: this.deps.id(), name })),
        members: [], absences: [], directions: [], tasks: []
      };
      const stored = clone(await this.repository.create(this.deps.id(), snapshot));
      this.publish({ plans: [...this.state.plans, stored] });
      this.select(stored);
      this.publish({ notice: "Квартал создан. Заполните команду и сохраните расчёт." });
      return true;
    }),
    save: (): Promise<boolean> => this.run("save", async () => {
      const { draft, activePlanId } = this.state;
      const saved = this.state.plans.find((plan) => plan.planId === activePlanId);
      if (!this.repository || !draft || !saved) throw new Error("Сначала выберите квартал.");
      if (this.pendingForms.size) throw new Error("Сначала завершите редактирование названия команды.");
      const captured = clone(draft);
      const checked = validateQuarterSnapshot(captured);
      if (!checked.ok) throw new Error(`Не удалось сохранить: ${checked.errors[0]?.message ?? "проверьте введённые данные"}`);
      if (captured.year !== saved.snapshot.year || captured.quarter !== saved.snapshot.quarter) throw new Error("Период существующего плана нельзя изменить.");
      const stored = clone(await this.repository.save(saved.planId, saved.revision, captured));
      this.publish({ plans: this.state.plans.map((plan) => plan.planId === stored.planId ? stored : plan) });
      this.publish({ notice: this.state.dirty ? "Расчёт сохранён. Более поздние изменения ещё не сохранены." : "Расчёт сохранён в папке проекта." });
      return true;
    }),
    renameProject: (name: string): Promise<boolean> => this.run("transition", async () => {
      if (!this.repository) throw new Error("Сначала откройте проект.");
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 1000) throw new Error("Название команды должно содержать от 1 до 1000 символов.");
      const project = await this.repository.rename(trimmed);
      this.publish({ project: clone(project), notice: "Название команды сохранено." });
      return true;
    }),
    updateDraft: (updater: (current: QuarterSnapshot) => QuarterSnapshot): void => {
      if (!this.state.draft || !this.state.closeProtectionReady || this.operationKind === "transition") return;
      const draft = clone(updater(clone(this.state.draft)));
      this.publish({ draft, calculation: calculateQuarterCapacity(draft), notice: "", error: "" });
    },
    setPendingFormDirty: (key: string, dirty: boolean): void => {
      if (dirty) this.pendingForms.add(key); else this.pendingForms.delete(key);
      this.publish({});
    },
    answerDiscard: (discard: boolean): void => {
      const resolve = this.resolveDiscard;
      this.resolveDiscard = null;
      this.publish({ confirmation: null });
      resolve?.(discard);
    },
    clearMessage: (): void => this.publish({ error: "", notice: "" }),
    setCloseProtectionReady: (ready: boolean): void => this.publish({ closeProtectionReady: ready }),
    reportError: (message: string): void => this.publish({ error: message })
  };
}
