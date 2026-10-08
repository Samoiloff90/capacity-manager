import { describe, expect, it } from "vitest";
import golden from "./fixtures/compat-0.3.0.json";
import acceptance from "./fixtures/capacity-acceptance.json";
import { asRecorded } from "./fixtures/as-recorded";
import { readmeQuarter } from "./fixtures/readme-quarter";
import { getQuarterDates } from "../src/domain/capacity/calendar-quarter";
import { describeDirectionBalance } from "../src/domain/capacity/direction-balance";
import { describeQuarterPlanStatus } from "../src/domain/capacity/plan-status";
import { copyQuarterSetup } from "../src/domain/capacity/quarter-copy";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { QUARTER_PAYLOAD_VERSION, readStoredQuarterSnapshot, upgradeQuarterSnapshotV1 } from "../src/domain/capacity/quarter-snapshot-format";
import { isWebLink, validateQuarterSnapshot } from "../src/domain/capacity/quarter-snapshot.validation";
import { describeQuarterTotals } from "../src/domain/capacity/quarter-totals";
import { decimalToString, parseDecimal, subtractDecimal } from "../src/domain/capacity/decimal-exact";
import { buildQuarterReport, type QuarterReport, type ReportCell } from "../src/export/quarter-report";

function read(version: number, payload: unknown): QuarterSnapshot {
  const result = readStoredQuarterSnapshot(version, payload);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.snapshot;
}

function calculate(snapshot: QuarterSnapshot): QuarterCapacityResult {
  const output = calculateQuarterCapacity(snapshot);
  if (!output.ok) throw new Error(JSON.stringify(output.errors));
  return output.result;
}

type GoldenCase = {
  id: string;
  readmeChanges?: { directions: unknown[]; tasks: unknown[] };
  acceptanceCase?: string;
  result: unknown; totals: unknown; balances: unknown; status: unknown; report?: unknown;
};

/** The quarter exactly as 0.3.0 stored it: the README fixture or an acceptance case, format 1. */
function legacySnapshot(item: GoldenCase): unknown {
  if (item.readmeChanges) {
    const { directions: _directions, tasks: _tasks, ...setup } = readmeQuarter();
    return { ...setup, directions: item.readmeChanges.directions, tasks: item.readmeChanges.tasks };
  }
  return acceptance.cases.find((candidate) => candidate.id === item.acceptanceCase)!.snapshot;
}

