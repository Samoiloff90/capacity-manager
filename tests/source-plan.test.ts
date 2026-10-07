import { describe, expect, it } from "vitest";
import { currentDemoQuarter } from "./fixtures/demo-projects";
import { getQuarterDates } from "../src/domain/capacity/calendar-quarter";
import { formatScreenHours } from "../src/domain/capacity/input-format";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import {
  describeAllocation, describeEstimateChange, describeInclusion, describeInclusionShort, describePlanned,
  describeQuotaDrops, describeRest, describeSaveProblems, effectivePercent, fillPercent, forecastSource,
  parseEstimateInput, parseShareInput, ratioPercent, sourceState
} from "../src/domain/capacity/source-plan";

const hours = (value: string) => formatScreenHours(value).replace(/ /g, " ");

function calculate(snapshot: QuarterSnapshot): QuarterCapacityResult {
  const output = calculateQuarterCapacity(snapshot);
  if (!output.ok) throw new Error(JSON.stringify(output.errors));
  return output.result;
}
const source = (result: QuarterCapacityResult, id: string) => result.directions.find((row) => row.directionId === id)!;

type Direction = QuarterSnapshot["directions"][number];
type Work = QuarterSnapshot["tasks"][number];
const work = (id: string, directionId: string, estimateHours: string | null, mark: Work["mark"] = "plan"): Work =>
  ({ id, name: `Работа ${id}`, directionId, estimateHours, mark, link: null, comment: null });
const direction = (id: string, percent: string | null, extra: Partial<Direction> = {}): Direction =>
  ({ id, name: `Источник ${id}`, percent, kind: "work", memberPercents: [], ...extra });

/** `days` working days; each person's hours are days × 8 × FTE. */
function quarter(days: number, fte: string[], directions: Direction[], tasks: Work[] = []): QuarterSnapshot {
  const dates = getQuarterDates(2027, 2);
  return {
    year: 2027, quarter: 2,
    calendar: dates.map((date, index) => ({ date, isWorking: index < days })),
    competencies: [{ id: "dev", name: "Разработка" }],
    members: fte.map((value, index) => ({ id: `p${index + 1}`, name: `Сотрудник ${index + 1}`, competencyId: "dev", fte: value })),
    absences: [], directions, tasks
  };
}

describe("reserve by person (DEC-038)", () => {
  it("80 h × 30% + 40 h × 40% = 24 + 16 = 40 h; the own share replaces the common one", () => {
    const reserve = direction("meet", "30", { kind: "reserve", memberPercents: [{ memberId: "p2", percent: "40" }] });
    const result = calculate(quarter(10, ["1", "0.5"], [reserve]));
    const row = source(result, "meet");
    expect(result.totals.availableHours).toBe("120");
    expect(row.budgetHours).toBe("40");
    expect(row.reserveMembers).toEqual([
      { memberId: "p1", availableHours: "80", percent: "30", own: false, reserveHours: "24" },
      { memberId: "p2", availableHours: "40", percent: "40", own: true, reserveHours: "16" }
    ]);
    expect([row.quotaSet, row.ownPercentCount]).toEqual([true, 1]);
    expect(effectivePercent(row, result.totals.availableHours)).toBe("33.33");
    expect(result.plan.reserveHours).toBe("40");
  });

  it("without own shares the reserve is the common share of all available hours", () => {
    const result = calculate(quarter(10, ["1", "0.5"], [direction("meet", "30", { kind: "reserve" })]));
    expect(source(result, "meet").budgetHours).toBe("36");
    expect(effectivePercent(source(result, "meet"), result.totals.availableHours)).toBe("30");
  });

  it("is not set while someone has neither an own nor a common share", () => {
    const reserve = direction("meet", null, { kind: "reserve", memberPercents: [{ memberId: "p2", percent: "40" }] });
    const row = source(calculate(quarter(10, ["1", "0.5"], [reserve])), "meet");
    expect([row.quotaSet, row.budgetHours]).toEqual([false, "0"]);
    expect(row.reserveMembers.map((person) => person.reserveHours)).toEqual([null, "16"]);
  });

  it("customer shares are still taken from all available hours, before reserves", () => {
    const result = calculate(quarter(10, ["1", "0.5"], [
      direction("meet", "30", { kind: "reserve", memberPercents: [{ memberId: "p2", percent: "40" }] }),
      direction("ui", "25")
    ]));
    expect(source(result, "ui").budgetHours).toBe("30");
    expect(result.plan.allocatedHours).toBe("70");
    expect(result.plan.unallocatedHours).toBe("50");
  });
});

