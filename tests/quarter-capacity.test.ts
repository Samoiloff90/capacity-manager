import { describe, expect, it } from "vitest";
import { getQuarterDates, isCalendarDate, Quarter } from "../src/domain/capacity/calendar-quarter";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { QUARTER_INPUT_LIMITS, quarterSnapshotSchema, validateQuarterSnapshot } from "../src/domain/capacity/quarter-snapshot.validation";

// Deliberately synthetic: the first 20 dates are working dates, not a normative holiday calendar.
function calendar(year = 2026, quarter: Quarter = 1, workingDates?: string[]) {
  const dates = getQuarterDates(year, quarter);
  const working = new Set(workingDates ?? dates.slice(0, 20));
  return dates.map((date) => ({ date, isWorking: working.has(date) }));
}

function snapshot(changes: Partial<QuarterSnapshot> = {}): QuarterSnapshot {
  return {
    year: 2026, quarter: 1, calendar: calendar(),
    competencies: [{ id: "development", name: "Разработка" }],
    members: [{ id: "a", name: "А", competencyId: "development", fte: "1" }],
    absences: [],
    directions: [{ id: "product", name: "Продукт", percent: "20" }, { id: "meetings", name: "Встречи", percent: "80" }],
    tasks: [],
    ...changes
  };
}

function calculate(input: unknown): QuarterCapacityResult {
  const calculated = calculateQuarterCapacity(input);
  if (!calculated.ok) throw new Error(JSON.stringify(calculated.errors));
  return calculated.result;
}