describe("quarters saved by 0.3.0 keep their numbers (DEC-044)", () => {
  const cases = golden.cases as GoldenCase[];

  it("covers README variants and every acceptance case", () => {
    expect(cases).toHaveLength(4 + acceptance.cases.length);
  });

  it.each(cases.map((item) => [item.id, item] as const))("%s: same capacity, balances and plan status as 0.3.0", (_id, item) => {
    const snapshot = read(1, legacySnapshot(item));
    const result = calculate(snapshot);
    expect(asRecorded(result, item.result)).toEqual(item.result);
    // Directions read as work sources: every work is in the plan and the quota is the share.
    expect(result.directions.every((direction) => direction.kind === "work" && direction.quotaSet === (direction.percent !== null)
      && direction.planCount === direction.missingEstimateCount + snapshot.tasks.filter((task) => task.directionId === direction.directionId && task.estimateHours !== null).length
      && direction.candidateCount === 0 && direction.outCount === 0)).toBe(true);
    expect(result.plan.reserveHours).toBe("0");
    expect(result.plan.plannedKnownHours).toBe(result.totals.knownDemandHours);
    expect(describeQuarterTotals(result)).toEqual(item.totals);
    expect(result.directions.map((direction) => describeDirectionBalance(direction))).toEqual(item.balances);
    expect(describeQuarterPlanStatus(result)).toEqual(item.status);
    if (item.report) {
      // The layout of 0.3.0 gave way to the report of the quarter planner (B-1, DEC-053); its numbers stay those 0.3.0 wrote.
      const recorded = item.report as QuarterReport;
      const report = buildQuarterReport({ teamName: "Тестовая команда", snapshot, result, exportedAt: new Date(golden.exportedAt) });
      const rowsOf = (from: QuarterReport, name: string) => from.sheets.find((sheet) => sheet.name === name)!.rows;
      for (const name of ["Люди", "Компетенции", "Отсутствия"]) expect(rowsOf(report, name)).toEqual(rowsOf(recorded, name));
      const sources = rowsOf(report, "Источники").slice(0, -1);
      const directions = rowsOf(recorded, "Направления");
      // Name, share, budget, demand and works without an estimate, in the same order.
      expect(sources.map((row) => [row.cells[0], row.cells[2], row.cells[4], row.cells[5], row.cells[6]]))
        .toEqual(directions.map((row) => [row.cells[0], row.cells[1], row.cells[2], row.cells[3], row.cells[4]]));
      // The signed rest of 0.3.0 is now a rest and an overrun.
      const hoursOf = (cell: ReportCell) => cell.kind === "hours" ? parseDecimal(cell.value) : null;
      expect(sources.map((row) => decimalToString(subtractDecimal(hoursOf(row.cells[7])!, hoursOf(row.cells[8])!))))
        .toEqual(directions.map((row) => (row.cells[5] as { value: string }).value));
      // Every work of 0.3.0 is in the plan, with its source and estimate; «Не оценена» is now «Без оценки».
      const estimateOf = (cell: ReportCell) => cell.kind === "hours" ? cell.value : null;
      const works = rowsOf(report, "Работы").map((row) => [row.cells[1], row.cells[0], estimateOf(row.cells[3]), row.cells[2]]);
      const tasks = rowsOf(recorded, "Задачи").map((row) => [row.cells[0], row.cells[1], estimateOf(row.cells[2]), { kind: "text", value: "В плане квартала" }]);
      const byName = (left: unknown[], right: unknown[]) => JSON.stringify(left).localeCompare(JSON.stringify(right));
      expect(works.sort(byName)).toEqual(tasks.sort(byName));
      const summaryOf = (from: QuarterReport) => new Map(rowsOf(from, "Сводка").map((row) => [(row.cells[0] as { value: string }).value, row.cells[1]]));
      const [now, then] = [summaryOf(report), summaryOf(recorded)];
      expect(now.get("Доступно команде, ч")).toEqual(then.get("Доступно часов команды"));
      expect(now.get("Работ в плане без оценки")).toEqual(then.get("Задач без оценки"));
      expect(now.get("Занято работами в плане, ч") ?? now.get("Занято работами в плане, не менее, ч"))
        .toEqual(then.get("Потребность задач, ч") ?? then.get("Известная потребность задач, ч"));
    }
  });

  it("turns directions into work sources and tasks into works in the plan, nothing else", () => {
    const legacy = legacySnapshot(cases[1]) as Parameters<typeof upgradeQuarterSnapshotV1>[0];
    const upgraded = upgradeQuarterSnapshotV1(legacy);
    expect(upgraded.directions.every((direction) => direction.kind === "work" && direction.memberPercents.length === 0)).toBe(true);
    expect(upgraded.tasks.every((task) => task.mark === "plan" && task.link === null && task.comment === null)).toBe(true);
    expect(upgraded.tasks.map(({ id, name, directionId, estimateHours }) => ({ id, name, directionId, estimateHours }))).toEqual(legacy.tasks);
    // «Встречи…» is not guessed to be a reserve.
    expect(upgraded.directions.find((direction) => direction.name.startsWith("Встречи"))?.kind).toBe("work");
    expect({ ...upgraded, directions: undefined, tasks: undefined }).toEqual({ ...legacy, directions: undefined, tasks: undefined });
  });

  it("reads format 2 as is and rejects other versions", () => {
    expect(QUARTER_PAYLOAD_VERSION).toBe(2);
    const snapshot = readmeQuarter();
    expect(read(2, snapshot)).toEqual(snapshot);
    expect(readStoredQuarterSnapshot(3, snapshot)).toMatchObject({ ok: false, errors: [{ code: "unsupported_version" }] });
    // A format-1 payload is not silently accepted as format 2, and the other way round.
    expect(readStoredQuarterSnapshot(2, legacySnapshot(cases[0])).ok).toBe(false);
    expect(readStoredQuarterSnapshot(1, snapshot).ok).toBe(false);
  });
});

/** 5 people × 25 working days × 8 h = 1 000 h; a 25% source gets 250 h. */
function controlQuarter(tasks: QuarterSnapshot["tasks"]): QuarterSnapshot {
  const dates = getQuarterDates(2027, 2);
  return {
    year: 2027, quarter: 2,
    calendar: dates.map((date, index) => ({ date, isWorking: index < 25 })),
    competencies: [{ id: "dev", name: "Разработка" }],
    members: ["a", "b", "c", "d", "e"].map((id) => ({ id, name: `Сотрудник ${id}`, competencyId: "dev", fte: "1" })),
    absences: [],
    directions: [
      { id: "ui", name: "УИ", percent: "25", kind: "work", memberPercents: [] },
      { id: "rest", name: "Остальное", percent: "75", kind: "work", memberPercents: [] }
    ],
    tasks
  };
}
const work = (id: string, estimateHours: string | null, mark: "candidate" | "plan" | "out" = "plan") =>
  ({ id, name: `Работа ${id}`, directionId: "ui", estimateHours, mark, link: null, comment: null });