describe("quotas follow the capacity (DEC-031)", () => {
  it("25% of 1 000 h is 250 h; at 800 h it is 200 h; 230 h in the plan is an overrun of 30 h", () => {
    const tasks = [work("a", "ui", "130"), work("b", "ui", "100")];
    const full = calculate(quarter(25, ["1", "1", "1", "1", "1"], [direction("ui", "25"), direction("rest", "75")], tasks));
    expect([source(full, "ui").budgetHours, source(full, "ui").remainingKnownHours]).toEqual(["250", "20"]);
    const smaller = calculate(quarter(25, ["1", "1", "1", "1"], [direction("ui", "25"), direction("rest", "75")], tasks));
    expect([source(smaller, "ui").percent, source(smaller, "ui").budgetHours, source(smaller, "ui").overrunKnownHours]).toEqual(["25", "200", "30"]);
    // Nothing is excluded or rescaled: the works stay in the plan and the overrun is shown.
    expect(source(smaller, "ui").planCount).toBe(2);
    expect(describeQuotaDrops(full, smaller, hours)).toEqual(["«Источник ui» — квота 250 ч → 200 ч, в плане 230 ч, перебор 30 ч"]);
    expect(describeSaveProblems(smaller, hours)).toEqual(["перебор квоты — «Источник ui» 30 ч"]);
  });
});

describe("control example of DEC-041 with the consequences shown on screen", () => {
  const others = [work("w1", "ui", "120"), work("w2", "ui", "80")];
  const setup = (tasks: Work[]) => calculate(quarter(25, ["1", "1", "1", "1", "1"], [direction("ui", "25"), direction("rest", "75")], tasks));

  it("quota 250 h, 200 h in the plan: +28 h gives 228 h and 22 h; 34 h instead gives 234 h and 16 h", () => {
    const before = source(setup(others), "ui");
    expect(describeInclusion(before, "28", hours)).toBe("После включения работы на 28 ч в плане будет 228 ч, останется 22 ч.");
    expect(forecastSource(before, { add: ["28"] })).toMatchObject({ plannedKnownHours: "228", remainingHours: "22", overrunHours: "0" });

    const added = source(setup([...others, work("new", "ui", "28")]), "ui");
    expect([added.knownDemandHours, added.remainingKnownHours]).toEqual(["228", "22"]);
    expect(describeEstimateChange(added, "28", "34", true, hours)).toBe("Оценка: 28 ч → 34 ч. Остаток квоты станет 16 ч.");

    const changed = source(setup([...others, work("new", "ui", "34")]), "ui");
    expect([changed.knownDemandHours, changed.remainingKnownHours, changed.overrunKnownHours]).toEqual(["234", "16", "0"]);
    expect(describePlanned(sourceState(changed), hours)).toBe("234 ч");
    expect(describeRest(sourceState(changed), hours)).toBe("остаток 16 ч");
  });

  it("a candidate and a work «Не в этом квартале» take no budget; including a candidate does", () => {
    const result = setup([...others, work("c", "ui", "28", "candidate"), work("o", "ui", "40", "out")]);
    const row = source(result, "ui");
    expect([row.knownDemandHours, row.planCount, row.candidateCount, row.candidateKnownHours, row.outCount]).toEqual(["200", 2, 1, "28", 1]);
    expect(describeInclusionShort(row, "28", hours)).toBe("В плане будет 228 ч, останется 22 ч");
    expect(describeEstimateChange(row, "28", "34", false, hours)).toBe("Оценка: 28 ч → 34 ч. Бюджет не занимает, пока работа не в плане квартала.");
  });

  it("without an estimate the remainder is an upper bound and the plan a lower bound", () => {
    const row = source(setup(others), "ui");
    expect(describeInclusion(row, null, hours)).toBe("Оценки нет, поэтому точный остаток пока неизвестен: останется не более 50 ч.");
    const vague = source(setup([...others, work("n", "ui", null)]), "ui");
    expect(describeRest(sourceState(vague), hours)).toBe("остаток не более 50 ч");
    expect(describeInclusion(vague, "16", hours)).toBe("После включения работы на 16 ч в плане будет не менее 216 ч, останется не более 34 ч.");
    expect(describeInclusion(row, "60", hours)).toBe("После включения работы на 60 ч в плане будет 260 ч, перебор 10 ч.");
  });

  it("0 h and no estimate stay apart (DEC-043)", () => {
    const zero = source(setup([...others, work("z", "ui", "0")]), "ui");
    const unknown = source(setup([...others, work("u", "ui", null)]), "ui");
    expect([zero.knownDemandHours, zero.missingEstimateCount]).toEqual(["200", 0]);
    expect([unknown.knownDemandHours, unknown.missingEstimateCount]).toEqual(["200", 1]);
  });
});