function expectInvalid(input: unknown, path?: string) {
  const result = calculateQuarterCapacity(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected invalid snapshot");
  if (path) expect(result.errors.some((issue) => issue.path === path)).toBe(true);
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe("quarter capacity", () => {
  it("calculates the accepted 208 / 41.6 / -8.4 example without applying FTE twice", () => {
    const result = calculate(snapshot({
      members: [
        { id: "a", name: "А", competencyId: "development", fte: "1" },
        { id: "b", name: "Б", competencyId: "development", fte: "0.5" }
      ],
      absences: [
        { id: "absence-a", memberId: "a", startDate: "2026-01-01", endDate: "2026-01-02" },
        { id: "absence-b", memberId: "b", startDate: "2026-01-01", endDate: "2026-01-04" }
      ],
      tasks: [
        { id: "one", name: "Первая", directionId: "product", estimateHours: "30" },
        { id: "two", name: "Вторая", directionId: "product", estimateHours: "20" }
      ]
    }));
    expect(result.members.map((member) => member.availableHours)).toEqual(["144", "64"]);
    expect(result.totals).toMatchObject({ availableDays: 34, availableHours: "208", knownDemandHours: "50" });
    expect(result.directions.find((direction) => direction.directionId === "product")).toMatchObject({
      budgetHours: "41.6", knownDemandHours: "50", remainingKnownHours: "-8.4",
      overrunKnownHours: "8.4", confirmedRemainingHours: "-8.4", balanceComplete: true
    });
  });

  it.each([["0", "0"], ["0.5", "80"], ["0.75", "120"], ["1", "160"]])("applies FTE %s exactly once", (fte, expected) => {
    expect(calculate(snapshot({ members: [{ id: "a", name: "А", competencyId: "development", fte }] })).totals.availableHours).toBe(expected);
  });

  it("allocates 20 of 100 available hours without a productive ratio or a second meeting deduction", () => {
    const result = calculate(snapshot({ members: [{ id: "a", name: "А", competencyId: "development", fte: "0.625" }] }));
    expect(result.totals.availableHours).toBe("100");
    expect(result.directions.find((direction) => direction.directionId === "product")?.budgetHours).toBe("20");
    expect(result.directions.find((direction) => direction.directionId === "meetings")?.confirmedRemainingHours).toBe("80");
  });

  it("unions overlapping absences per member, including repeated intervals with distinct IDs", () => {
    const result = calculate(snapshot({ absences: [
      { id: "first", memberId: "a", startDate: "2026-01-02", endDate: "2026-01-05" },
      { id: "second", memberId: "a", startDate: "2026-01-04", endDate: "2026-01-07" },
      { id: "third", memberId: "a", startDate: "2026-01-02", endDate: "2026-01-05" }
    ] }));
    expect(result.members[0]).toMatchObject({ absenceWorkingDays: 6, availableDays: 14, availableHours: "112" });
  });

  it("uses the resolved calendar even for a working Saturday and a nonworking Monday", () => {
    const base = snapshot({ calendar: calendar(2026, 1, ["2026-01-03"]) });
    expect(calculate(base).totals.availableHours).toBe("8");
    const absent = calculate({ ...base, absences: [
      { id: "saturday", memberId: "a", startDate: "2026-01-03", endDate: "2026-01-03" },
      { id: "monday", memberId: "a", startDate: "2026-01-05", endDate: "2026-01-05" }
    ] });
    expect(absent.members[0]).toMatchObject({ absenceWorkingDays: 1, availableHours: "0" });
  });

  it("clips inclusive absence intervals at both quarter boundaries and ignores outside dates", () => {
    const result = calculate(snapshot({ calendar: calendar(2026, 1, ["2026-01-01", "2026-03-31"]), absences: [
      { id: "before", memberId: "a", startDate: "2025-12-30", endDate: "2026-01-01" },
      { id: "after", memberId: "a", startDate: "2026-03-31", endDate: "2026-04-02" },
      { id: "outside", memberId: "a", startDate: "2026-04-03", endDate: "2026-04-30" }
    ] }));
    expect(result.members[0]).toMatchObject({ absenceWorkingDays: 2, availableDays: 0 });
  });

  it("counts a valid leap-day absence and bounds a centuries-long absence to the quarter", () => {
    const base = snapshot({ year: 2028, calendar: calendar(2028, 1, ["2028-02-29"]) });
    const result = calculate({ ...base, absences: [{ id: "leap", memberId: "a", startDate: "2028-02-29", endDate: "2028-02-29" }] });
    expect(result.members[0].absenceWorkingDays).toBe(1);
    expect(calculate({ ...base, absences: [{ id: "long", memberId: "a", startDate: "0001-01-01", endDate: "9999-12-31" }] }).totals.availableHours).toBe("0");
  });

  it("aggregates each member by stable competence ID and preserves unused competencies", () => {
    const result = calculate(snapshot({
      competencies: [{ id: "development", name: "Одинаковое имя" }, { id: "qa", name: "Одинаковое имя" }, { id: "empty", name: "Без участников" }],
      members: [
        { id: "a", name: "А", competencyId: "development", fte: "0.75" },
        { id: "b", name: "Б", competencyId: "qa", fte: "0.5" }
      ]
    }));
    expect(result.totals.availableHours).toBe("200");
    expect(result.competencies).toEqual([
      { competencyId: "development", name: "Одинаковое имя", memberCount: 1, availableHours: "120" },
      { competencyId: "empty", name: "Без участников", memberCount: 0, availableHours: "0" },
      { competencyId: "qa", name: "Одинаковое имя", memberCount: 1, availableHours: "80" }
    ]);
  });

  it("recalculates changing team sizes without fixed row references", () => {
    for (const size of [5, 20, 3, 21]) {
      const members = Array.from({ length: size }, (_, index) => ({ id: `member-${index}`, name: `Участник ${index}`, competencyId: "development", fte: "1" }));
      expect(calculate(snapshot({ members })).totals.availableHours).toBe(String(size * 160));
    }
  });

  it.each(["empty-team", "no-working-dates", "all-absent"])("returns zero capacity for %s without hiding positive task demand", (scenario) => {
    const changes: Partial<QuarterSnapshot> = scenario === "empty-team" ? { members: [] }
      : scenario === "no-working-dates" ? { calendar: calendar(2026, 1, []) }
      : { absences: [{ id: "all", memberId: "a", startDate: "2026-01-01", endDate: "2026-03-31" }] };
    const result = calculate(snapshot({ ...changes, tasks: [{ id: "task", name: "Работа", directionId: "product", estimateHours: "12" }] }));
    expect(result.totals.availableHours).toBe("0");
    expect(result.directions.find((direction) => direction.directionId === "product")).toMatchObject({ budgetHours: "0", overrunKnownHours: "12", confirmedRemainingHours: "-12" });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  it("keeps a zero-share direction with tasks as a visible deficit", () => {
    const result = calculate(snapshot({
      directions: [{ id: "product", name: "Продукт", percent: "0" }, { id: "meetings", name: "Встречи", percent: "100" }],
      tasks: [{ id: "task", name: "Работа", directionId: "product", estimateHours: "1" }]
    }));
    expect(result.directions.find((direction) => direction.directionId === "product")?.overrunKnownHours).toBe("1");
    expect(result.directions.find((direction) => direction.directionId === "meetings")?.budgetHours).toBe("160");
  });
});

describe("exact allocation and result completeness", () => {
  it("distinguishes an exact 100% sum from 99.999999% without epsilon", () => {
    const directions = [
      { id: "a", name: "А", percent: "33.333333" }, { id: "b", name: "Б", percent: "33.333333" },
      { id: "c", name: "В", percent: "33.333334" }
    ];
    const complete = calculate(snapshot({ directions }));
    expect(complete.allocation).toEqual({ totalPercent: "100", status: "complete" });
    expect(complete.directions.map((direction) => direction.budgetHours)).toEqual(["53.3333328", "53.3333328", "53.3333344"]);
    const incomplete = calculate(snapshot({ directions: directions.map((direction) => ({ ...direction, percent: "33.333333" })) }));
    expect(incomplete.allocation).toEqual({ totalPercent: "99.999999", status: "underallocated" });
    expect(incomplete.directions.every((direction) => direction.confirmedRemainingHours === null)).toBe(true);
  });

  it.each([["70", "90", "underallocated"], ["90", "110", "overallocated"]])("keeps a %s%% reserve as a draft without renormalizing", (reserve, totalPercent, status) => {
    const draft = snapshot({ directions: [{ id: "product", name: "Продукт", percent: "20" }, { id: "meetings", name: "Встречи", percent: reserve }] });
    const result = calculate(draft);
    expect(result.allocation).toEqual({ totalPercent, status });
    expect(result.directions.find((direction) => direction.directionId === "product")).toMatchObject({
      budgetHours: "32", budgetComplete: false, demandComplete: true, balanceComplete: false, confirmedRemainingHours: null
    });
    expect(calculate(JSON.parse(JSON.stringify(draft)))).toEqual(result);
  });

  it("keeps null estimates distinct from zero and limits incompleteness to the affected direction", () => {
    const result = calculate(snapshot({ tasks: [
      { id: "missing", name: "Без оценки", directionId: "product", estimateHours: null },
      { id: "known", name: "С оценкой", directionId: "product", estimateHours: "10" },
      { id: "zero", name: "Явный ноль", directionId: "meetings", estimateHours: "0" }
    ] }));
    expect(result.directions.find((direction) => direction.directionId === "product")).toMatchObject({
      knownDemandHours: "10", missingEstimateCount: 1, budgetComplete: true, demandComplete: false,
      balanceComplete: false, remainingKnownHours: "22", confirmedRemainingHours: null
    });
    expect(result.directions.find((direction) => direction.directionId === "meetings")).toMatchObject({
      knownDemandHours: "0", missingEstimateCount: 0, demandComplete: true, confirmedRemainingHours: "128"
    });
    expect(result.totals).toMatchObject({ knownDemandHours: "10", missingEstimateCount: 1, demandComplete: false });
  });

  it("preserves a known overrun even when another task estimate is missing", () => {
    const result = calculate(snapshot({ tasks: [
      { id: "known", name: "С оценкой", directionId: "product", estimateHours: "40" },
      { id: "missing", name: "Без оценки", directionId: "product", estimateHours: null }
    ] }));
    expect(result.directions.find((direction) => direction.directionId === "product")).toMatchObject({
      remainingKnownHours: "-8", overrunKnownHours: "8", balanceComplete: false, confirmedRemainingHours: null
    });
  });

  it("does not round high-precision FTE, allocations or small nonzero deficits", () => {
    const result = calculate(snapshot({ members: [{ id: "a", name: "А", competencyId: "development", fte: "0.1234567890123456789" }] }));
    expect(result.totals.availableHours).toBe("19.753086241975308624");
    expect(result.directions.find((direction) => direction.directionId === "product")?.budgetHours).toBe("3.9506172483950617248");
    const deficit = calculate(snapshot({ tasks: [{ id: "tiny", name: "Работа", directionId: "product", estimateHours: "32.0001" }] }));
    expect(deficit.directions.find((direction) => direction.directionId === "product")?.overrunKnownHours).toBe("0.0001");
  });

  it("sums estimates beyond Number precision exactly and returns JSON-safe strings", () => {
    const result = calculate(snapshot({ tasks: [
      { id: "large", name: "Большая", directionId: "product", estimateHours: "1000000000000000000000000.01" },
      { id: "small", name: "Маленькая", directionId: "product", estimateHours: "0.02" }
    ] }));
    expect(result.totals.knownDemandHours).toBe("1000000000000000000000000.03");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("treats an empty distribution as a 0% draft, even for an empty team", () => {
    expect(calculate(snapshot({ members: [], directions: [] })).allocation).toEqual({ totalPercent: "0", status: "underallocated" });
  });
});

describe("snapshot validation, determinism and isolation", () => {
  it("allows an incomplete calendar for storage but never computes it as zero capacity", () => {
    const draft = snapshot({ calendar: [] });
    expect(quarterSnapshotSchema.safeParse(draft).success).toBe(true);
    expect(validateQuarterSnapshot(draft).ok).toBe(true);
    expectInvalid(draft, "calendar");
    const partial = snapshot({ calendar: calendar().slice(1) });
    expect(validateQuarterSnapshot(partial, { requireCompleteCalendar: true }).ok).toBe(false);
  });

  it("rejects duplicate and out-of-quarter calendar dates", () => {
    const days = calendar();
    expectInvalid(snapshot({ calendar: [days[1], ...days.slice(1)] }), "calendar.1.date");
    expectInvalid(snapshot({ calendar: [{ date: "2026-04-01", isWorking: true }, ...days.slice(1)] }), "calendar.0.date");
  });

  it.each(["2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-01-00", "0000-01-01", "2026-1-01", "invalid", "2026-01-01T00:00:00Z"])("rejects malformed civil date %s", (startDate) => {
    expectInvalid(snapshot({ absences: [{ id: "bad", memberId: "a", startDate, endDate: "2026-03-31" }] }), "absences.0.startDate");
  });

  it("checks Gregorian leap rules and quarter boundaries without a timezone or a 1900 year offset", () => {
    expect(isCalendarDate("2000-02-29")).toBe(true);
    expect(isCalendarDate("2400-02-29")).toBe(true);
    expect(getQuarterDates(2026, 1)).toHaveLength(90);
    expect(getQuarterDates(2028, 1)).toHaveLength(91);
    expect(getQuarterDates(2026, 2)).toHaveLength(91);
    expect(getQuarterDates(2026, 4)).toHaveLength(92);
    expect(getQuarterDates(99, 1)[0]).toBe("0099-01-01");
    const lastQuarter = getQuarterDates(9999, 4);
    expect(lastQuarter[lastQuarter.length - 1]).toBe("9999-12-31");
  });

  it("rejects reversed absences and references to entities outside the plan", () => {
    expectInvalid(snapshot({ absences: [{ id: "bad", memberId: "a", startDate: "2026-01-03", endDate: "2026-01-02" }] }), "absences.0.endDate");
    expectInvalid(snapshot({ absences: [{ id: "bad", memberId: "unknown", startDate: "2026-01-01", endDate: "2026-01-02" }] }), "absences.0.memberId");
    expectInvalid(snapshot({ members: [{ id: "a", name: "А", competencyId: "unknown", fte: "1" }] }), "members.0.competencyId");
    expectInvalid(snapshot({ tasks: [{ id: "bad", name: "Работа", directionId: "unknown", estimateHours: "1" }] }), "tasks.0.directionId");
  });

  it.each(["competencies", "members", "absences", "directions", "tasks"] as const)("rejects duplicate IDs in %s", (field) => {
    const base = snapshot({
      absences: [{ id: "absence", memberId: "a", startDate: "2026-01-01", endDate: "2026-01-02" }],
      tasks: [{ id: "task", name: "Работа", directionId: "product", estimateHours: "1" }]
    });
    expectInvalid({ ...base, [field]: [base[field][0], base[field][0]] }, `${field}.1.id`);
  });

  it.each(["", " ", "0.50", "00", "1e2", "NaN", "Infinity", "0,5", "-0", "-1", "1.00001", 0.5, null])("rejects invalid FTE %s even in storage payloads", (fte) => {
    expect(validateQuarterSnapshot({ ...snapshot(), members: [{ id: "a", name: "А", competencyId: "development", fte }] }).ok).toBe(false);
  });

  it.each(["-0.1", "100.0001", "invalid"])("rejects invalid individual percent %s", (percent) => {
    expectInvalid(snapshot({ directions: [{ id: "product", name: "Продукт", percent }] }), "directions.0.percent");
  });

  it.each(["", "-0.001", "Infinity", undefined])("does not silently replace invalid estimate %s with zero or null", (estimateHours) => {
    expectInvalid({ ...snapshot(), tasks: [{ id: "task", name: "Работа", directionId: "product", estimateHours }] }, "tasks.0.estimateHours");
  });

  it("rejects malformed structures, empty names, unknown fields and technical oversize payloads", () => {
    for (const input of [null, [], "plan", {}, { ...snapshot(), year: 10000 }, { ...snapshot(), quarter: 5 }]) expectInvalid(input);
    expectInvalid(snapshot({ members: [{ id: "", name: " ", competencyId: "development", fte: "1" }] }));
    expectInvalid({ ...snapshot(), productiveRatio: "0.7" });
    expectInvalid(snapshot({ tasks: [{ id: "task", name: "Работа", directionId: "product", estimateHours: "1".repeat(QUARTER_INPUT_LIMITS.decimalCharacters + 1) }] }));
    expectInvalid({ ...snapshot(), members: Array(QUARTER_INPUT_LIMITS.entitiesPerCollection + 1).fill(null) }, "members");
  });

  it("is independent of row order, accepts frozen inputs and never changes the input", () => {
    const base = snapshot({
      members: [{ id: "b", name: "Б", competencyId: "development", fte: "0.5" }, ...snapshot().members],
      tasks: [{ id: "two", name: "Два", directionId: "product", estimateHours: "0.2" }, { id: "one", name: "Один", directionId: "product", estimateHours: "0.1" }]
    });
    const serialized = JSON.stringify(base);
    const expected = calculate(freezeDeep(base));
    const reordered = { ...base, calendar: [...base.calendar].reverse(), members: [...base.members].reverse(), directions: [...base.directions].reverse(), tasks: [...base.tasks].reverse() };
    expect(calculate(reordered)).toEqual(expected);
    expect(calculate(base)).toEqual(expected);
    expect(JSON.stringify(base)).toBe(serialized);
  });

  it("does not carry state across independent quarter snapshots", () => {
    const first = snapshot();
    const second = snapshot({ quarter: 2, calendar: calendar(2026, 2) });
    const before = calculate(second);
    const changed = calculate({ ...first, members: [], calendar: calendar(2026, 1, []) });
    expect(changed.totals.availableHours).toBe("0");
    expect(calculate(second)).toEqual(before);
    expect(calculate(first).totals.availableHours).toBe("160");
  });
});
