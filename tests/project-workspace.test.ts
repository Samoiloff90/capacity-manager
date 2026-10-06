import { describe, expect, it, vi } from "vitest";
import { PROJECT_NAME_FORM, ProjectWorkspaceController, type DiscardAnswer, type WorkspaceRepository } from "../src/app/project-workspace-controller";
import type { QuarterReport } from "../src/export/quarter-report";
import type { ReportSaveOutcome } from "../src/export/report-file";
import { ProjectPersistenceError, type FormatUpgrade, type ProjectSession, type StoredQuarterPlan } from "../src/db/project-snapshots";
import type { Quarter } from "../src/domain/capacity/calendar-quarter";
import { createQuarterCalendar } from "../src/domain/capacity/project-calendar";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";

const folderA = "D:\\Команды\\папка А";
const folderB = "D:\\Команды\\папка Б";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function savedPlan(planId: string, quarter: Quarter): StoredQuarterPlan {
  const calendar = createQuarterCalendar(2026, quarter);
  if (!calendar.ok) throw new Error(calendar.message);
  return {
    planId, revision: 1, payloadVersion: 2,
    snapshot: {
      year: 2026, quarter, calendar: calendar.calendar, calendarSource: calendar.calendarSource,
      competencies: [{ id: "dev", name: "Разработка" }],
      members: [{ id: "person", name: "Участник", competencyId: "dev", fte: "1" }],
      absences: [], directions: [], tasks: []
    }
  };
}

/** Deliberately no validation here: the controller must reject invalid drafts before writing. */
class MemoryRepository implements WorkspaceRepository {
  session: ProjectSession;
  readonly rows: Map<string, StoredQuarterPlan>;

  constructor(plans: StoredQuarterPlan[] = [savedPlan("q1", 1), savedPlan("q2", 2)], schemaVersion: 1 | 2 = 2) {
    this.session = {
      sessionKey: "session-a", projectId: "project-a", name: "Команда А",
      folderPath: folderA, schemaVersion, sqliteVersion: "test"
    };
    this.rows = new Map(plans.map((plan) => [plan.planId, clone(plan)]));
  }

  list = vi.fn(async (): Promise<StoredQuarterPlan[]> => clone([...this.rows.values()]));

  create = vi.fn(async (planId: string, input: unknown): Promise<StoredQuarterPlan> => {
    this.requireCurrentFormat();
    const saved = { planId, revision: 1, payloadVersion: 2 as const, snapshot: clone(input as QuarterSnapshot) };
    this.rows.set(planId, saved);
    return clone(saved);
  });

  save = vi.fn(async (planId: string, expectedRevision: number, input: unknown): Promise<StoredQuarterPlan> => {
    const previous = this.rows.get(planId);
    if (!previous || previous.revision !== expectedRevision) {
      throw new ProjectPersistenceError("CONFLICT", "План уже изменён");
    }
    this.requireCurrentFormat();
    const saved = { planId, revision: expectedRevision + 1, payloadVersion: 2 as const, snapshot: clone(input as QuarterSnapshot) };
    this.rows.set(planId, saved);
    return clone(saved);
  });

  /** As the real store: quarters are written only after a format-1 project is upgraded. */
  private requireCurrentFormat() {
    if (this.session.schemaVersion !== 2) throw new ProjectPersistenceError("FORMAT_UPGRADE_REQUIRED", "Сначала нужно обновить формат проекта.");
  }

  upgradeFormat = vi.fn(async (): Promise<FormatUpgrade> => {
    const backupPath = this.session.schemaVersion === 2 ? null : `${folderA}\\capacity-backup-format1-2026-10-06.sqlite`;
    this.session = { ...this.session, schemaVersion: 2 };
    return { schemaVersion: 2, backupPath };
  });

  close = vi.fn(async (_options?: { discardFailedWrites?: boolean }): Promise<void> => {});

  rename = vi.fn(async (name: string): Promise<Readonly<ProjectSession>> => {
    this.session = { ...this.session, name };
    return clone(this.session);
  });
}

