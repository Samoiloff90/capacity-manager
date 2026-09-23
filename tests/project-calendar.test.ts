import { describe, expect, it } from "vitest";
import type { Quarter } from "../src/domain/capacity/calendar-quarter";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { validateQuarterSnapshot } from "../src/domain/capacity/quarter-snapshot.validation";
import {
  BUNDLED_CALENDAR_YEARS, CalendarMode, createQuarterCalendar, getCalendarOverrides,
  MANUAL_CALENDAR_VERSION, RU_2026_CALENDAR_SOURCES, RU_2026_CALENDAR_VERSION
} from "../src/domain/capacity/project-calendar";

function generated(year = 2026, quarter: Quarter = 1, mode: CalendarMode = "ru-official") {
  const result = createQuarterCalendar(year, quarter, mode);
  if (!result.ok) throw new Error(result.message);
  return result;
}

function snapshot(year = 2026, quarter: Quarter = 1): QuarterSnapshot {
  const { calendar, calendarSource } = generated(year, quarter);
  return {
    year, quarter, calendar, calendarSource,
    competencies: [{ id: "a", name: "Разработка" }],
    members: [{ id: "one", name: "Участник", competencyId: "a", fte: "1" }],
    absences: [], directions: [], tasks: []
  };
}

function isWorking(date: string): boolean | undefined {
  const quarter = (Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1) as Quarter;
  return generated(2026, quarter).calendar.find((day) => day.date === date)?.isWorking;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe("bundled RF 2026 calendar", () => {
  it.each([[1, 55, 90], [2, 62, 91], [3, 66, 92], [4, 64, 92]] as const)(
    "quarter %s has %s working dates among %s calendar dates", (quarter, working, total) => {
      const result = generated(2026, quarter);
      expect(result.calendar).toHaveLength(total);
      expect(new Set(result.calendar.map((day) => day.date)).size).toBe(total);
      expect(result.calendar.filter((day) => day.isWorking)).toHaveLength(working);
      expect(result.calendarSource.baseWorkingDates).toHaveLength(working);
      expect(validateQuarterSnapshot(snapshot(2026, quarter), { requireCompleteCalendar: true }).ok).toBe(true);
    }
  );

  it("has 247 working dates, with independently specified monthly counts", () => {
    const dates = ([1, 2, 3, 4] as const).flatMap((quarter) => generated(2026, quarter).calendar);
    const counts = Array.from({ length: 12 }, (_, index) => dates.filter(
      (day) => Number(day.date.slice(5, 7)) === index + 1 && day.isWorking
    ).length);
    expect(counts).toEqual([15, 19, 21, 22, 19, 21, 23, 21, 22, 22, 20, 22]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(247);
  });

  it.each([
    "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
    "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
    "2026-02-23", "2026-03-08", "2026-05-01", "2026-05-09",
    "2026-06-12", "2026-11-04"
  ])("keeps federal holiday %s non-working", (date) => expect(isWorking(date)).toBe(false));

  it.each(["2026-01-09", "2026-12-31", "2026-03-09", "2026-05-11"])(
    "includes transferred day off %s", (date) => expect(isWorking(date)).toBe(false)
  );

  it.each(["2026-01-12", "2026-03-10", "2026-05-12", "2026-12-30"])(
    "does not add an extra transfer on %s", (date) => expect(isWorking(date)).toBe(true)
  );

  it.each(["2026-04-30", "2026-05-08", "2026-06-11", "2026-11-03"])(
    "keeps holiday-eve %s as a full working date under the MVP", (date) => expect(isWorking(date)).toBe(true)
  );

  it("feeds all working dates at 8 hours to the existing new engine", () => {
    const calculated = calculateQuarterCapacity(snapshot(2026, 2));
    expect(calculated.ok).toBe(true);
    if (calculated.ok) expect(calculated.result.totals.availableHours).toBe("496");
  });

  it("records the sources and exact bundled version", () => {
    const result = generated();
    expect(BUNDLED_CALENDAR_YEARS).toEqual([2026]);
    expect(result.calendarSource).toMatchObject({
      kind: "ru-official", version: RU_2026_CALENDAR_VERSION,
      sourceUrls: RU_2026_CALENDAR_SOURCES.map((source) => source.url)
    });
    expect(getCalendarOverrides(result)).toEqual([]);
  });
});

describe("manual calendar and immutable provenance", () => {
  it.each([2025, 2027, 2030])("requires an explicit manual choice for %s", (year) => {
    const result = createQuarterCalendar(year, 1);
    expect(result).toMatchObject({ ok: false, reason: "needs-manual" });
    expect(result).not.toHaveProperty("calendar");
  });

  it("manual mode is visibly a weekdays template, with no assumed Russian holidays", () => {
    const result = generated(2026, 1, "manual");
    expect(result.calendarSource).toMatchObject({ kind: "manual", version: MANUAL_CALENDAR_VERSION, sourceUrls: [] });
    expect(result.calendar.find((day) => day.date === "2026-01-01")?.isWorking).toBe(true);
    expect(result.calendar.find((day) => day.date === "2026-01-03")?.isWorking).toBe(false);
    expect(result.calendar.filter((day) => day.isWorking)).toHaveLength(64);
  });

  it.each([
    [1, 1, "0001-01-01", true], [1900, 1, "1900-03-01", true],
    [2000, 1, "2000-02-29", true], [2024, 1, "2024-02-29", true]
  ] as const)("uses Gregorian civil dates for %s Q%s: %s", (year, quarter, date, working) => {
    const result = generated(year, quarter, "manual");
    expect(result.calendar.find((day) => day.date === date)?.isWorking).toBe(working);
    if (year === 1900) expect(result.calendar.some((day) => day.date === "1900-02-29")).toBe(false);
  });

  it("rejects invalid periods instead of offering manual fallback", () => {
    expect(() => createQuarterCalendar(0, 1)).toThrow();
    expect(() => createQuarterCalendar(2026, 5 as Quarter)).toThrow();
    expect(() => createQuarterCalendar(2026, 1, "other" as CalendarMode)).toThrow();
  });

  it("round-trips added and removed workdays without updating baseline, version or results", () => {
    const initial = snapshot();
    const changed: QuarterSnapshot = {
      ...initial,
      calendarSource: { ...initial.calendarSource!, version: "saved-earlier-calendar-version" },
      calendar: initial.calendar.map((day) => day.date === "2026-01-03" ? { ...day, isWorking: true }
        : day.date === "2026-01-12" ? { ...day, isWorking: false } : day)
    };
    const before = JSON.stringify(changed);
    const restored = validateQuarterSnapshot(JSON.parse(before), { requireCompleteCalendar: true });
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("Expected restored snapshot");
    freezeDeep(restored.snapshot);
    expect(getCalendarOverrides(restored.snapshot)).toEqual([
      { date: "2026-01-03", isWorking: true }, { date: "2026-01-12", isWorking: false }
    ]);
    expect(restored.snapshot.calendarSource).toEqual(changed.calendarSource);
    expect(calculateQuarterCapacity(restored.snapshot)).toEqual(calculateQuarterCapacity(changed));
    expect(JSON.stringify(changed)).toBe(before);
    expect(generated().calendarSource.baseWorkingDates).toEqual(initial.calendarSource?.baseWorkingDates);
  });

  it("does not guess a provenance for old snapshots", () => {
    const { calendarSource: _source, ...oldSnapshot } = snapshot();
    expect(validateQuarterSnapshot(oldSnapshot).ok).toBe(true);
    expect(getCalendarOverrides(oldSnapshot)).toBeNull();
  });

  it("compares overrides to the saved base dates, not today's bundled calendar", () => {
    const initial = snapshot();
    const saved: QuarterSnapshot = {
      ...initial,
      calendarSource: { kind: "manual", version: "historical-empty-base", baseWorkingDates: [] }
    };
    const before = JSON.stringify(saved);
    const overrides = getCalendarOverrides(freezeDeep(saved));
    expect(overrides).toHaveLength(55);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it.each([
    { kind: "other", version: "v1", baseWorkingDates: [] },
    { kind: "manual", version: "", baseWorkingDates: [] },
    { kind: "manual", version: "v1", baseWorkingDates: ["2026-02-30"] },
    { kind: "manual", version: "v1", baseWorkingDates: ["2026-04-01"] },
    { kind: "manual", version: "v1", baseWorkingDates: ["2026-01-12", "2026-01-12"] },
    { kind: "manual", version: "v1", baseWorkingDates: [], sourceUrls: ["javascript:alert(1)"] },
    { kind: "manual", version: "v1", baseWorkingDates: [], unexpected: true },
    { kind: "manual", version: "v1", baseWorkingDates: Array(93).fill("2026-01-12") }
  ])("rejects malformed provenance: %j", (calendarSource) => {
    expect(validateQuarterSnapshot({ ...snapshot(), calendarSource }).ok).toBe(false);
  });
});
