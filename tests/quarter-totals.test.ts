import { describe, expect, it } from "vitest";
import { getQuarterDates } from "../src/domain/capacity/calendar-quarter";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { describeQuarterTotals, pluralRu } from "../src/domain/capacity/quarter-totals";

// Synthetic 20-day calendar × 8 hours × 0.625 FTE = 100 available hours.
function totals(changes: Partial<QuarterSnapshot> = {}) {
  const result = calculateQuarterCapacity({
    year: 2026, quarter: 1,
    calendar: getQuarterDates(2026, 1).map((date, index) => ({ date, isWorking: index < 20 })),
    competencies: [{ id: "dev", name: "Разработка" }],
    members: [{ id: "person", name: "Участник", competencyId: "dev", fte: "0.625" }],
    absences: [],
    directions: [{ id: "product", name: "Продукт", percent: "20" }, { id: "support", name: "Поддержка", percent: "80" }],
    tasks: [], ...changes
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return describeQuarterTotals(result.result);
}
const task = (id: string, directionId: string, estimateHours: string | null) => ({ id, name: id, directionId, estimateHours });

describe("quarter totals for the summary strip", () => {
  it("subtracts the known demand from the available hours exactly", () => {
    expect(totals({ tasks: [task("a", "product", "10"), task("b", "support", "15.5")] })).toEqual({
      availableHours: "100", knownDemandHours: "25.5", demandComplete: true, missingEstimateCount: 0,
      remainingHours: "74.5", remainingStatus: "surplus", deficitDirections: []
    });
  });

  it("names every direction with a deficit even when the quarter total has hours left", () => {
    const result = totals({ tasks: [task("a", "product", "30")] });
    expect(result).toMatchObject({ remainingHours: "70", remainingStatus: "surplus" });
    expect(result.deficitDirections).toEqual([{ directionId: "product", name: "Продукт" }]);
  });

  it("marks a quarter total below zero and a zero total as balanced", () => {
    expect(totals({ tasks: [task("a", "support", "120")] })).toMatchObject({ remainingHours: "-20", remainingStatus: "deficit" });
    expect(totals({ tasks: [task("a", "product", "20"), task("b", "support", "80")] })).toMatchObject({ remainingHours: "0", remainingStatus: "balanced", deficitDirections: [] });
  });

  it("keeps a missing estimate as incomplete demand, not zero", () => {
    const result = totals({ tasks: [task("a", "product", "10"), task("b", "product", null)] });
    expect(result).toMatchObject({ knownDemandHours: "10", demandComplete: false, missingEstimateCount: 1, remainingHours: "90" });
  });

  it("does not hide a tiny deficit of a direction", () => {
    expect(totals({ tasks: [task("a", "product", "20.0000000000000001")] }).deficitDirections).toHaveLength(1);
  });

  it("works for an empty team without NaN", () => {
    expect(totals({ members: [] })).toMatchObject({ availableHours: "0", remainingHours: "0", remainingStatus: "balanced" });
  });
});

describe("Russian plural forms", () => {
  it.each([
    [0, "спринтов"], [1, "спринт"], [2, "спринта"], [4, "спринта"], [5, "спринтов"], [6, "спринтов"],
    [11, "спринтов"], [12, "спринтов"], [14, "спринтов"], [21, "спринт"], [22, "спринта"], [111, "спринтов"], [101, "спринт"]
  ])("%i %s", (count, form) => expect(pluralRu(count, "спринт", "спринта", "спринтов")).toBe(form));
});
