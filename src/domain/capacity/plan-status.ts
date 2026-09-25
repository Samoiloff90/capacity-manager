import type { QuarterCapacityResult } from "./quarter-capacity.types";

export type QuarterPlanStatus = { ready: boolean; reasons: string[] };

/**
 * Plan-level readiness with the same completeness rules as the direction balances:
 * a plan is final only when allocation is 100% and every task has an estimate.
 */
export function describeQuarterPlanStatus(
  result: Pick<QuarterCapacityResult, "directions" | "allocation" | "totals">
): QuarterPlanStatus {
  const reasons: string[] = [];
  if (!result.directions.length) reasons.push("Направления не заданы.");
  else if (result.allocation.status !== "complete") {
    reasons.push(`Сумма долей направлений ${result.allocation.totalPercent.replace(".", ",")}% вместо 100%.`);
  }
  if (result.totals.missingEstimateCount > 0) reasons.push(`Задач без оценки: ${result.totals.missingEstimateCount}.`);
  return { ready: reasons.length === 0, reasons };
}