describe("shares that are empty, too large or of nobody's capacity", () => {
  it("an empty share is «доля не задана», not an error and not 0%", () => {
    const result = calculate(quarter(10, ["1"], [direction("ui", null), direction("rest", "50")], [work("c", "ui", "8", "candidate")]));
    const row = source(result, "ui");
    expect([row.quotaSet, row.budgetHours, row.candidateCount]).toEqual([false, "0", 1]);
    expect(describeRest(sourceState(row), hours)).toBe("доля не задана");
    expect(describeInclusion(row, "8", hours)).toBe("Доля источника не задана: остаток появится, когда будет задана доля.");
    expect(result.plan.unsetQuotaCount).toBe(1);
    expect(describeAllocation(result)).toMatchObject({ allocatedPercent: "50", unallocatedHours: "40", overallocated: false });
  });

  it("shares above 100% are shown with the excess in hours, and the quarter can still be saved", () => {
    const result = calculate(quarter(10, ["1"], [direction("a", "60"), direction("b", "46")]));
    expect(describeAllocation(result)).toEqual({ allocatedHours: "84.8", allocatedPercent: "106", unallocatedHours: "-4.8", unallocatedPercent: "-6", overallocated: true });
    expect(describeSaveProblems(result, hours)).toEqual(["сумма долей 106%, на 4,80 ч больше доступной ёмкости"]);
  });

  it("no available hours: quotas are 0 h without a division by zero, the entered shares still tell an excess", () => {
    const result = calculate(quarter(10, [], [direction("a", "60"), direction("b", "46")], [work("w", "a", "10")]));
    expect(result.totals.availableHours).toBe("0");
    expect(source(result, "a")).toMatchObject({ budgetHours: "0", overrunKnownHours: "10" });
    expect(ratioPercent("10", "0")).toBeNull();
    expect(fillPercent(source(result, "a"))).toBeNull();
    expect(describeAllocation(result)).toMatchObject({ allocatedPercent: "106", overallocated: true });
  });
});

describe("team balance: reserve → works → rests of quotas → not allocated", () => {
  it("adds up the demo project: 2 000 h, reserve 344,8 h, quotas, an overrun of 20 h", () => {
    const result = calculate(currentDemoQuarter());
    expect(result.plan).toEqual({
      reserveCount: 1, reserveHours: "344.8", allocatedHours: "1694.8", unallocatedHours: "305.2",
      overallocated: false, nominalPercent: "82.5", unsetQuotaCount: 0,
      planCount: 8, plannedKnownHours: "980", plannedMissingEstimateCount: 1,
      // Product 200 h (upper bound) + requests 50 h + tech debt 140 h; mobile is over by 20 h.
      remainingHours: "390", overrunHours: "20", overrunSourceCount: 1
    });
    expect(describeAllocation(result)).toMatchObject({ allocatedPercent: "84.74", unallocatedPercent: "15.26" });
    expect(source(result, "src-meetings").reserveMembers.map((person) => person.reserveHours)).toEqual(["112", "64.8", "67.2", "67.2", "33.6"]);
    expect(fillPercent(source(result, "src-requests"))).toBe(80);
  });
});

describe("what people type", () => {
  it("reads hours and does not turn sizes or text into hours (DEC-041)", () => {
    expect(parseEstimateInput("28")).toEqual({ kind: "hours", hours: "28" });
    expect(parseEstimateInput(" 12,5 ")).toEqual({ kind: "hours", hours: "12.5" });
    expect(parseEstimateInput("12.50")).toEqual({ kind: "hours", hours: "12.5" });
    expect(parseEstimateInput("28 ч")).toEqual({ kind: "hours", hours: "28" });
    expect(parseEstimateInput("0")).toEqual({ kind: "hours", hours: "0" });
    expect(parseEstimateInput("")).toEqual({ kind: "empty" });
    expect(parseEstimateInput("M")).toEqual({ kind: "invalid", message: "«M» — размер, а нужны часы. Размеры в часы не переводятся." });
    expect(parseEstimateInput("м")).toMatchObject({ kind: "invalid", message: expect.stringContaining("размер") });
    expect(parseEstimateInput("XXXL")).toMatchObject({ kind: "invalid", message: expect.stringContaining("размер") });
    expect(parseEstimateInput("2-3 дня")).toEqual({ kind: "invalid", message: "«2-3 дня» — не число часов. Пример: 28 или 12,5." });
    expect(parseEstimateInput("-4")).toEqual({ kind: "invalid", message: "Оценка не может быть отрицательной." });
  });

  it("reads shares: empty is not set, out of 0–100 is an error", () => {
    expect(parseShareInput("")).toEqual({ kind: "empty" });
    expect(parseShareInput("12,5")).toEqual({ kind: "percent", percent: "12.5" });
    expect(parseShareInput("15 %")).toEqual({ kind: "percent", percent: "15" });
    expect(parseShareInput("101")).toEqual({ kind: "invalid", message: "Число от 0 до 100." });
    expect(parseShareInput("десять")).toEqual({ kind: "invalid", message: "Число от 0 до 100." });
  });

  it("rounds a share of hours half away from zero", () => {
    expect(ratioPercent("40", "120", 2)).toBe("33.33");
    expect(ratioPercent("1", "8", 1)).toBe("12.5");
    expect(ratioPercent("1", "16", 2)).toBe("6.25");
    expect(ratioPercent("1", "16", 1)).toBe("6.3");
    expect(ratioPercent("-4.8", "80", 1)).toBe("-6");
    expect(ratioPercent("0.1", "3", 2)).toBe("3.33");
  });
});
