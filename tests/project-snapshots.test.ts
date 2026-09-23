import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createProject, openProject, ProjectSnapshots, type ProjectSession } from "../src/db/project-snapshots";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { createQuarterCalendar } from "../src/domain/capacity/project-calendar";

const ipc = vi.fn<(command: string, args?: InvokeArgs) => Promise<unknown>>();
const session: ProjectSession = {
  sessionKey: "session-a", projectId: "team-a", name: "Команда А",
  folderPath: "D:\\Тест команды\\проект % #", schemaVersion: 1, sqliteVersion: "test-engine"
};

function draft(): QuarterSnapshot {
  return { year: 2026, quarter: 2, calendar: [], competencies: [], members: [], absences: [], directions: [], tasks: [] };
}

function row(overrides: Record<string, unknown> = {}) {
  return { plan_id: "plan-a", year: 2026, quarter: 2, revision: 1, payload_version: 1, payload_json: JSON.stringify(draft()), ...overrides };
}

beforeEach(() => {
  ipc.mockReset();
  vi.stubGlobal("window", { crypto: webcrypto });
  mockIPC((command, args) => ipc(command, args));
});
afterEach(() => { clearMocks(); vi.unstubAllGlobals(); });

describe("project snapshot adapter using the real SQL plugin JavaScript client", () => {
  it("opens a native session without plugin load or URL conversion", async () => {
    ipc.mockResolvedValue(session);
    const project = await openProject(session.folderPath);
    expect(project.session.sessionKey).toBe("session-a");
    expect(ipc.mock.calls).toEqual([["project_open", { folderPath: session.folderPath }]]);
    ipc.mockClear();
    await createProject(session.folderPath, session.name);
    expect(ipc.mock.calls).toEqual([["project_create", { folderPath: session.folderPath, name: session.name }]]);
  });

  it("renames metadata with a bound parameter, preserving project identity and folder", async () => {
    ipc.mockResolvedValueOnce([1, 0]);
    const project = new ProjectSnapshots(session);
    const previousSession = project.session;
    const name = "Команда '; DROP TABLE project_meta; --";
    const renamed = await project.rename(`  ${name}  `);
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc.mock.calls[0]).toEqual(["plugin:sql|execute", {
      db: session.sessionKey,
      query: "UPDATE project_meta SET name = $1 WHERE singleton = 1 AND project_id = $2",
      values: [name, session.projectId]
    }]);
    expect(renamed).toEqual({ ...session, name });
    expect(project.session).toEqual(renamed);
    expect(previousSession).toEqual(session);
    expect(Object.isFrozen(project.session)).toBe(true);
  });

  it("keeps the old name after a failed rename and closes only after explicit discard", async () => {
    ipc.mockRejectedValueOnce(new Error("Нет места на диске"));
    const project = new ProjectSnapshots(session);
    await expect(project.rename("Новое название")).rejects.toThrow("Нет места на диске");
    expect(project.session).toEqual(session);
    await expect(project.close()).rejects.toMatchObject({ code: "UNSAVED_CHANGES" });
    expect(ipc).toHaveBeenCalledTimes(1);
    ipc.mockResolvedValueOnce(undefined);
    await project.close({ discardFailedWrites: true });
    expect(ipc.mock.calls[1]).toEqual(["project_close", { sessionKey: session.sessionKey }]);
    await expect(project.rename("После закрытия")).rejects.toMatchObject({ code: "CLOSED" });
    expect(ipc).toHaveBeenCalledTimes(2);
  });

  it("does not claim a rename succeeded when its metadata row was not updated", async () => {
    ipc.mockResolvedValueOnce([0, 0]);
    const project = new ProjectSnapshots(session);
    await expect(project.rename("Новое название")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(project.session.name).toBe(session.name);
    ipc.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce(undefined);
    await project.rename("Успешная повторная запись");
    await project.close();
    expect(project.session.name).toBe("Успешная повторная запись");
    expect(ipc.mock.calls[2]).toEqual(["project_close", { sessionKey: session.sessionKey }]);
  });

  it.each(["", " \t\n ", "Я".repeat(1001)].map((name) => [name.length, name] as const))(
    "rejects an invalid name of length %s before IPC", async (_length, name) => {
    const project = new ProjectSnapshots(session);
    await expect(project.rename(name)).rejects.toMatchObject({ code: "INVALID_DATA" });
    expect(project.session.name).toBe(session.name);
    expect(ipc).not.toHaveBeenCalled();
    ipc.mockResolvedValueOnce(undefined);
    await project.close();
    expect(ipc.mock.calls).toEqual([["project_close", { sessionKey: session.sessionKey }]]);
  });

  it("round-trips calendar provenance and a manual override without replacing the saved source", async () => {
    const calendar = createQuarterCalendar(2026, 2);
    if (!calendar.ok) throw new Error(calendar.message);
    const input: QuarterSnapshot = {
      ...draft(),
      calendar: calendar.calendar.map((day) => day.date === "2026-04-04" ? { ...day, isWorking: true } : day),
      calendarSource: { ...calendar.calendarSource, version: "saved-bundle-version" }
    };
    ipc.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([row({ payload_json: JSON.stringify(input) })]);
    const project = new ProjectSnapshots(session);
    const created = await project.create("plan-a", input);
    expect(created.snapshot.calendarSource).toEqual(input.calendarSource);
    const written = JSON.parse((ipc.mock.calls[0][1] as { values: unknown[] }).values[4] as string);
    expect(written.calendarSource).toEqual(input.calendarSource);
    expect((await project.get("plan-a"))?.snapshot).toEqual(input);
  });

  it("writes a detached quarter in one parameterized statement and accepts a calendar draft", async () => {
    ipc.mockResolvedValue([1, 0]);
    const project = new ProjectSnapshots(session);
    const input = { ...draft() };
    const saved = project.create("plan'; DROP TABLE quarter_plans; --", input);
    input.year = 2030;
    expect((await saved).snapshot.year).toBe(2026);
    expect(ipc).toHaveBeenCalledTimes(1);
    const [command, args] = ipc.mock.calls[0];
    expect(command).toBe("plugin:sql|execute");
    expect(args).toMatchObject({ db: session.sessionKey, values: ["plan'; DROP TABLE quarter_plans; --", 2026, 2, 1, JSON.stringify(draft())] });
    expect((args as { query: string }).query).not.toContain("DROP TABLE");
  });

  it("preserves null estimates and invalid total allocation as a draft across read/write", async () => {
    const input = { ...draft() };
    input.directions = [{ id: "product", name: "Продукт", percent: "90" }];
    input.tasks = [{ id: "task", name: "Задача", directionId: "product", estimateHours: null }];
    ipc.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([row({ payload_json: JSON.stringify(input) })]);
    const project = new ProjectSnapshots(session);
    await project.create("plan-a", input);
    expect((await project.get("plan-a"))?.snapshot).toEqual(input);
  });

  it("rejects a stale CAS without retrying or claiming the write succeeded", async () => {
    ipc.mockResolvedValueOnce([0, 0]);
    const project = new ProjectSnapshots(session);
    await expect(project.save("plan-a", 3, draft())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc.mock.calls[0][1]).toMatchObject({ values: [JSON.stringify(draft()), "plan-a", 3, 2026, 2, 1] });
    await expect(project.close()).rejects.toMatchObject({ code: "UNSAVED_CHANGES" });
    expect(ipc).toHaveBeenCalledTimes(1);
    ipc.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce(undefined);
    expect((await project.save("plan-a", 4, draft())).revision).toBe(5);
    await project.close();
    expect(ipc.mock.calls[ipc.mock.calls.length - 1]?.[0]).toBe("project_close");
  });

  it("does not clear another plan's failed write after saving a different plan", async () => {
    ipc.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce([1, 0]);
    const project = new ProjectSnapshots(session);
    await expect(project.save("plan-a", 1, draft())).rejects.toThrow("disk full");
    await project.save("plan-b", 1, draft());
    await expect(project.close()).rejects.toMatchObject({ code: "UNSAVED_CHANGES" });
    ipc.mockResolvedValueOnce(undefined);
    await project.close({ discardFailedWrites: true });
  });

  it("drains in-flight writes before closing only its own session", async () => {
    let finish!: (value: unknown) => void;
    ipc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    ipc.mockResolvedValueOnce(undefined);
    const project = new ProjectSnapshots(session);
    const saved = project.save("plan-a", 1, draft());
    await Promise.resolve();
    const closed = project.close();
    await expect(project.get("plan-a")).rejects.toMatchObject({ code: "CLOSED" });
    expect(ipc).toHaveBeenCalledTimes(1);
    finish([1, 0]);
    await saved;
    await closed;
    expect(ipc.mock.calls[1]).toEqual(["project_close", { sessionKey: session.sessionKey }]);
    await project.close();
    expect(ipc).toHaveBeenCalledTimes(2);
  });

  it.each([
    row({ payload_version: 2 }), row({ payload_json: "{" }), row({ year: 2025 }),
    row({ revision: 0 }), row({ payload_json: JSON.stringify({ ...draft(), members: [{ id: "x", name: "X", competencyId: "missing", fte: "1" }] }) })
  ])("rejects a corrupt or unsupported row on read", async (value) => {
    ipc.mockResolvedValue([value]);
    await expect(new ProjectSnapshots(session).get("plan-a")).rejects.toMatchObject({ code: "INVALID_DATA" });
  });

  it("rejects invalid input before any IPC write", async () => {
    const project = new ProjectSnapshots(session);
    await expect(project.create("plan", { ...draft(), tasks: [{ id: "task", name: "X", directionId: "unknown", estimateHours: "-1" }] })).rejects.toMatchObject({ code: "INVALID_DATA" });
    await expect(project.save("plan", Number.MAX_SAFE_INTEGER, draft())).rejects.toMatchObject({ code: "INVALID_DATA" });
    expect(ipc).not.toHaveBeenCalled();
  });

  it("uses a distinct native key for each project's queries", async () => {
    ipc.mockResolvedValue([]);
    await new ProjectSnapshots(session).list();
    await new ProjectSnapshots({ ...session, sessionKey: "session-b", projectId: "team-b" }).list();
    expect(ipc.mock.calls.map(([, args]) => (args as { db: string }).db)).toEqual(["session-a", "session-b"]);
  });
});
