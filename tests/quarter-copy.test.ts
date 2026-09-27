import { describe, expect, it } from "vitest";
import { createQuarterCalendar } from "../src/domain/capacity/project-calendar";
import { copyQuarterSetup, defaultCopySource, nextQuarterAfter } from "../src/domain/capacity/quarter-copy";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { validateQuarterSnapshot } from "../src/domain/capacity/quarter-snapshot.validation";

function calendarBase(year: number, quarter: 1 | 2 | 3 | 4) {
  const calendar = createQuarterCalendar(year, quarter);
  if (!calendar.ok) throw new Error(calendar.message);
  return { year, quarter, calendar: calendar.calendar, calendarSource: calendar.calendarSource };
}

const source: QuarterSnapshot = {
  ...calendarBase(2026, 4),
  calendar: calendarBase(2026, 4).calendar.map((day) => day.date === "2026-10-03" ? { ...day, isWorking: true } : day),
  competencies: [{ id: "sa", name: "SA" }, { id: "java", name: "Java" }],
  members: [
    { id: "ivan", name: "Иван Петров", competencyId: "sa", fte: "1" },
    { id: "olga", name: "Ольга Новикова", competencyId: "java", fte: "0.5" }
  ],
  absences: [{ id: "vacation", memberId: "ivan", startDate: "2026-11-02", endDate: "2026-11-06" }],
  directions: [{ id: "product", name: "Продукт", percent: "70" }, { id: "meetings", name: "Встречи", percent: "30" }],
  tasks: [{ id: "task", name: "Онбординг", directionId: "product", estimateHours: "40" }]
};

describe("copying a saved quarter into a new period", () => {
  it("keeps team, FTE, competencies and shares with their ids; drops absences and tasks", () => {
    const base = calendarBase(2027, 1);
    const copy = copyQuarterSetup(source, base);
    expect(copy).toEqual({
      ...base,
      competencies: source.competencies, members: source.members, directions: source.directions,
      absences: [], tasks: []
    });
    expect(validateQuarterSnapshot(copy).ok).toBe(true);
  });

  it("uses the new period calendar, not the source calendar or its manual changes", () => {
    const base = calendarBase(2027, 1);
    const copy = copyQuarterSetup(source, base);
    expect(copy.calendar).toBe(base.calendar);
    expect(copy.calendarSource).toBe(base.calendarSource);
    expect(copy.calendar.some((day) => day.date.startsWith("2026"))).toBe(false);
  });

  it("does not share or change the source objects", () => {
    const before = JSON.parse(JSON.stringify(source));
    const copy = copyQuarterSetup(source, calendarBase(2027, 1));
    expect(copy.members[0]).not.toBe(source.members[0]);
    expect(copy.directions[0]).not.toBe(source.directions[0]);
    expect(source).toEqual(before);
  });
});

describe("suggested period of a new quarter", () => {
  it("follows the latest saved quarter, across the year end", () => {
    expect(nextQuarterAfter([{ year: 2026, quarter: 2 }, { year: 2026, quarter: 4 }], { year: 2026, month: 9 })).toEqual({ year: 2027, quarter: 1 });
    expect(nextQuarterAfter([{ year: 2027, quarter: 1 }, { year: 2026, quarter: 4 }], { year: 2026, month: 9 })).toEqual({ year: 2027, quarter: 2 });
  });

  it.each([[1, 1], [3, 1], [4, 2], [9, 3], [10, 4], [12, 4]])("uses today's quarter in an empty project: month %i → Q%i", (month, quarter) => {
    expect(nextQuarterAfter([], { year: 2026, month })).toEqual({ year: 2026, quarter });
  });
});

describe("default quarter to copy from", () => {
  const plans = [
    { planId: "q2-2026", year: 2026, quarter: 2 as const },
    { planId: "q4-2026", year: 2026, quarter: 4 as const },
    { planId: "q1-2027", year: 2027, quarter: 1 as const }
  ];

  it("takes the nearest saved quarter before the new one", () => {
    expect(defaultCopySource(plans, { year: 2027, quarter: 2 })?.planId).toBe("q1-2027");
    expect(defaultCopySource(plans, { year: 2026, quarter: 4 })?.planId).toBe("q2-2026");
    expect(defaultCopySource(plans, { year: 2026, quarter: 3 })?.planId).toBe("q2-2026");
  });

  it("falls back to the latest saved quarter for a period before all of them", () => {
    expect(defaultCopySource(plans, { year: 2025, quarter: 4 })?.planId).toBe("q1-2027");
  });

  it("has nothing to copy in an empty project", () => {
    expect(defaultCopySource([], { year: 2027, quarter: 1 })).toBeNull();
  });
});
