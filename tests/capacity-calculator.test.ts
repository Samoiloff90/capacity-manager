import { describe, expect, it } from "vitest";
import { calculateCapacity, calculatePlanFact } from "../src/domain/capacity/capacity.calculator";
import { CapacityMonth } from "../src/domain/capacity/capacity.types";

const april2026: CapacityMonth = {
  year: 2026,
  month: 4,
  workingDays: 22,
  hoursPerDay: 8,
  daysPerSprint: 10
};

describe("capacity calculator", () => {
  it("calculates capacity for FTE 1 and 70 percent productive ratio", () => {
    const result = calculateCapacity({
      month: april2026,
      people: [{ id: 1, fullName: "Developer", fte: 1, productiveRatio: 0.7 }]
    });

    expect(result.people[0]).toMatchObject({
      availableDays: 22,
      productiveDays: 15.4,
      productiveHours: 123.2,
      sprints: 1.54
    });
    expect(result.totals.fte).toBe(1);
  });

  it("calculates capacity for FTE 0.5", () => {
    const result = calculateCapacity({
      month: april2026,
      people: [{ id: 1, fullName: "Part Time Developer", fte: 0.5, productiveRatio: 0.7 }]
    });

    expect(result.people[0].productiveDays).toBe(7.7);
    expect(result.people[0].productiveHours).toBe(61.6);
    expect(result.totals.fte).toBe(0.5);
  });

  it("calculates capacity for 60 percent productive ratio", () => {
    const result = calculateCapacity({
      month: april2026,
      people: [{ id: 1, fullName: "Lead", fte: 1, productiveRatio: 0.6 }]
    });

    expect(result.people[0].productiveDays).toBe(13.2);
    expect(result.people[0].productiveHours).toBe(105.6);
    expect(result.people[0].sprints).toBe(1.32);
  });

  it("subtracts vacation inside the month using business days only", () => {
    const result = calculateCapacity({
      month: april2026,
      people: [{ id: 1, fullName: "QA", fte: 1, productiveRatio: 0.7 }],
      absences: [{ personId: 1, startDate: "2026-04-06", endDate: "2026-04-10" }]
    });

    expect(result.people[0].absenceWorkingDays).toBe(5);
    expect(result.people[0].availableDays).toBe(17);
    expect(result.people[0].productiveHours).toBe(95.2);
  });

  it("does not subtract overlapping absences twice", () => {
    const result = calculateCapacity({
      month: april2026,
      people: [{ id: 1, fullName: "QA", fte: 1, productiveRatio: 0.7 }],
      absences: [
        { personId: 1, startDate: "2026-04-06", endDate: "2026-04-10" },
        { personId: 1, startDate: "2026-04-08", endDate: "2026-04-14" }
      ]
    });

    expect(result.people[0].absenceWorkingDays).toBe(7);
    expect(result.people[0].availableDays).toBe(15);
    expect(result.people[0].productiveHours).toBe(84);
  });

  it("returns null for sprint and utilization division by zero", () => {
    const result = calculateCapacity({
      month: { ...april2026, daysPerSprint: 0 },
      people: [{ id: 1, fullName: "Developer", fte: 1, productiveRatio: 0.7 }]
    });
    const planFact = calculatePlanFact(0, 12);

    expect(result.people[0].sprints).toBeNull();
    expect(result.totals.sprints).toBeNull();
    expect(planFact.utilization).toBeNull();
    expect(planFact.variance).toBe(12);
  });

  it("calculates workload category hours from productive hours", () => {
    const result = calculateCapacity({
      month: april2026,
      people: [{ id: 1, fullName: "Developer", fte: 1, productiveRatio: 0.7 }],
      workloadCategories: [
        { id: 1, name: "Продукт А", percent: 0.3 },
        { id: 2, name: "Support", percent: 0.15 }
      ]
    });

    expect(result.workload[0].plannedHours).toBe(36.96);
    expect(result.workload[1].plannedHours).toBe(18.48);
  });
});
