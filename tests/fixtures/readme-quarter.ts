import { createQuarterCalendar } from "../../src/domain/capacity/project-calendar";
import { calculateQuarterCapacity } from "../../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshot } from "../../src/domain/capacity/quarter-capacity.types";

/**
 * README scenario, artificial data only: Q4 2026, one member at FTE 0.5,
 * absence 01–02.10, 03.10 marked as a working day → 65 working days, 63 available, 252 h.
 * Ids are chosen so that sorting by id differs from the snapshot (screen) order.
 */
export function readmeQuarter(changes: Partial<QuarterSnapshot> = {}): QuarterSnapshot {
  const calendar = createQuarterCalendar(2026, 4);
  if (!calendar.ok) throw new Error(calendar.message);
  return {
    year: 2026,
    quarter: 4,
    calendar: calendar.calendar.map((day) => day.date === "2026-10-03" ? { ...day, isWorking: true } : day),
    calendarSource: calendar.calendarSource,
    competencies: [{ id: "z-dev", name: "Разработка" }],
    members: [{ id: "z-member", name: "Тестовый сотрудник", competencyId: "z-dev", fte: "0.5" }],
    absences: [{ id: "a1", memberId: "z-member", startDate: "2026-10-01", endDate: "2026-10-02" }],
    directions: [
      { id: "z-product", name: "Продукт", percent: "20" },
      { id: "a-meetings", name: "Встречи и прочее", percent: "80" }
    ],
    tasks: [
      { id: "t2", name: "Задача 30", directionId: "z-product", estimateHours: "30" },
      { id: "t1", name: "Задача 25", directionId: "z-product", estimateHours: "25" }
    ],
    ...changes
  };
}

export function calculate(snapshot: QuarterSnapshot): QuarterCapacityResult {
  const calculation = calculateQuarterCapacity(snapshot);
  if (!calculation.ok) throw new Error(JSON.stringify(calculation.errors));
  return calculation.result;
}