describe("control example of DEC-041: one full estimate in hours", () => {
  it("quota 250 h, other works 200 h; a 28 h work leaves 22 h; its estimate changed to 34 h leaves 16 h", () => {
    const others = [work("w1", "120"), work("w2", "80")];
    const before = calculate(controlQuarter(others)).directions.find((row) => row.directionId === "ui")!;
    expect([before.budgetHours, before.knownDemandHours, before.remainingKnownHours]).toEqual(["250", "200", "50"]);
    const added = calculate(controlQuarter([...others, work("new", "28")])).directions.find((row) => row.directionId === "ui")!;
    expect([added.knownDemandHours, added.remainingKnownHours, added.overrunKnownHours]).toEqual(["228", "22", "0"]);
    // The new estimate replaces the old one; it is not added to it.
    const changed = calculate(controlQuarter([...others, work("new", "34")])).directions.find((row) => row.directionId === "ui")!;
    expect([changed.knownDemandHours, changed.remainingKnownHours, changed.overrunKnownHours]).toEqual(["234", "16", "0"]);
  });

  it("counts only works in the quarter plan; candidates and «Не в этом квартале» take no budget", () => {
    const row = calculate(controlQuarter([work("w1", "200"), work("c", "40", "candidate"), work("o", "30", "out"), work("n", null, "candidate")]))
      .directions.find((item) => item.directionId === "ui")!;
    expect([row.knownDemandHours, row.missingEstimateCount, row.remainingKnownHours]).toEqual(["200", 0, "50"]);
  });

  it("keeps 0 h and no estimate apart (DEC-043)", () => {
    const zero = calculate(controlQuarter([work("w1", "0")])).directions.find((item) => item.directionId === "ui")!;
    expect([zero.knownDemandHours, zero.missingEstimateCount, zero.demandComplete]).toEqual(["0", 0, true]);
    const unknown = calculate(controlQuarter([work("w1", null)])).directions.find((item) => item.directionId === "ui")!;
    expect([unknown.knownDemandHours, unknown.missingEstimateCount, unknown.demandComplete]).toEqual(["0", 1, false]);
    expect(validateQuarterSnapshot(controlQuarter([work("w1", "-1")])).ok).toBe(false);
  });

  it("treats a share not set yet as 0 h and an incomplete allocation, not as an error", () => {
    const snapshot = { ...controlQuarter([]), directions: [
      { id: "ui", name: "УИ", percent: null, kind: "work" as const, memberPercents: [] },
      { id: "rest", name: "Остальное", percent: "100", kind: "work" as const, memberPercents: [] }
    ] };
    const result = calculate(snapshot);
    expect(result.directions.find((row) => row.directionId === "ui")).toMatchObject({ percent: null, budgetHours: "0", budgetComplete: false });
    expect(result.allocation).toEqual({ totalPercent: "100", status: "underallocated" });
  });
});

describe("plan status and manager report with the fields of format 2", () => {
  const snapshot = () => ({ ...controlQuarter([work("p", "10"), work("c", "5", "candidate"), work("o", "3", "out")]), directions: [
    { id: "ui", name: "УИ", percent: null, kind: "work" as const, memberPercents: [] },
    { id: "rest", name: "Остальное", percent: "100", kind: "work" as const, memberPercents: [] }
  ] });

  it("names a share not set yet instead of «100% вместо 100%»", () => {
    expect(describeQuarterPlanStatus(calculate(snapshot()))).toEqual({ ready: false, reasons: ["Доля задана не у всех направлений."] });
  });

  it("shows «не задана» for such a share and lists every work with its decision (B-1)", () => {
    const quarter = snapshot();
    const report = buildQuarterReport({ teamName: "Команда", snapshot: quarter, result: calculate(quarter), exportedAt: new Date("2026-10-06T09:00:00Z") });
    const sheet = (name: string) => report.sheets.find((item) => item.name === name)!;
    const ui = sheet("Источники").rows.find((row) => row.cells[0].kind === "text" && row.cells[0].value === "УИ")!;
    expect(ui.cells[2]).toEqual({ kind: "text", value: "не задана" });
    expect(sheet("Работы").rows.map((row) => [row.cells[1], row.cells[2], row.cells[4]].map((cell) => (cell as { value: string }).value))).toEqual([
      ["Работа p", "В плане квартала", "да"], ["Работа c", "На рассмотрении", "нет"], ["Работа o", "Не в этом квартале", "нет"]
    ]);
  });
});

