import { createProject, openProject, PROJECT_SCHEMA_VERSION, type FormatUpgrade, type ProjectSession, type StoredQuarterPlan } from "../db/project-snapshots";
import type { Quarter } from "../domain/capacity/calendar-quarter";
import { createQuarterCalendar, type CalendarMode } from "../domain/capacity/project-calendar";
import { normalizeSnapshotDecimals } from "../domain/capacity/draft-normalize";
import { formatScreenHours } from "../domain/capacity/input-format";
import { copyQuarterSetup } from "../domain/capacity/quarter-copy";
import { calculateQuarterCapacity } from "../domain/capacity/quarter-capacity.calculator";
import { describeSaveProblems } from "../domain/capacity/source-plan";
import type { CalculateQuarterCapacityResult, QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";
import { validateQuarterSnapshot } from "../domain/capacity/quarter-snapshot.validation";
import { buildQuarterReport, type QuarterReport } from "../export/quarter-report";
import { saveReportFile, type ReportSaveOutcome } from "../export/report-file";
import { renderQuarterReportXlsx } from "../export/xlsx";
import { pendingRowCount, type ImportBatch, type ImportDraft } from "../import/work-import";
import { pickProjectFolder } from "./folder-picker";
import { describeValidationIssue } from "./validation-text";

/** Pending-form key of the team rename form; it blocks saving and the report. */
export const PROJECT_NAME_FORM = "project-name";

/** Answer to the unsaved-changes dialog: true discards, false cancels, "save" saves first. */
export type DiscardAnswer = boolean | "save";

export function quarterTitle(period: { year: number; quarter: Quarter }): string {
  return `${period.quarter} квартал ${period.year} года`;
}

/** The PO's warning before the first save of a project made by 0.1.0–0.3.0 (DEC-044). */
export const FORMAT_UPGRADE_MESSAGE = "После обновления формата этот файл нельзя будет открыть в версии 0.3.0. "
  + "Перед сохранением будет создана резервная копия исходного проекта.";

/**
 * A new work typed into the form of one source and not added yet (QUARTER_PLANNING_UX.md,
 * «Незаконченный ввод»). Kept per quarter and source while the project is open; never
 * written to the project file.
 */
export type WorkInput = Readonly<{
  planId: string;
  sourceId: string;
  /** Named in the warning when closing the project would lose the input. */
  sourceName: string;
  quarter: string;
  name: string;
  estimate: string;
  link: string;
  comment: string;
  mark: "candidate" | "plan";
  /** The mark was taken from the last work added to this source. */
  remembered: boolean;
  open: boolean;
}>;

export const workInputKey = (planId: string, sourceId: string) => `${planId}:${sourceId}`;

export function isBlankWorkInput(input: Pick<WorkInput, "name" | "estimate" | "link" | "comment">): boolean {
  return !input.name.trim() && !input.estimate.trim() && !input.link.trim() && !input.comment.trim();
}

export interface WorkspaceRepository {
  readonly session: Readonly<ProjectSession>;
  list(): Promise<StoredQuarterPlan[]>;
  create(planId: string, input: unknown): Promise<StoredQuarterPlan>;
  save(planId: string, expectedRevision: number, input: unknown): Promise<StoredQuarterPlan>;
  /** Backup, then format 1 → 2; the file is unchanged if this fails. */
  upgradeFormat(): Promise<FormatUpgrade>;
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
  /** Shown beside the notice when a save leaves the plan unbalanced; the problem itself stays visible. */
  warning: string;
  calculation: CalculateQuarterCapacityResult | null;
  /** canSave: the dialog may offer "Сохранить и продолжить"; details lists unfinished input that is lost. */
  confirmation: { message: string; canSave: boolean; details: string[] } | null;
  /** Asked before the first write to a project of format 1; folderPath is where the backup goes. */
  formatUpgrade: { message: string; folderPath: string } | null;
  /** Whether the saved quarter can be exported; hint explains why not. */
  report: { available: boolean; hint: string };
  /** Session memory of the planner, cleared with the project: see WorkInput. */
  workInputs: Readonly<Record<string, WorkInput>>;
  /** The last «Куда добавить» per quarter and source, while the project is open (DEC-037). */
  lastMarks: Readonly<Record<string, WorkInput["mark"]>>;
  /** Rows from a spreadsheet not added yet, per quarter and source (importDraftKey); never written to the file. */
  importDrafts: Readonly<Record<string, ImportDraft>>;
  /** Finished imports that «Отменить вставку» can still remove, newest last. */
  importBatches: readonly ImportBatch[];
}

interface Dependencies {
  createProject: (folderPath: string, name: string) => Promise<WorkspaceRepository>;
  openProject: (folderPath: string) => Promise<WorkspaceRepository>;
  /** System folder dialog; null when cancelled. */
  pickFolder: (title: string) => Promise<string | null>;
  id: () => string;
  now: () => Date;
  renderReport: (report: QuarterReport) => Promise<Uint8Array>;
  saveReportFile: (defaultName: string, bytes: Uint8Array) => Promise<ReportSaveOutcome>;
  confirmDiscard?: (message: string, canSave: boolean) => Promise<DiscardAnswer>;
  confirmFormatUpgrade?: (message: string, folderPath: string) => Promise<boolean>;
  readSelectedPlan?: (projectId: string) => string | null;
  writeSelectedPlan?: (projectId: string, planId: string) => void;
}

function emptyState(): WorkspaceState {
  return { project: null, plans: [], activePlanId: null, draft: null, dirty: false,
    busy: false, closeProtectionReady: true, error: "", notice: "", warning: "", calculation: null, confirmation: null,
    formatUpgrade: null, report: { available: false, hint: "" }, workInputs: {}, lastMarks: {},
    importDrafts: {}, importBatches: [] };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function projectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 1000) throw new Error("Укажите название команды от 1 до 1000 символов.");
  return trimmed;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Не удалось выполнить операцию с проектом.";
}