function workspace(repository = new MemoryRepository(), confirmDiscard?: (message: string, canSave: boolean) => Promise<DiscardAnswer>,
  confirmFormatUpgrade?: (message: string, folderPath: string) => Promise<boolean>) {
  const preferences = new Map<string, string>();
  const createProject = vi.fn(async (_folder: string, _name: string): Promise<WorkspaceRepository> => repository);
  const openProject = vi.fn(async (_folder: string): Promise<WorkspaceRepository> => repository);
  let nextId = 0;
  const dependencies = {
    createProject, openProject, id: () => `generated-${++nextId}`, confirmDiscard, confirmFormatUpgrade,
    pickFolder: vi.fn(async (_title: string): Promise<string | null> => folderA),
    readSelectedPlan: (projectId: string) => preferences.get(projectId) ?? null,
    writeSelectedPlan: (projectId: string, planId: string) => { preferences.set(projectId, planId); },
    now: () => new Date(2026, 9, 5, 9, 7),
    renderReport: vi.fn(async (_report: QuarterReport): Promise<Uint8Array> => new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
    saveReportFile: vi.fn(async (defaultName: string, _bytes: Uint8Array): Promise<ReportSaveOutcome> =>
      ({ status: "saved", path: `D:\\Отчёты\\${defaultName}.xlsx` }))
  };
  return { controller: new ProjectWorkspaceController(dependencies), dependencies, repository, preferences };
}

function changeFte(controller: ProjectWorkspaceController, fte: string) {
  controller.actions.updateDraft((draft) => ({
    ...draft, members: draft.members.map((member) => ({ ...member, fte }))
  }));
}

describe("project workspace lifecycle and unsaved changes", () => {
  it("blocks opening, editing and persistence until desktop close protection is ready", async () => {
    const { controller, repository, dependencies } = workspace();
    expect(controller.getSnapshot().closeProtectionReady).toBe(true);
    controller.actions.setCloseProtectionReady(false);
    expect(await controller.actions.createProject(folderA, "Команда А")).toBe(false);
    expect(await controller.actions.openProject(folderA)).toBe(false);
    expect(dependencies.createProject).not.toHaveBeenCalled();
    expect(dependencies.openProject).not.toHaveBeenCalled();
    expect(controller.getSnapshot().project).toBeNull();

    controller.actions.setCloseProtectionReady(true);
    expect(await controller.actions.openProject(folderA)).toBe(true);
    await controller.actions.selectPlan("q1");
    const original = clone(controller.getSnapshot().draft);
    controller.actions.setCloseProtectionReady(false);
    changeFte(controller, "0.5");
    expect(controller.getSnapshot().draft).toEqual(original);
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(await controller.actions.save()).toBe(false);
    expect(await controller.actions.renameProject("Новое название")).toBe(false);
    expect(await controller.actions.createPlan(2026, 3)).toBe(false);
    expect(await controller.actions.selectPlan("q2")).toBe(false);
    expect(await controller.actions.closeProject()).toBe(false);
    expect(controller.getSnapshot().activePlanId).toBe("q1");
    expect(controller.getSnapshot().project?.projectId).toBe(repository.session.projectId);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.rename).not.toHaveBeenCalled();
    expect(repository.close).not.toHaveBeenCalled();

    controller.actions.setCloseProtectionReady(true);
    changeFte(controller, "0.5");
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(await controller.actions.save()).toBe(true);
    expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("0.5");
    expect(await controller.actions.closeProject()).toBe(true);
  });

  it("persists a new quarter with a complete pinned calendar; unsupported years require manual mode", async () => {
    const { controller, repository } = workspace(new MemoryRepository([]));
    expect(await controller.actions.createProject(folderA, "Команда А")).toBe(true);
    expect(await controller.actions.createPlan(2026, 2, "ru-official")).toBe(true);
    expect(repository.create).toHaveBeenCalledTimes(1);
    const stored = [...repository.rows.values()][0];
    const calendar = createQuarterCalendar(2026, 2);
    if (!calendar.ok) throw new Error(calendar.message);
    expect(stored.snapshot.calendar).toEqual(calendar.calendar);
    expect(stored.snapshot.calendarSource).toEqual(calendar.calendarSource);
    expect(stored.snapshot.competencies).toHaveLength(6);
    expect(stored.snapshot).toMatchObject({ members: [], directions: [], absences: [], tasks: [] });
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.getSnapshot().activePlanId).toBe(stored.planId);

    expect(await controller.actions.createPlan(2028, 1, "ru-official")).toBe(false);
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(await controller.actions.createPlan(2028, 1, "manual")).toBe(true);
    expect(controller.getSnapshot().draft?.calendarSource?.kind).toBe("manual");
    expect(controller.getSnapshot().draft?.calendar).toHaveLength(91); // leap year
  });

  it("reopens the selected saved quarter, calculates its draft, and keeps another plan unchanged", async () => {
    const { controller, repository, dependencies, preferences } = workspace();
    preferences.set(repository.session.projectId, "q2");
    const originalQ1 = clone(repository.rows.get("q1"));
    expect(await controller.actions.openProject(folderA)).toBe(true);
    expect(controller.getSnapshot().activePlanId).toBe("q2");
    changeFte(controller, "0.5");
    const calculation = controller.getSnapshot().calculation;
    expect(calculation?.ok).toBe(true);
    if (calculation?.ok) expect(calculation.result.totals.availableHours).toBe("248");
    expect(await controller.actions.save()).toBe(true);
    expect(repository.rows.get("q1")).toEqual(originalQ1);
    expect(await controller.actions.closeProject()).toBe(true);

    const reopened = new ProjectWorkspaceController(dependencies);
    expect(await reopened.actions.openProject(folderA)).toBe(true);
    expect(reopened.getSnapshot().activePlanId).toBe("q2");
    expect(reopened.getSnapshot().draft?.members[0].fte).toBe("0.5");
    expect(reopened.getSnapshot().draft?.calendarSource).toEqual(repository.rows.get("q2")?.snapshot.calendarSource);
    expect(await reopened.actions.selectPlan("q1")).toBe(true);
    expect(reopened.getSnapshot().draft?.members[0].fte).toBe("1");
    expect(preferences.get(repository.session.projectId)).toBe("q1");
  });

  it("selects an existing manual 2027 plan without requiring or regenerating an official calendar", async () => {
    const manual = createQuarterCalendar(2027, 1, "manual");
    if (!manual.ok) throw new Error(manual.message);
    const saved = savedPlan("manual-2027", 1);
    saved.snapshot = {
      ...saved.snapshot, year: 2027,
      calendar: manual.calendar.map((day) => day.date === "2027-01-01" ? { ...day, isWorking: false } : day),
      calendarSource: { ...manual.calendarSource, version: "original-manual-calendar" }
    };
    const { controller, repository } = workspace(new MemoryRepository([savedPlan("q2", 2), saved]));
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q2");
    expect(controller.getSnapshot().activePlanId).toBe("q2");
    // Official 2027 is bundled now, but the existing manual plan is selected, not regenerated.
    expect(await controller.actions.createPlan(2027, 1)).toBe(true);
    expect(controller.getSnapshot().activePlanId).toBe(saved.planId);
    expect(controller.getSnapshot().draft).toEqual(saved.snapshot);
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("does not mark edits made during a save as saved and uses the returned revision next time", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    const started = deferred<void>();
    const finish = deferred<void>();
    repository.save.mockImplementationOnce(async (planId, revision, input) => {
      const snapshot = clone(input as QuarterSnapshot);
      started.resolve();
      await finish.promise;
      const saved = { planId, revision: revision + 1, payloadVersion: 2 as const, snapshot };
      repository.rows.set(planId, saved);
      return clone(saved);
    });
    const saving = controller.actions.save();
    await started.promise;
    changeFte(controller, "0.75");
    finish.resolve();
    expect(await saving).toBe(true);
    expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("0.5");
    expect(controller.getSnapshot().draft?.members[0].fte).toBe("0.75");
    expect(controller.getSnapshot().dirty).toBe(true);

    expect(await controller.actions.save()).toBe(true);
    expect(repository.save.mock.calls[1][1]).toBe(2);
    expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("0.75");
    expect(controller.getSnapshot().dirty).toBe(false);
  });

  it.each([
    new Error("Нет места на диске"), new ProjectPersistenceError("CONFLICT", "План уже изменён")
  ])("keeps the draft and persisted revision after save failure: %s", async (error) => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    const draft = clone(controller.getSnapshot().draft);
    repository.save.mockRejectedValueOnce(error);
    expect(await controller.actions.save()).toBe(false);
    expect(controller.getSnapshot().draft).toEqual(draft);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(repository.rows.get("q1")?.revision).toBe(1);
    expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("1");
  });

  it("blocks invalid FTE, invalid absence dates and raw pending form values before persistence", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "1e3");
    expect(await controller.actions.save()).toBe(false);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().error).toBeTruthy();
    controller.actions.updateDraft((draft) => ({
      ...draft, members: draft.members.map((member) => ({ ...member, fte: "0.5" })),
      absences: [{ id: "absence", memberId: "person", startDate: "2026-02-30", endDate: "2026-03-01" }]
    }));
    expect(await controller.actions.save()).toBe(false);
    controller.actions.updateDraft((draft) => ({ ...draft, absences: [] }));
    controller.actions.setPendingFormDirty("unparsed-fte", true);
    expect(await controller.actions.save()).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    controller.actions.setPendingFormDirty("unparsed-fte", false);
    expect(await controller.actions.save()).toBe(true);
  });

  it("cancelled quarter switching and closing preserve the active draft and session", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    const draft = clone(controller.getSnapshot().draft);
    const switching = controller.actions.selectPlan("q2");
    await vi.waitFor(() => expect(controller.getSnapshot().confirmation).toBeTruthy());
    controller.actions.answerDiscard(false);
    expect(await switching).toBe(false);
    expect(controller.getSnapshot().activePlanId).toBe("q1");
    const closing = controller.actions.closeProject();
    await vi.waitFor(() => expect(controller.getSnapshot().confirmation).toBeTruthy());
    controller.actions.answerDiscard(false);
    expect(await closing).toBe(false);
    expect(controller.getSnapshot().draft).toEqual(draft);
    expect(controller.getSnapshot().project?.projectId).toBe(repository.session.projectId);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(repository.close).not.toHaveBeenCalled();
  });

  it("explicit discard of a failed write closes with discardFailedWrites and clears the workspace", async () => {
    const confirm = vi.fn(async () => true);
    const { controller, repository } = workspace(new MemoryRepository(), confirm);
    await controller.actions.openProject(folderA);
    changeFte(controller, "0.5");
    repository.save.mockRejectedValueOnce(new Error("Ошибка записи"));
    expect(await controller.actions.save()).toBe(false);
    expect(await controller.actions.closeProject()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(repository.close).toHaveBeenCalledWith({ discardFailedWrites: true });
    expect(controller.getSnapshot().project).toBeNull();
    expect(controller.getSnapshot().draft).toBeNull();
    expect(controller.getSnapshot().dirty).toBe(false);
  });

  it("failed opening keeps the previous draft; another lifecycle request cannot overtake it", async () => {
    const { controller, repository, dependencies } = workspace(new MemoryRepository(), async () => true);
    await controller.actions.openProject(folderA);
    changeFte(controller, "0.5");
    const draft = clone(controller.getSnapshot().draft);
    const started = deferred<void>();
    const opening = deferred<WorkspaceRepository>();
    dependencies.openProject.mockImplementationOnce(async () => {
      started.resolve();
      return opening.promise;
    });
    const attempt = controller.actions.openProject(folderB);
    await started.promise;
    expect(await controller.actions.openProject("D:\\Другая папка")).toBe(false);
    opening.reject(new Error("Файл повреждён"));
    expect(await attempt).toBe(false);
    expect(controller.getSnapshot().project?.folderPath).toBe(folderA);
    expect(controller.getSnapshot().draft).toEqual(draft);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(repository.close).not.toHaveBeenCalled();
  });

  it("does not claim a project closed when repository close fails", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    const draft = clone(controller.getSnapshot().draft);
    repository.close.mockRejectedValueOnce(new Error("Не удалось закрыть соединение"));
    expect(await controller.actions.closeProject()).toBe(false);
    expect(controller.getSnapshot().project?.projectId).toBe(repository.session.projectId);
    expect(controller.getSnapshot().draft).toEqual(draft);
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(await controller.actions.closeProject()).toBe(true);
  });

  it.each(["candidate-list", "old-close"] as const)(
    "closes the candidate and preserves the previous draft when %s fails", async (failure) => {
      const { controller, repository, dependencies } = workspace(new MemoryRepository(), async () => true);
      await controller.actions.openProject(folderA);
      await controller.actions.selectPlan("q1");
      changeFte(controller, "0.5");
      const previous = clone(controller.getSnapshot());
      const candidate = new MemoryRepository([savedPlan("candidate-q3", 3)]);
      candidate.session = { ...candidate.session, sessionKey: "session-b", projectId: "project-b", folderPath: folderB };
      const message = failure === "candidate-list" ? "Не удалось прочитать кварталы" : "Не удалось закрыть текущий проект";
      if (failure === "candidate-list") candidate.list.mockRejectedValueOnce(new Error(message));
      else repository.close.mockRejectedValueOnce(new Error(message));
      dependencies.openProject.mockResolvedValueOnce(candidate);

      expect(await controller.actions.openProject(folderB)).toBe(false);
      expect(candidate.close).toHaveBeenCalledOnce();
      expect(candidate.close).toHaveBeenCalledWith({ discardFailedWrites: true });
      expect(controller.getSnapshot()).toMatchObject({
        project: previous.project, activePlanId: previous.activePlanId, plans: previous.plans,
        draft: previous.draft, dirty: true, busy: false, error: message
      });
      if (failure === "candidate-list") expect(repository.close).not.toHaveBeenCalled();
      else expect(repository.close).toHaveBeenCalledOnce();

      // Cleanup did not replace the current repository: a subsequent write still saves A.
      expect(await controller.actions.save()).toBe(true);
      expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("0.5");
      expect(candidate.save).not.toHaveBeenCalled();
    }
  );

  it("guards an external name form and renames metadata without moving the folder or changing plans", async () => {
    const confirm = vi.fn(async () => false);
    const { controller, repository } = workspace(new MemoryRepository(), confirm);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    const plans = clone([...repository.rows.values()]);
    controller.actions.setPendingFormDirty("project-name", true);
    expect(await controller.actions.selectPlan("q2")).toBe(false);
    expect(await controller.actions.closeProject()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(repository.close).not.toHaveBeenCalled();
    expect(await controller.actions.renameProject("Название из данных")).toBe(true);
    controller.actions.setPendingFormDirty("project-name", false);
    expect(repository.rename).toHaveBeenCalledWith("Название из данных");
    expect(controller.getSnapshot().project).toMatchObject({
      projectId: "project-a", name: "Название из данных", folderPath: folderA
    });
    expect([...repository.rows.values()]).toEqual(plans);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("saves and reopens positive, zero and missing task estimates without changing another quarter", async () => {
    const { controller, repository, dependencies } = workspace();
    const untouched = clone(repository.rows.get("q1"));
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q2");
    const tasks = [
      { id: "planned", name: "Работа продукта", directionId: "product", estimateHours: "120.125", mark: "plan" as const, link: null, comment: null },
      { id: "zero", name: "Явный ноль", directionId: "product", estimateHours: "0", mark: "plan" as const, link: null, comment: null },
      { id: "unknown", name: "Оценка ожидается", directionId: "bugs", estimateHours: null, mark: "plan" as const, link: null, comment: null }
    ];
    controller.actions.updateDraft((draft) => ({
      ...draft,
      directions: [
        { id: "product", name: "Продукт", percent: "20", kind: "work" as const, memberPercents: [] },
        { id: "bugs", name: "Баги", percent: "30", kind: "work" as const, memberPercents: [] },
        { id: "meetings", name: "Встречи", percent: "50", kind: "work" as const, memberPercents: [] }
      ], tasks
    }));
    expect(await controller.actions.save()).toBe(true);
    expect(repository.rows.get("q1")).toEqual(untouched);
    expect(await controller.actions.closeProject()).toBe(true);

    const reopened = new ProjectWorkspaceController(dependencies);
    expect(await reopened.actions.openProject(folderA)).toBe(true);
    expect(reopened.getSnapshot().activePlanId).toBe("q2");
    expect(reopened.getSnapshot().draft?.tasks).toEqual(tasks);
    expect(reopened.getSnapshot().dirty).toBe(false);
    const calculation = reopened.getSnapshot().calculation;
    expect(calculation?.ok).toBe(true);
    if (!calculation?.ok) throw new Error("Expected calculation after reopen");
    expect(calculation.result.totals).toMatchObject({ knownDemandHours: "120.125", missingEstimateCount: 1, demandComplete: false });
    expect(calculation.result.directions.find((direction) => direction.directionId === "product"))
      .toMatchObject({ budgetHours: "99.2", overrunKnownHours: "20.925", balanceComplete: true });
    expect(calculation.result.directions.find((direction) => direction.directionId === "bugs"))
      .toMatchObject({ knownDemandHours: "0", missingEstimateCount: 1, confirmedRemainingHours: null });
  });

  it("moves then deletes a task, updating each direction and preserving the other quarter", async () => {
    const { controller, repository, dependencies } = workspace();
    const untouched = clone(repository.rows.get("q1"));
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q2");
    controller.actions.updateDraft((draft) => ({
      ...draft,
      directions: [{ id: "product", name: "Продукт", percent: "50", kind: "work" as const, memberPercents: [] }, { id: "bugs", name: "Баги", percent: "50", kind: "work" as const, memberPercents: [] }],
      tasks: [{ id: "task", name: "Переносимая работа", directionId: "product", estimateHours: "60", mark: "plan" as const, link: null, comment: null }]
    }));
    expect(await controller.actions.save()).toBe(true);
    controller.actions.updateDraft((draft) => ({ ...draft, tasks: draft.tasks.map((task) => ({ ...task, directionId: "bugs" })) }));
    const moved = controller.getSnapshot().calculation;
    if (!moved?.ok) throw new Error("Expected calculation after task move");
    expect(moved.result.directions.find((direction) => direction.directionId === "product"))
      .toMatchObject({ knownDemandHours: "0", remainingKnownHours: "248" });
    expect(moved.result.directions.find((direction) => direction.directionId === "bugs"))
      .toMatchObject({ knownDemandHours: "60", remainingKnownHours: "188" });
    expect(await controller.actions.save()).toBe(true);
    expect(repository.rows.get("q2")?.snapshot.tasks).toEqual([
      { id: "task", name: "Переносимая работа", directionId: "bugs", estimateHours: "60", mark: "plan" as const, link: null, comment: null }
    ]);
    controller.actions.updateDraft((draft) => ({ ...draft, tasks: draft.tasks.filter((task) => task.id !== "task") }));
    expect(await controller.actions.save()).toBe(true);
    expect(repository.rows.get("q1")).toEqual(untouched);
    await controller.actions.closeProject();
    const reopened = new ProjectWorkspaceController(dependencies);
    await reopened.actions.openProject(folderA);
    expect(reopened.getSnapshot().draft?.tasks).toEqual([]);
    const empty = reopened.getSnapshot().calculation;
    if (!empty?.ok) throw new Error("Expected calculation after deletion");
    expect(empty.result.directions.map((direction) => direction.remainingKnownHours)).toEqual(["248", "248"]);
  });

  it.each([
    ["negative estimate", "-1", "product"], ["raw text estimate", "несколько", "product"],
    ["unknown direction", "4", "missing"]
  ])("preserves an invalid task draft after %s and allows a corrected positive estimate", async (_case, estimateHours, directionId) => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q2");
    const persisted = clone(repository.rows.get("q2"));
    controller.actions.updateDraft((draft) => ({
      ...draft, directions: [{ id: "product", name: "Продукт", percent: "100", kind: "work" as const, memberPercents: [] }],
      tasks: [{ id: "task", name: "Работа", directionId, estimateHours, mark: "plan" as const, link: null, comment: null }]
    }));
    const raw = clone(controller.getSnapshot().draft);
    expect(await controller.actions.save()).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().draft).toEqual(raw);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(repository.rows.get("q2")).toEqual(persisted);
    controller.actions.updateDraft((draft) => ({
      ...draft, tasks: draft.tasks.map((task) => ({ ...task, directionId: "product", estimateHours: "10.25", mark: "plan" as const, link: null, comment: null }))
    }));
    expect(await controller.actions.save()).toBe(true);
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(repository.rows.get("q2")?.snapshot.tasks[0].estimateHours).toBe("10.25");
  });
});

