import type { QuarterSnapshot, QuarterSnapshotV1, QuarterValidationResult } from "./quarter-capacity.types";
import { validateQuarterSnapshot, validateQuarterSnapshotV1 } from "./quarter-snapshot.validation";

/** Version of the quarter JSON this version writes. Format 1 is read, never written (DEC-044). */
export const QUARTER_PAYLOAD_VERSION = 2;

/**
 * Format 1 → 2 in memory, keeping every number: a direction becomes a «Работы» source with the
 * same share and every task a work in the quarter plan with the same estimate. A direction named
 * «Встречи» is not turned into a reserve by its name (DEC-044, Q-022).
 */
export function upgradeQuarterSnapshotV1(snapshot: QuarterSnapshotV1): QuarterSnapshot {
  return {
    ...snapshot,
    directions: snapshot.directions.map(({ id, name, percent }) => ({ id, name, percent, kind: "work", memberPercents: [] })),
    tasks: snapshot.tasks.map(({ id, name, directionId, estimateHours }) => ({
      id, name, directionId, estimateHours, mark: "plan", link: null, comment: null
    }))
  };
}

/** Reads a stored quarter of either format as a format-2 snapshot; the stored JSON is not changed. */
export function readStoredQuarterSnapshot(payloadVersion: number, payload: unknown): QuarterValidationResult {
  if (payloadVersion === QUARTER_PAYLOAD_VERSION) return validateQuarterSnapshot(payload);
  if (payloadVersion === 1) {
    const legacy = validateQuarterSnapshotV1(payload);
    return legacy.ok ? validateQuarterSnapshot(upgradeQuarterSnapshotV1(legacy.snapshot)) : legacy;
  }
  return { ok: false, errors: [{ path: "", code: "unsupported_version", message: "Неподдерживаемая версия данных квартала" }] };
}
