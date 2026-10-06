import { normalizeUserDecimal } from "./input-format";
import type { QuarterSnapshot } from "./quarter-capacity.types";

function canonical(value: string): string {
  try { return normalizeUserDecimal(value) ?? value; }
  catch { return value; }
}

/**
 * Decimal fields are normalized when they lose focus. Saving without that blur (the
 * unsaved-changes dialog takes focus first) must still accept "1,0" or "0,50"; invalid
 * input stays as typed so validation can name the field.
 */
export function normalizeSnapshotDecimals(snapshot: QuarterSnapshot): QuarterSnapshot {
  return {
    ...snapshot,
    members: snapshot.members.map((member) => ({ ...member, fte: canonical(member.fte) })),
    directions: snapshot.directions.map((direction) => ({
      ...direction, percent: direction.percent === null ? null : canonical(direction.percent),
      memberPercents: direction.memberPercents.map((row) => ({ ...row, percent: canonical(row.percent) }))
    })),
    tasks: snapshot.tasks.map((task) => ({
      ...task, estimateHours: task.estimateHours === null ? null : canonical(task.estimateHours)
    }))
  };
}