/** Owns navigation, raw drafts and persistence revisions; React only renders it. */
export class ProjectWorkspaceController {
  private state = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly pendingForms = new Set<string>();
  // What a pending field still needs, said when a save is refused because of it.
  private readonly pendingMessages = new Map<string, string>();
  private readonly deps: Dependencies;
  private repository: WorkspaceRepository | null = null;
  private operation: Promise<boolean> | null = null;
  private operationKind: "save" | "transition" | "export" | null = null;
  private resolveDiscard: ((answer: DiscardAnswer) => void) | null = null;
  private resolveFormatUpgrade: ((confirmed: boolean) => void) | null = null;
  // Set while closeProject waits for a running operation: a folder picked meanwhile is not opened.
  private closeRequested = false;
  // Keyed by the stored plan object: list/save always replace it with a new one.
  private savedCalculation: { plan: StoredQuarterPlan; result: CalculateQuarterCapacityResult } | null = null;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = {
      createProject, openProject, pickFolder: pickProjectFolder, id: () => crypto.randomUUID(), now: () => new Date(),
      renderReport: renderQuarterReportXlsx, saveReportFile, ...deps
    };
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
    this.state.report = this.reportAvailability().report;
    for (const listener of this.listeners) listener();
  }

  /** Only the saved quarter is exported, calculated from its snapshot rather than the draft. */
  private reportAvailability(): { report: WorkspaceState["report"]; saved?: StoredQuarterPlan;
    result?: Extract<CalculateQuarterCapacityResult, { ok: true }>["result"] } {
    const saved = this.state.plans.find((plan) => plan.planId === this.state.activePlanId);
    if (!this.state.project || !saved) return { report: { available: false, hint: "" } };
    if (this.pendingForms.has(PROJECT_NAME_FORM)) {
      return { report: { available: false, hint: "Сохраните или отмените новое название команды" } };
    }
    if (this.state.dirty) return { report: { available: false, hint: "Сохраните квартал" } };
    if (this.savedCalculation?.plan !== saved) {
      this.savedCalculation = { plan: saved, result: calculateQuarterCapacity(saved.snapshot) };
    }
    const calculation = this.savedCalculation.result;
    return calculation.ok
      ? { report: { available: true, hint: "" }, saved, result: calculation.result }
      : { report: { available: false, hint: "Отчёт появится после заполнения данных" } };
  }

  private run(kind: "save" | "transition" | "export", task: () => Promise<boolean>): Promise<boolean> {
    if (this.operation || !this.state.closeProtectionReady) return Promise.resolve(false);
    this.operationKind = kind;
    this.upgradeNotice = "";
    this.publish({ busy: true, error: "", notice: "", warning: "" });
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

  /**
   * Unfinished input of new works, named for the dialog with the source's current name; blank
   * forms and forms of sources deleted since are not listed.
   */
  private unfinishedInputs(): string[] {
    const quarterOf = (planId: string) => planId === this.state.activePlanId ? this.state.draft
      : this.state.plans.find((plan) => plan.planId === planId)?.snapshot;
    const works = Object.values(this.state.workInputs).filter((input) => !isBlankWorkInput(input)).flatMap((input) => {
      const quarter = quarterOf(input.planId);
      const source = quarter?.directions.find((direction) => direction.id === input.sourceId);
      if (quarter && !source) return [];
      const name = source?.name.trim() || input.sourceName;
      return [`«${name}», ${input.quarter}: ${input.name.trim() ? `«${input.name.trim()}»` : "работа без названия"}`];
    });
    // Rows of an import that were not added (DEC-039): the clipboard may no longer hold them.
    const imports = Object.values(this.state.importDrafts).flatMap((draft) => {
      const count = pendingRowCount(draft);
      const quarter = quarterOf(draft.planId);
      if (!count || !quarter) return [];
      const source = draft.openedFrom ? quarter.directions.find((direction) => direction.id === draft.openedFrom) : undefined;
      const where = source ? `«${source.name.trim() || "Без названия"}»` : draft.openedFrom ? "удалённый источник" : "все источники";
      return [`${where}, ${quarterTitle(quarter)}: строки из таблицы, ещё не добавленные: ${count}`];
    });
    return [...works, ...imports];
  }

  /**
   * Runs inside the calling operation; a failed save throws, so the transition does not happen.
   * losesInputs: the project closes, so unfinished input of new works is lost too.
   */
  private async canDiscard(losesInputs = false): Promise<boolean> {
    const details = losesInputs ? this.unfinishedInputs() : [];
    if (!this.state.dirty && !details.length) return true;
    const saved = this.state.plans.find((plan) => plan.planId === this.state.activePlanId);
    // An unfinished team rename is not part of the quarter and cannot be saved from here.
    const canSave = this.state.dirty && Boolean(this.repository && this.state.draft && saved && this.pendingForms.size === 0);
    const lost = details.length ? " Незаконченный ввод работ в файл проекта не сохраняется и будет потерян:" : "";
    const message = !this.state.dirty
      ? "Незаконченный ввод работ в файл проекта не сохраняется и будет потерян:"
      : canSave && saved
        ? `В квартале «${quarterTitle(saved.snapshot)}» есть несохранённые изменения. Сохранить их перед продолжением?${lost}`
        : `Есть несохранённые изменения. Если продолжить, они будут потеряны.${lost}`;
    const answer = this.deps.confirmDiscard
      ? await this.deps.confirmDiscard(message, canSave)
      : await new Promise<DiscardAnswer>((resolve) => {
        this.resolveDiscard = resolve;
        this.publish({ confirmation: { message, canSave, details } });
      });
    if (answer !== "save") return answer;
    if (!canSave) return false;
    // Declining the format upgrade cancels the transition too: nothing was saved.
    if (!await this.persistDraft()) return false;
    // Named, because the next screen may be another quarter or project.
    if (saved) this.publish({ notice: `${this.upgradeNotice}Изменения квартала «${quarterTitle(saved.snapshot)}» сохранены.`, warning: "" });
    return true;
  }

  // Set by ensureCurrentFormat within one operation and shown with that operation's result.
  private upgradeNotice = "";

  /**
   * Before the first write to a project of format 1: the user confirms, the native store makes and
   * checks a backup, then upgrades the file. False when declined; the file stays as it was.
   */
  private async ensureCurrentFormat(): Promise<boolean> {
    const repository = this.repository;
    if (!repository || repository.session.schemaVersion === PROJECT_SCHEMA_VERSION) return true;
    const folderPath = repository.session.folderPath;
    const confirmed = this.deps.confirmFormatUpgrade
      ? await this.deps.confirmFormatUpgrade(FORMAT_UPGRADE_MESSAGE, folderPath)
      : await new Promise<boolean>((resolve) => {
        this.resolveFormatUpgrade = resolve;
        this.publish({ formatUpgrade: { message: FORMAT_UPGRADE_MESSAGE, folderPath } });
      });
    if (!confirmed) return false;
    const upgrade = await repository.upgradeFormat();
    this.upgradeNotice = upgrade.backupPath
      ? `Формат проекта обновлён. Резервная копия исходного проекта: ${upgrade.backupPath}. ` : "";
    // Shown at once: if the write after it fails, the error must not hide where the backup is.
    this.publish({ project: clone(repository.session), notice: this.upgradeNotice.trim() });
    return true;
  }

  /** False when the format upgrade was declined: nothing was written. */
  private async persistDraft(): Promise<boolean> {
    const { draft, activePlanId } = this.state;
    const saved = this.state.plans.find((plan) => plan.planId === activePlanId);
    if (!this.repository || !draft || !saved) throw new Error("Сначала выберите квартал.");
    if (this.pendingForms.has(PROJECT_NAME_FORM)) throw new Error("Сначала завершите редактирование названия команды.");
    if (this.pendingForms.size) {
      const [message] = [...this.pendingForms].map((key) => this.pendingMessages.get(key)).filter(Boolean);
      throw new Error(`Не удалось сохранить. ${message ?? "Исправьте поля, отмеченные ошибкой."}`);
    }
    const captured = normalizeSnapshotDecimals(clone(draft));
    const checked = validateQuarterSnapshot(captured);
    if (!checked.ok) {
      const first = checked.errors[0];
      throw new Error(`Не удалось сохранить. ${first ? describeValidationIssue(first) : "Проверьте введённые данные."}`);
    }
    if (captured.year !== saved.snapshot.year || captured.quarter !== saved.snapshot.quarter) throw new Error("Период существующего плана нельзя изменить.");
    if (!await this.ensureCurrentFormat()) return false;
    const stored = clone(await this.repository.save(saved.planId, saved.revision, captured));
    // Show the normalized values unless the draft was edited while saving.
    const calculation = calculateQuarterCapacity(captured);
    const normalized = this.state.draft === draft ? { draft: clone(captured), calculation } : {};
    this.publish({ plans: this.state.plans.map((plan) => plan.planId === stored.planId ? stored : plan), ...normalized });
    // Saving does not balance the plan: an excess of shares or an overrun stays and is named.
    const problems = calculation.ok ? describeSaveProblems(calculation.result, formatScreenHours) : [];
    const title = quarterTitle(captured);
    this.publish({
      notice: this.upgradeNotice + (this.state.dirty
        ? `Изменения квартала «${title}» сохранены. Более поздние изменения ещё не сохранены.`
        : `Изменения квартала «${title}» сохранены.`),
      warning: problems.length ? `Сохранение не балансирует план: ${problems.join("; ")}. Это остаётся видно в итогах и таблицах, пока вы не измените доли или состав плана.` : ""
    });
    return true;
  }

  private select(plan: StoredQuarterPlan | undefined) {
    this.pendingForms.clear();
    this.pendingMessages.clear();
    const draft = plan ? clone(plan.snapshot) : null;
    this.publish({ activePlanId: plan?.planId ?? null, draft,
      calculation: draft ? calculateQuarterCapacity(draft) : null });
    if (plan && this.state.project) {
      try { this.deps.writeSelectedPlan?.(this.state.project.projectId, plan.planId); }
      catch { /* A local UI preference must never invalidate a saved plan. */ }
    }
  }

  /** The folder dialog is part of the operation, so closing the window waits for it. */
  private async pickFolder(title: string): Promise<string | null> {
    let folder: string | null;
    try { folder = await this.deps.pickFolder(title); }
    catch (error) {
      console.error(error);
      throw new Error("Не удалось выбрать папку. Попробуйте ещё раз.");
    }
    return this.closeRequested ? null : folder;
  }

  private async replaceProject(open: () => Promise<WorkspaceRepository>): Promise<boolean> {
    if (!await this.canDiscard(true)) return false;
    let candidate: WorkspaceRepository | null = null;
    try {
      candidate = await open();
      const plans = clone(await candidate.list());
      // Preserve the current project/draft until the new one is readable and
      // the old session has really closed. Failed open must lose nothing.
      await this.repository?.close({ discardFailedWrites: true });
      this.repository = candidate;
      this.pendingForms.clear();
      this.pendingMessages.clear();
      // A backup made while saving the previous project stays named until the user reads it.
      this.publish({ project: clone(candidate.session), plans, notice: this.upgradeNotice.trim(), workInputs: {}, lastMarks: {},
        importDrafts: {}, importBatches: [] });
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
      const trimmed = projectName(name);
      return this.replaceProject(() => this.deps.createProject(folderPath, trimmed));
    }),
    openProject: (folderPath: string): Promise<boolean> => this.run("transition", () =>
      this.replaceProject(() => this.deps.openProject(folderPath))),
    /** Asks for an empty folder, then creates the project there; cancelling returns false. */
    chooseAndCreateProject: (name: string): Promise<boolean> => this.run("transition", async () => {
      const trimmed = projectName(name);
      const folder = await this.pickFolder("Выберите пустую папку для команды");
      return folder !== null && this.replaceProject(() => this.deps.createProject(folder, trimmed));
    }),
    chooseAndOpenProject: (): Promise<boolean> => this.run("transition", async () => {
      const folder = await this.pickFolder("Выберите папку проекта");
      return folder !== null && this.replaceProject(() => this.deps.openProject(folder));
    }),
    closeProject: async (): Promise<boolean> => {
      // Window-close can arrive during a save or a folder dialog: wait, then guard the latest draft.
      if (this.operation) {
        this.closeRequested = true;
        try { await this.operation; } finally { this.closeRequested = false; }
      }
      return this.run("transition", async () => {
        if (!await this.canDiscard(true)) return false;
        await this.repository?.close({ discardFailedWrites: true });
        this.repository = null;
        this.pendingForms.clear();
        this.pendingMessages.clear();
        this.publish({ ...emptyState(), busy: true, notice: this.upgradeNotice.trim() });
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
    /** copyFromPlanId copies the saved team and shares of that quarter; see copyQuarterSetup. */
    createPlan: (year: number, quarter: Quarter, mode: CalendarMode = "ru-official",
      copyFromPlanId: string | null = null): Promise<boolean> => this.run("transition", async () => {
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
      // Looked up after the dialog: "Сохранить и продолжить" may have just saved the source.
      const source = copyFromPlanId === null ? undefined : this.state.plans.find((plan) => plan.planId === copyFromPlanId);
      if (copyFromPlanId !== null && !source) throw new Error("Квартал для копирования не найден.");
      const base = { year, quarter, calendar: calendar.calendar, calendarSource: calendar.calendarSource };
      const snapshot: QuarterSnapshot = source ? copyQuarterSetup(source.snapshot, base) : {
        ...base,
        competencies: ["SA", "BPMN", "Frontend", "Java", "Python", "QA"].map((name) => ({ id: this.deps.id(), name })),
        members: [], absences: [], directions: [], tasks: []
      };
      // A new quarter is written at once, so a project of format 1 is upgraded first.
      if (!await this.ensureCurrentFormat()) return false;
      const stored = clone(await this.repository.create(this.deps.id(), snapshot));
      this.publish({ plans: [...this.state.plans, stored] });
      this.select(stored);
      this.publish({ notice: this.upgradeNotice + (source
        ? `Квартал создан. Из квартала «${quarterTitle(source.snapshot)}» скопированы сотрудники, ставки, компетенции, источники и доли; добавьте отсутствия и работы.`
        : "Квартал создан. Заполните команду и сохраните расчёт.") });
      return true;
    }),
    save: (): Promise<boolean> => this.run("save", () => this.persistDraft()),
    /** Exports the saved quarter; the native command shows "Save as". Cancelling is not an error. */
    exportReport: (): Promise<boolean> => this.run("export", async () => {
      const { report: availability, saved, result } = this.reportAvailability();
      const project = this.state.project;
      if (!availability.available || !saved || !result || !project) {
        throw new Error(availability.hint ? `${availability.hint}.` : "Сначала выберите сохранённый квартал.");
      }
      let report: QuarterReport;
      let bytes: Uint8Array;
      try {
        report = buildQuarterReport({ teamName: project.name, snapshot: saved.snapshot, result, exportedAt: this.deps.now() });
        bytes = await this.deps.renderReport(report);
      } catch (error) {
        console.error(error);
        throw new Error("Не удалось сформировать отчёт.");
      }
      const outcome = await this.deps.saveReportFile(report.fileBaseName, bytes);
      if (outcome.status === "cancelled") return false;
      this.publish({ notice: `Отчёт сохранён: ${outcome.path}` });
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
    /** forPlanId: a change meant for this quarter only; it is dropped once another quarter is open. */
    updateDraft: (updater: (current: QuarterSnapshot) => QuarterSnapshot, forPlanId?: string): void => {
      if (!this.state.draft || !this.state.closeProtectionReady || this.operationKind === "transition") return;
      if (forPlanId !== undefined && forPlanId !== this.state.activePlanId) return;
      const draft = clone(updater(clone(this.state.draft)));
      this.publish({ draft, calculation: calculateQuarterCapacity(draft), notice: "", warning: "", error: "" });
    },
    /** A field whose text is not in the draft yet; message says what blocks saving meanwhile. */
    setPendingFormDirty: (key: string, dirty: boolean, message?: string): void => {
      if (dirty) {
        this.pendingForms.add(key);
        if (message) this.pendingMessages.set(key, message); else this.pendingMessages.delete(key);
      } else {
        this.pendingForms.delete(key);
        this.pendingMessages.delete(key);
      }
      this.publish({});
    },
    setWorkInput: (key: string, input: WorkInput | null): void => {
      if (!this.state.project) return;
      const workInputs = { ...this.state.workInputs };
      if (input) workInputs[key] = input; else delete workInputs[key];
      this.publish({ workInputs });
    },
    rememberMark: (key: string, mark: WorkInput["mark"]): void => {
      if (!this.state.project) return;
      this.publish({ lastMarks: { ...this.state.lastMarks, [key]: mark } });
    },
    setImportDraft: (key: string, draft: ImportDraft | null): void => {
      if (!this.state.project) return;
      const importDrafts = { ...this.state.importDrafts };
      if (draft) importDrafts[key] = draft; else delete importDrafts[key];
      this.publish({ importDrafts });
    },
    /** Remembers a finished import for «Отменить вставку»; only the last few are kept. */
    recordImportBatch: (batch: ImportBatch): void => {
      if (!this.state.project) return;
      this.publish({ importBatches: [...this.state.importBatches, batch].slice(-20) });
    },
    forgetImportBatch: (id: string): void => {
      this.publish({ importBatches: this.state.importBatches.filter((batch) => batch.id !== id) });
    },
    answerDiscard: (answer: DiscardAnswer): void => {
      const resolve = this.resolveDiscard;
      this.resolveDiscard = null;
      this.publish({ confirmation: null });
      resolve?.(answer);
    },
    answerFormatUpgrade: (confirmed: boolean): void => {
      const resolve = this.resolveFormatUpgrade;
      this.resolveFormatUpgrade = null;
      this.publish({ formatUpgrade: null });
      resolve?.(confirmed);
    },
    clearMessage: (): void => this.publish({ error: "", notice: "", warning: "" }),
    setCloseProtectionReady: (ready: boolean): void => this.publish({ closeProtectionReady: ready }),
    reportError: (message: string): void => this.publish({ error: message })
  };
}