describe("unsaved-changes dialog with saving", () => {
  it("«Сохранить и продолжить» saves the draft, then switches the quarter", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    const switching = controller.actions.selectPlan("q2");
    await vi.waitFor(() => expect(controller.getSnapshot().confirmation).toEqual({
      message: "В квартале «1 квартал 2026 года» есть несохранённые изменения. Сохранить их перед продолжением?", canSave: true
    }));
    controller.actions.answerDiscard("save");
    expect(await switching).toBe(true);
    expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("0.5");
    expect(repository.rows.get("q1")?.revision).toBe(2);
    expect(controller.getSnapshot()).toMatchObject({ activePlanId: "q2", dirty: false, error: "", confirmation: null });
  });

  it("a failed save keeps the draft, does not switch, and names the field", async () => {
    const { controller, repository } = workspace(new MemoryRepository(), async () => "save");
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "полставки");
    expect(await controller.actions.selectPlan("q2")).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ activePlanId: "q1", dirty: true });
    expect(controller.getSnapshot().error).toBe("Не удалось сохранить. Сотрудник 1, ставка: введите число; дробную часть можно отделить запятой или точкой.");
    expect(controller.getSnapshot().draft?.members[0].fte).toBe("полставки");

    repository.save.mockRejectedValueOnce(new Error("Диск недоступен"));
    changeFte(controller, "0.5");
    expect(await controller.actions.closeProject()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ activePlanId: "q1", dirty: true, error: "Диск недоступен" });
    expect(repository.close).not.toHaveBeenCalled();
  });

  it("saves decimals typed with a comma even when the field did not lose focus", async () => {
    const { controller, repository } = workspace(new MemoryRepository(), async () => "save");
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    // The inputs replace "," with "." while typing and normalize on blur; the dialog takes focus first.
    changeFte(controller, "0.50");
    controller.actions.updateDraft((draft) => ({ ...draft, directions: [{ id: "product", name: "Продукт", percent: "100.0", kind: "work" as const, memberPercents: [] }],
      tasks: [{ id: "task", name: "Задача", directionId: "product", estimateHours: "1.0", mark: "plan" as const, link: null, comment: null }] }));
    expect(await controller.actions.selectPlan("q2")).toBe(true);
    const saved = repository.rows.get("q1")!.snapshot;
    expect([saved.members[0].fte, saved.directions[0].percent, saved.tasks[0].estimateHours]).toEqual(["0.5", "100", "1"]);
    expect(controller.getSnapshot()).toMatchObject({ activePlanId: "q2", notice: "Изменения квартала «1 квартал 2026 года» сохранены." });
  });

  it("shows the normalized values after saving and is not dirty", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, ",50");
    expect(await controller.actions.save()).toBe(true);
    expect(repository.rows.get("q1")?.snapshot.members[0].fte).toBe("0.5");
    expect(controller.getSnapshot().draft?.members[0].fte).toBe("0.5");
    expect(controller.getSnapshot().dirty).toBe(false);
  });

  it("the in-app dialog without saving cannot save, and a new project starts without the old notice", async () => {
    const { controller, repository } = workspace();
    await controller.actions.openProject(folderA);
    controller.actions.setPendingFormDirty(PROJECT_NAME_FORM, true);
    const switching = controller.actions.selectPlan("q1");
    await vi.waitFor(() => expect(controller.getSnapshot().confirmation?.canSave).toBe(false));
    controller.actions.answerDiscard("save");
    expect(await switching).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    controller.actions.setPendingFormDirty(PROJECT_NAME_FORM, false);

    changeFte(controller, "0.5");
    const opening = controller.actions.openProject(folderB);
    await vi.waitFor(() => expect(controller.getSnapshot().confirmation?.canSave).toBe(true));
    controller.actions.answerDiscard("save");
    expect(await opening).toBe(true);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toBe("");
  });

  it("does not offer saving while the team name is being edited", async () => {
    const confirm = vi.fn(async (_message: string, _canSave: boolean): Promise<DiscardAnswer> => "save");
    const { controller, repository } = workspace(new MemoryRepository(), confirm);
    await controller.actions.openProject(folderA);
    controller.actions.setPendingFormDirty(PROJECT_NAME_FORM, true);
    expect(await controller.actions.selectPlan("q1")).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Есть несохранённые изменения. Если продолжить, они будут потеряны.", false);
    expect(repository.save).not.toHaveBeenCalled();
  });
});