describe("format 2 is strict", () => {
  const base = () => controlQuarter([work("w1", "10")]);
  const invalid = (snapshot: unknown, path: string) => {
    const result = validateQuarterSnapshot(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.path)).toContain(path);
  };

  it("requires every new field, without implicit defaults", () => {
    const snapshot = base();
    invalid({ ...snapshot, tasks: [{ id: "w1", name: "Работа", directionId: "ui", estimateHours: "1" }] }, "tasks.0.mark");
    invalid({ ...snapshot, directions: [{ id: "ui", name: "УИ", percent: "25" }, snapshot.directions[1]] }, "directions.0.kind");
    invalid({ ...snapshot, tasks: [{ ...work("w1", "1"), mark: "in-progress" }] }, "tasks.0.mark");
  });

  it("keeps own shares only for a reserve and only for people of this quarter", () => {
    const snapshot = base();
    invalid({ ...snapshot, directions: [{ ...snapshot.directions[0], memberPercents: [{ memberId: "a", percent: "30" }] }, snapshot.directions[1]] },
      "directions.0.memberPercents");
    const reserve = { id: "meet", name: "Встречи", percent: "20", kind: "reserve" as const, memberPercents: [{ memberId: "nobody", percent: "30" }] };
    invalid({ ...snapshot, directions: [...snapshot.directions, reserve] }, "directions.2.memberPercents.0.memberId");
    invalid({ ...snapshot, directions: [...snapshot.directions, { ...reserve, memberPercents: [{ memberId: "a", percent: "30" }, { memberId: "a", percent: "40" }] }] },
      "directions.2.memberPercents.1.memberId");
    invalid({ ...snapshot, directions: [...snapshot.directions, { ...reserve, memberPercents: [{ memberId: "a", percent: "130" }] }] },
      "directions.2.memberPercents.0.percent");
    expect(validateQuarterSnapshot({ ...snapshot, directions: [...snapshot.directions, { ...reserve, memberPercents: [{ memberId: "a", percent: "30" }] }] }).ok).toBe(true);
    // A reserve has no works (DEC-030).
    invalid({ ...snapshot, directions: [...snapshot.directions, { ...reserve, memberPercents: [] }], tasks: [{ ...work("w1", "1"), directionId: "meet" }] },
      "tasks.0.directionId");
  });

  it("accepts only an http(s) link without credentials", () => {
    for (const link of ["https://kaiten.example/space/hr/card/48120", "http://kaiten.local/card/1?x=1#y"]) {
      expect(isWebLink(link)).toBe(true);
      expect(validateQuarterSnapshot({ ...base(), tasks: [{ ...work("w1", "1"), link }] }).ok).toBe(true);
    }
    for (const link of ["javascript:alert(1)", "file:///C:/Windows/system32/calc.exe", "ftp://host/file", "https://user:secret@host/x",
      " https://host/x", "https://host/a b", "kaiten 48311", "C:\\file.exe", `https://host/${"x".repeat(2048)}`, "https://"]) {
      expect(isWebLink(link), link).toBe(false);
      invalid({ ...base(), tasks: [{ ...work("w1", "1"), link }] }, "tasks.0.link");
    }
    invalid({ ...base(), tasks: [{ ...work("w1", "1"), comment: "я".repeat(2001) }] }, "tasks.0.comment");
  });

  it("copies the reserve with own shares to a new quarter; works stay behind", () => {
    const reserve = { id: "meet", name: "Встречи", percent: "20", kind: "reserve" as const, memberPercents: [{ memberId: "a", percent: "30" }] };
    const source = { ...base(), directions: [...base().directions, reserve] };
    const copied = copyQuarterSetup(source, { year: 2027, quarter: 3, calendar: [], calendarSource: { kind: "manual", version: "test", baseWorkingDates: [] } });
    expect(copied.directions).toEqual(source.directions);
    expect(copied.tasks).toEqual([]);
  });
});
