import { decimalToString, parseDecimal, subtractDecimal } from "./decimal-exact";
import type { QuarterCapacityResult } from "./quarter-capacity.types";

export type QuarterTotals = {
  availableHours: string;
  knownDemandHours: string;
  demandComplete: boolean;
  missingEstimateCount: number;
  /** Available minus known demand; signed and exact. Preliminary while estimates are missing. */
  remainingHours: string;
  remainingStatus: "surplus" | "balanced" | "deficit";
  /** Directions whose known demand already exceeds the budget, in plan order. */
  deficitDirections: { directionId: string; name: string }[];
};

/**
 * One answer for the whole quarter: a positive total does not hide a direction deficit,
 * because hours are split between directions and are not moved automatically.
 */
export function describeQuarterTotals(result: Pick<QuarterCapacityResult, "totals" | "directions">): QuarterTotals {
  const remaining = decimalToString(subtractDecimal(
    parseDecimal(result.totals.availableHours), parseDecimal(result.totals.knownDemandHours)));
  return {
    availableHours: result.totals.availableHours,
    knownDemandHours: result.totals.knownDemandHours,
    demandComplete: result.totals.demandComplete,
    missingEstimateCount: result.totals.missingEstimateCount,
    remainingHours: remaining,
    remainingStatus: remaining === "0" ? "balanced" : remaining.startsWith("-") ? "deficit" : "surplus",
    deficitDirections: result.directions
      .filter((direction) => direction.overrunKnownHours !== "0")
      .map((direction) => ({ directionId: direction.directionId, name: direction.name }))
  };
}

/** Russian noun agreement for counts: 1 спринт, 2 спринта, 5 спринтов. */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