describe("new quarter copied from a saved quarter", () => {
  function teamPlan(planId: string, year: number, quarter: Quarter): StoredQuarterPlan {
    const calendar = createQuarterCalendar(year, quarter);
    if (!calendar.ok) throw new Error(calendar.message);
    return { planId, revision: 3, payloadVersion: 2, snapshot: {
      year, quarter, calendar: calendar.calendar, calendarSource: calendar.calendarSource,
      competencies: [{ id: "sa", name: "SA" }, { id: "java", name: "Java" }],
      members: [{ id: "ivan", name: "Иван", competencyId: "sa", fte: "1" }, { id: "olga", name: "Ольга", competencyId: "java", fte: "0.5" }],
      absences: [{ id: "vacation", memberId: "ivan", startDate: `${year}-${String(quarter * 3 - 1).padStart(2, "0")}-02`, endDate: `${year}-${String(quarter * 3 - 1).padStart(2, "0")}-06` }],
      directions: [{ id: "product", name: "Продукт", percent: "70", kind: "work" as const, memberPercents: [] }, { id: "meetings", name: "Встречи", percent: "30", kind: "work" as const, memberPercents: [] }],
      tasks: [{ id: "task", name: "Онбординг", directionId: "product", estimateHours: "40", mark: "plan" as const, link: null, comment: null }]
    } };
  }

  it("copies team, FTE, competencies and shares; absences, tasks and calendar are new", async () => {
    const { controller, repository } = workspace(new MemoryRepository([teamPlan("q4", 2026, 4)]));
    await controller.actions.openProject(folderA);
    expect(await controller.actions.createPlan(2027, 1, "ru-official", "q4")).toBe(true);
    const created = [...repository.rows.values()].find((plan) => plan.snapshot.year === 2027);
    const source = repository.rows.get("q4")!.snapshot;
    const calendar = createQuarterCalendar(2027, 1);
    if (!calendar.ok) throw new Error(calendar.message);
    expect(created?.snapshot).toEqual({
      year: 2027, quarter: 1, calendar: calendar.calendar, calendarSource: calendar.calendarSource,
      competencies: source.competencies, members: source.members, directions: source.directions, absences: [], tasks: []
    });
    expect(repository.rows.get("q4")).toEqual(teamPlan("q4", 2026, 4));
    expect(controller.getSnapshot()).toMatchObject({ activePlanId: created?.planId, dirty: false });
    expect(controller.getSnapshot().notice).toContain("скопированы сотрудники");
  });

  it("copies the saved version, not unsaved edits that were discarded", async () => {
    const { controller, repository } = workspace(new MemoryRepository([teamPlan("q4", 2026, 4)]), async () => true);
    await controller.actions.openProject(folderA);
    changeFte(controller, "0.25");
    expect(await controller.actions.createPlan(2027, 1, "ru-official", "q4")).toBe(true);
    const created = [...repository.rows.values()].find((plan) => plan.snapshot.year === 2027);
    expect(created?.snapshot.members.map((member) => member.fte)).toEqual(["1", "0.5"]);
  });

  it("copies edits saved from the dialog", async () => {
    const { controller, repository } = workspace(new MemoryRepository([teamPlan("q4", 2026, 4)]), async () => "save");
    await controller.actions.openProject(folderA);
    changeFte(controller, "0.25");
    expect(await controller.actions.createPlan(2027, 1, "ru-official", "q4")).toBe(true);
    const created = [...repository.rows.values()].find((plan) => plan.snapshot.year === 2027);
    expect(created?.snapshot.members.map((member) => member.fte)).toEqual(["0.25", "0.25"]);
    expect(repository.rows.get("q4")?.snapshot.members[0].fte).toBe("0.25");
  });

  it("without a source starts as before; an unknown source creates nothing", async () => {
    const { controller, repository } = workspace(new MemoryRepository([teamPlan("q4", 2026, 4)]));
    await controller.actions.openProject(folderA);
    expect(await controller.actions.createPlan(2027, 2, "ru-official", "missing")).toBe(false);
    expect(controller.getSnapshot().error).toBe("Квартал для копирования не найден.");
    expect(repository.create).not.toHaveBeenCalled();
    expect(await controller.actions.createPlan(2027, 2, "ru-official", null)).toBe(true);
    const created = [...repository.rows.values()].find((plan) => plan.snapshot.year === 2027);
    expect(created?.snapshot).toMatchObject({ members: [], directions: [], absences: [], tasks: [] });
    expect(created?.snapshot.competencies.map((competency) => competency.name)).toEqual(["SA", "BPMN", "Frontend", "Java", "Python", "QA"]);
  });
});

