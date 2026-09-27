import { describe, expect, it } from "vitest";
import { getQuarterDates, type Quarter } from "../src/domain/capacity/calendar-quarter";
import { createQuarterCalendar } from "../src/domain/capacity/project-calendar";
import { describeQuarterSprints } from "../src/domain/capacity/quarter-sprints";

function calendar(year: number, quarter: Quarter) {
  const created = createQuarterCalendar(year, quarter, year === 2026 || year === 2027 ? "ru-official" : "manual");
  if (!created.ok) throw new Error(created.message);
  return created.calendar;
}
const sprintsOf = (year: number, quarter: Quarter) => describeQuarterSprints(year, quarter, calendar(year, quarter));
const utcDay = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const byMonth = (year: number, quarter: Quarter) => sprintsOf(year, quarter).months.map((month) => month.sprintCount);

describe("sprints: two weeks from the first Monday of the quarter (PO decision 2026-09-27)", () => {
  it("lists I quarter 2027 with working days of the RF calendar", () => {
    const result = sprintsOf(2027, 1);
    expect(result.sprints).toEqual([
      { number: 1, startDate: "2027-01-04", endDate: "2027-01-17", month: "2027-01", workingDays: 5 },
      { number: 2, startDate: "2027-01-18", endDate: "2027-01-31", month: "2027-01", workingDays: 10 },
      { number: 3, startDate: "2027-02-01", endDate: "2027-02-14", month: "2027-02", workingDays: 10 },
      // 22–23 February are holidays, Saturday 20 February is a working day.
      { number: 4, startDate: "2027-02-15", endDate: "2027-02-28", month: "2027-02", workingDays: 9 },
      { number: 5, startDate: "2027-03-01", endDate: "2027-03-14", month: "2027-03", workingDays: 9 },
      { number: 6, startDate: "2027-03-15", endDate: "2027-03-28", month: "2027-03", workingDays: 10 }
    ]);
    expect(result.months).toEqual([
      { month: "2027-01", sprintCount: 2 }, { month: "2027-02", sprintCount: 2 }, { month: "2027-03", sprintCount: 2 }
    ]);
    expect(result.outside).toEqual([
      { startDate: "2027-01-01", endDate: "2027-01-03" }, { startDate: "2027-03-29", endDate: "2027-03-31" }
    ]);
  });

  it.each([
    [2026, 1, "2026-01-05", [1, 2, 3], "2026-03-30"],
    [2026, 2, "2026-04-06", [1, 3, 2], "2026-06-29"],
    [2027, 1, "2027-01-04", [2, 2, 2], "2027-03-29"],
    [2027, 2, "2027-04-05", [1, 3, 2], "2027-06-28"]
  ] as const)("%i Q%i starts on %s with %j sprints by month and a tail from %s", (year, quarter, first, months, tail) => {
    const result = sprintsOf(year, quarter);
    expect(result.sprints[0].startDate).toBe(first);
    expect(byMonth(year, quarter)).toEqual(months);
    expect(result.outside.at(-1)?.startDate).toBe(tail);
  });

  it("counts a sprint across two months in the month it ends", () => {
    const second = sprintsOf(2026, 1).sprints[1];
    expect(second).toMatchObject({ startDate: "2026-01-19", endDate: "2026-02-01", month: "2026-02" });
  });

  it("has exactly six sprints in every quarter; none crosses into the next quarter", () => {
    for (const year of [1, 2, 1900, ...Array.from({ length: 41 }, (_, index) => 2000 + index), 9998, 9999]) {
      for (const quarter of [1, 2, 3, 4] as const) {
        const dates = getQuarterDates(year, quarter);
        const { sprints } = describeQuarterSprints(year, quarter, []);
        expect(sprints).toHaveLength(6);
        expect(sprints.every((sprint) => utcDay(sprint.startDate) === 1 && utcDay(sprint.endDate) === 0)).toBe(true);
        expect(sprints[0].startDate <= dates[6]).toBe(true);
        expect(sprints[5].endDate <= dates[dates.length - 1]).toBe(true);
      }
    }
  });

  it("starts on the 1st when the quarter begins on a Monday and leaves only a tail", () => {
    const result = describeQuarterSprints(2024, 2, calendar(2024, 2));
    expect(result.sprints[0].startDate).toBe("2024-04-01");
    expect(result.outside).toEqual([{ startDate: "2024-06-24", endDate: "2024-06-30" }]);
  });

  it("keeps the leap day inside a sprint of I quarter 2028", () => {
    const result = describeQuarterSprints(2028, 1, calendar(2028, 1));
    expect(result.sprints[4]).toMatchObject({ startDate: "2028-02-28", endDate: "2028-03-12", month: "2028-03", workingDays: 10 });
    expect(result.outside).toEqual([
      { startDate: "2028-01-01", endDate: "2028-01-02" }, { startDate: "2028-03-27", endDate: "2028-03-31" }
    ]);
  });

  it("sprint and tail working days add up to the working days of the quarter", () => {
    for (const year of [2026, 2027]) {
      for (const quarter of [1, 2, 3, 4] as const) {
        const days = calendar(year, quarter);
        const working = new Set(days.filter((day) => day.isWorking).map((day) => day.date));
        const { sprints, outside } = describeQuarterSprints(year, quarter, days);
        const outsideWorking = outside.flatMap((range) => getQuarterDates(year, quarter)
          .filter((date) => date >= range.startDate && date <= range.endDate && working.has(date))).length;
        expect(sprints.reduce((sum, sprint) => sum + (sprint.workingDays ?? 0), 0) + outsideWorking).toBe(working.size);
      }
    }
  });

  it("follows manual calendar changes of the plan", () => {
    const days = calendar(2027, 1).map((day) => day.date === "2027-01-16" ? { ...day, isWorking: true } : day);
    expect(describeQuarterSprints(2027, 1, days).sprints[0].workingDays).toBe(6);
  });

  it("reports unknown working days instead of zero while a day has no status", () => {
    const days = calendar(2027, 1).filter((day) => day.date !== "2027-02-03");
    const { sprints } = describeQuarterSprints(2027, 1, days);
    expect(sprints[2].workingDays).toBeNull();
    expect(sprints[1].workingDays).toBe(10);
  });
});