describe("exporting the saved quarter", () => {
  function peopleRows(report: QuarterReport) {
    return report.sheets.find((sheet) => sheet.name === "Люди")!.rows.map((row) => row.cells.map((cell) => cell.kind === "empty" ? null : cell.value));
  }

  it("exports the saved snapshot, not the draft, and only after saving", async () => {
    const { controller, dependencies, repository } = workspace();
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    expect(controller.getSnapshot().report).toEqual({ available: true, hint: "" });

    expect(await controller.actions.exportReport()).toBe(true);
    const [report] = dependencies.renderReport.mock.calls[0];
    expect(report.fileBaseName).toBe("Capacity Команда А 2026 Q1");
    expect(peopleRows(report)[0][2]).toBe("1");
    expect(report.sheets[0].rows[2].cells[1]).toEqual({ kind: "text", value: "05.10.2026 09:07" });
    expect(dependencies.saveReportFile).toHaveBeenCalledWith("Capacity Команда А 2026 Q1", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(controller.getSnapshot().notice).toBe("Отчёт сохранён: D:\\Отчёты\\Capacity Команда А 2026 Q1.xlsx");

    changeFte(controller, "0.5");
    expect(controller.getSnapshot().report).toEqual({ available: false, hint: "Сохраните квартал" });
    expect(await controller.actions.exportReport()).toBe(false);
    expect(controller.getSnapshot().error).toBe("Сохраните квартал.");
    expect(dependencies.saveReportFile).toHaveBeenCalledTimes(1);

    expect(await controller.actions.save()).toBe(true);
    expect(controller.getSnapshot().report.available).toBe(true);
    expect(await controller.actions.exportReport()).toBe(true);
    expect(peopleRows(dependencies.renderReport.mock.calls[1][0])[0][2]).toBe("0.5");
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("asks to finish a pending team rename before exporting", async () => {
    const { controller, dependencies } = workspace();
    await controller.actions.openProject(folderA);
    controller.actions.setPendingFormDirty(PROJECT_NAME_FORM, true);
    expect(controller.getSnapshot().report).toEqual({ available: false, hint: "Сохраните или отмените новое название команды" });
    expect(await controller.actions.exportReport()).toBe(false);
    expect(controller.getSnapshot().error).toBe("Сохраните или отмените новое название команды.");
    expect(dependencies.renderReport).not.toHaveBeenCalled();
    controller.actions.setPendingFormDirty(PROJECT_NAME_FORM, false);
    expect(controller.getSnapshot().report.available).toBe(true);
  });

  it("treats a cancelled dialog as neither success nor error", async () => {
    const { controller, dependencies } = workspace();
    await controller.actions.openProject(folderA);
    dependencies.saveReportFile.mockResolvedValueOnce({ status: "cancelled" });
    expect(await controller.actions.exportReport()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ error: "", notice: "", busy: false });
  });

  it("shows native and rendering failures in Russian", async () => {
    const { controller, dependencies } = workspace();
    await controller.actions.openProject(folderA);
    dependencies.saveReportFile.mockRejectedValueOnce("Не удалось сохранить отчёт: файл открыт в другой программе, например в Excel. Закройте его и повторите.");
    expect(await controller.actions.exportReport()).toBe(false);
    expect(controller.getSnapshot().error).toContain("файл открыт в другой программе");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    dependencies.renderReport.mockRejectedValueOnce(new Error("Sheet name is too long"));
    expect(await controller.actions.exportReport()).toBe(false);
    expect(controller.getSnapshot().error).toBe("Не удалось сформировать отчёт.");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not offer a report for a saved plan that cannot be calculated", async () => {
    const incomplete = savedPlan("q1", 1);
    const repository = new MemoryRepository([{ ...incomplete, snapshot: { ...incomplete.snapshot, calendar: incomplete.snapshot.calendar.slice(1) } }]);
    const { controller, dependencies } = workspace(repository);
    await controller.actions.openProject(folderA);
    expect(controller.getSnapshot().report).toEqual({ available: false, hint: "Отчёт появится после заполнения данных" });
    expect(await controller.actions.exportReport()).toBe(false);
    expect(dependencies.renderReport).not.toHaveBeenCalled();
  });

  it("does not reuse a cached calculation for a copied project with the same plan id and revision", async () => {
    const first = new MemoryRepository([savedPlan("q1", 1)]);
    const copy = savedPlan("q1", 1);
    const second = new MemoryRepository([{ ...copy, snapshot: { ...copy.snapshot, members: [{ ...copy.snapshot.members[0], fte: "0.25" }] } }]);
    second.session = { ...second.session, sessionKey: "session-b", name: "Команда Б", folderPath: folderB };
    const { controller, dependencies } = workspace(first);
    dependencies.openProject.mockImplementation(async (folder: string) => folder === folderA ? first : second);
    await controller.actions.openProject(folderA);
    expect(await controller.actions.exportReport()).toBe(true);
    await controller.actions.openProject(folderB);
    expect(await controller.actions.exportReport()).toBe(true);
    const [firstReport, secondReport] = dependencies.renderReport.mock.calls.map(([report]) => report);
    expect(peopleRows(firstReport)[0][2]).toBe("1");
    expect(peopleRows(secondReport)[0][2]).toBe("0.25");
    expect(secondReport.fileBaseName).toBe("Capacity Команда Б 2026 Q1");
  });

  it("closing waits until the save dialog has finished", async () => {
    const { controller, dependencies, repository } = workspace();
    await controller.actions.openProject(folderA);
    const dialog = deferred<ReportSaveOutcome>();
    dependencies.saveReportFile.mockImplementationOnce(() => dialog.promise);
    const exporting = controller.actions.exportReport();
    await vi.waitFor(() => expect(dependencies.saveReportFile).toHaveBeenCalled());
    expect(controller.getSnapshot().busy).toBe(true);
    const closing = controller.actions.closeProject();
    await Promise.resolve();
    expect(repository.close).not.toHaveBeenCalled();
    dialog.resolve({ status: "saved", path: "D:\\Отчёты\\q1.xlsx" });
    expect(await exporting).toBe(true);
    expect(await closing).toBe(true);
    expect(repository.close).toHaveBeenCalledTimes(1);
  });
});

describe("first save of a project made by 0.1.0–0.3.0 (DEC-044)", () => {
  const backup = `${folderA}\\capacity-backup-format1-2026-10-06.sqlite`;
  const legacy = () => new MemoryRepository([savedPlan("q1", 1), savedPlan("q2", 2)], 1);

  it("opens without writing and asks before the first save; cancelling writes nothing", async () => {
    const confirm = vi.fn(async (_message: string, _folder: string) => false);
    const { controller, repository } = workspace(legacy(), undefined, confirm);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    expect(repository.upgradeFormat).not.toHaveBeenCalled();
    changeFte(controller, "0.5");
    expect(await controller.actions.save()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "После обновления формата этот файл нельзя будет открыть в версии 0.3.0. Перед сохранением будет создана резервная копия исходного проекта.",
      folderA);
    expect(repository.upgradeFormat).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    const state = controller.getSnapshot();
    expect(state.dirty).toBe(true);
    expect(state.error).toBe("");
    expect(state.project?.schemaVersion).toBe(1);
  });

  it("upgrades with a backup, saves, names the backup and asks only once", async () => {
    const confirm = vi.fn(async () => true);
    const { controller, repository } = workspace(legacy(), undefined, confirm);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    expect(await controller.actions.save()).toBe(true);
    expect(repository.upgradeFormat).toHaveBeenCalledTimes(1);
    expect(repository.upgradeFormat.mock.invocationCallOrder[0]).toBeLessThan(repository.save.mock.invocationCallOrder[0]);
    const state = controller.getSnapshot();
    expect(state.notice).toBe(`Формат проекта обновлён. Резервная копия исходного проекта: ${backup}. Расчёт сохранён в папке проекта.`);
    expect(state.project?.schemaVersion).toBe(2);
    expect(state.dirty).toBe(false);
    changeFte(controller, "0.75");
    expect(await controller.actions.save()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(repository.upgradeFormat).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toBe("Расчёт сохранён в папке проекта.");
  });

  it("does not save when the upgrade fails and shows why", async () => {
    const repository = legacy();
    repository.upgradeFormat.mockRejectedValueOnce(new Error("Не удалось создать резервную копию проекта. Исходный файл не изменён."));
    const { controller } = workspace(repository, undefined, async () => true);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    expect(await controller.actions.save()).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    const state = controller.getSnapshot();
    expect(state.error).toBe("Не удалось создать резервную копию проекта. Исходный файл не изменён.");
    expect(state.dirty).toBe(true);
    expect(state.project?.schemaVersion).toBe(1);
  });

  it("still names the backup when the save after a successful upgrade fails", async () => {
    const repository = legacy();
    repository.save.mockRejectedValueOnce(new Error("Нет места на диске"));
    const { controller } = workspace(repository, undefined, async () => true);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    expect(await controller.actions.save()).toBe(false);
    const state = controller.getSnapshot();
    expect(state.error).toBe("Нет места на диске");
    expect(state.notice).toBe(`Формат проекта обновлён. Резервная копия исходного проекта: ${backup}.`);
    expect(state.project?.schemaVersion).toBe(2);
    expect(state.dirty).toBe(true);
  });

  it("«Сохранить и продолжить» with a declined upgrade keeps the user on the same quarter", async () => {
    const { controller, repository } = workspace(legacy(), async () => "save", async () => false);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    expect(await controller.actions.selectPlan("q2")).toBe(false);
    expect(controller.getSnapshot().activePlanId).toBe("q1");
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("asks before creating a quarter, because a new quarter is written at once", async () => {
    const confirm = vi.fn(async () => false);
    const { controller, repository } = workspace(legacy(), undefined, confirm);
    await controller.actions.openProject(folderA);
    expect(await controller.actions.createPlan(2026, 3)).toBe(false);
    expect(repository.create).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    expect(await controller.actions.createPlan(2026, 3)).toBe(true);
    expect(repository.upgradeFormat).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toBe(`Формат проекта обновлён. Резервная копия исходного проекта: ${backup}. Квартал создан. Заполните команду и сохраните расчёт.`);
  });

  it("keeps the backup in the notice when «Сохранить и продолжить» upgraded the file before a new quarter", async () => {
    const { controller, repository } = workspace(legacy(), async () => "save", async () => true);
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    expect(await controller.actions.createPlan(2026, 3)).toBe(true);
    expect(repository.upgradeFormat).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toBe(`Формат проекта обновлён. Резервная копия исходного проекта: ${backup}. Квартал создан. Заполните команду и сохраните расчёт.`);
  });

  it("shows the question in the window and continues after the answer", async () => {
    const { controller, repository } = workspace(legacy());
    await controller.actions.openProject(folderA);
    await controller.actions.selectPlan("q1");
    changeFte(controller, "0.5");
    const saving = controller.actions.save();
    await vi.waitFor(() => expect(controller.getSnapshot().formatUpgrade).not.toBeNull());
    expect(controller.getSnapshot().formatUpgrade).toEqual({
      message: "После обновления формата этот файл нельзя будет открыть в версии 0.3.0. Перед сохранением будет создана резервная копия исходного проекта.",
      folderPath: folderA
    });
    controller.actions.answerFormatUpgrade(true);
    expect(await saving).toBe(true);
    expect(controller.getSnapshot().formatUpgrade).toBeNull();
    expect(repository.save).toHaveBeenCalledTimes(1);
  });
});

describe("choosing the project folder", () => {
  it("creates or opens the project in the chosen folder", async () => {
    const { controller, dependencies } = workspace();
    expect(await controller.actions.chooseAndCreateProject("  Команда А  ")).toBe(true);
    expect(dependencies.pickFolder).toHaveBeenLastCalledWith("Выберите пустую папку для команды");
    expect(dependencies.createProject).toHaveBeenCalledWith(folderA, "Команда А");
    dependencies.pickFolder.mockResolvedValueOnce(folderB);
    expect(await controller.actions.chooseAndOpenProject()).toBe(true);
    expect(dependencies.pickFolder).toHaveBeenLastCalledWith("Выберите папку проекта");
    expect(dependencies.openProject).toHaveBeenCalledWith(folderB);
  });

  it("cancelling the dialog changes nothing and is not an error", async () => {
    const { controller, dependencies } = workspace();
    dependencies.pickFolder.mockResolvedValue(null);
    expect(await controller.actions.chooseAndCreateProject("Команда А")).toBe(false);
    expect(await controller.actions.chooseAndOpenProject()).toBe(false);
    expect(dependencies.createProject).not.toHaveBeenCalled();
    expect(dependencies.openProject).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ project: null, error: "", busy: false });
  });

  it("checks the team name before the dialog and reports dialog failures in Russian", async () => {
    const { controller, dependencies } = workspace();
    expect(await controller.actions.chooseAndCreateProject("   ")).toBe(false);
    expect(dependencies.pickFolder).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBe("Укажите название команды от 1 до 1000 символов.");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    dependencies.pickFolder.mockRejectedValueOnce(new Error("dialog unavailable"));
    expect(await controller.actions.chooseAndOpenProject()).toBe(false);
    expect(controller.getSnapshot().error).toBe("Не удалось выбрать папку. Попробуйте ещё раз.");
    consoleError.mockRestore();
  });

  it("closing the window waits until the folder dialog has finished", async () => {
    const { controller, dependencies, repository } = workspace();
    const dialog = deferred<string | null>();
    dependencies.pickFolder.mockImplementationOnce(() => dialog.promise);
    const opening = controller.actions.chooseAndOpenProject();
    await vi.waitFor(() => expect(dependencies.pickFolder).toHaveBeenCalled());
    let closed = false;
    const closing = controller.actions.closeProject().then((result) => { closed = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    // The folder picked after the close request is not opened: the window is closing.
    dialog.resolve(folderA);
    expect(await opening).toBe(false);
    expect(await closing).toBe(true);
    expect(dependencies.openProject).not.toHaveBeenCalled();
    expect(repository.close).not.toHaveBeenCalled();
    expect(controller.getSnapshot().project).toBeNull();
    // Later operations are not affected by the finished close request.
    expect(await controller.actions.chooseAndOpenProject()).toBe(true);
    expect(dependencies.openProject).toHaveBeenCalledWith(folderA);
  });
});
