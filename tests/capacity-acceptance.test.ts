import { describe, expect, it } from "vitest";
import fixture from "./fixtures/capacity-acceptance.json";
import { asRecorded } from "./fixtures/as-recorded";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshotV1 } from "../src/domain/capacity/quarter-capacity.types";
import { readStoredQuarterSnapshot } from "../src/domain/capacity/quarter-snapshot-format";

type AcceptanceCase = {
  id: string;
  title: string;
  kind: "control" | "generated";
  /** Format 1, as 0.1.0–0.3.0 store it: read the way the application reads a saved quarter. */
  snapshot: QuarterSnapshotV1;
  expected: QuarterCapacityResult;
};

// Expected values are committed output of the independent Python Fraction
// oracle, never produced by the application or its numeric/calendar helpers.
const cases = (fixture as unknown as { cases: AcceptanceCase[] }).cases;

function freezeRecursively(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeRecursively);
    Object.freeze(value);
  }
}

// Row order is not part of numerical acceptance. Keep every result field and
// compare only after ordering copies by stable IDs, without mutating the result.
function byId<T>(rows: readonly T[], id: (row: T) => string): T[] {
  return [...rows].sort((left, right) => id(left) < id(right) ? -1 : id(left) > id(right) ? 1 : 0);
}

function normalized(result: QuarterCapacityResult): QuarterCapacityResult {
  return {
    ...result,
    members: byId(result.members, row => row.memberId),
    competencies: byId(result.competencies, row => row.competencyId),
    directions: byId(result.directions, row => row.directionId),
  };
}

function calculate(snapshot: QuarterSnapshotV1): QuarterCapacityResult {
  freezeRecursively(snapshot);
  const read = readStoredQuarterSnapshot(1, snapshot);
  if (!read.ok) throw new Error(`Valid reference snapshot was rejected: ${JSON.stringify(read.errors)}`);
  const output = calculateQuarterCapacity(read.snapshot);
  if (!output.ok) throw new Error(`Valid reference snapshot was rejected: ${JSON.stringify(output.errors)}`);
  return normalized(output.result);
}

function control(id: string): AcceptanceCase {
  const item = cases.find(candidate => candidate.id === id);
  if (!item) throw new Error(`Missing reference control: ${id}`);
  return item;
}

describe("independent numerical acceptance against Python datetime/Fraction", () => {
  it.each(cases)("$id — $title", ({ snapshot, expected }) => {
    expect(asRecorded(calculate(snapshot), expected)).toEqual(expected);
  });

  it("recalculates 5 → 20 → 5 without retained members, hours or changed task demand", () => {
    const before = control("team-five-before");
    const expanded = control("team-twenty");
    const after = control("team-five-after");
    const results = [before, expanded, after].map(item => calculate(item.snapshot));

    expect(results.map(result => result.totals.availableHours)).toEqual(["400", "1600", "400"]);
    expect(results.map(result => result.totals.knownDemandHours)).toEqual(["500", "500", "500"]);
    expect(asRecorded(results[1], expanded.expected)).toEqual(expanded.expected);
    expect(asRecorded(results[2], before.expected)).toEqual(before.expected);
    expect(asRecorded(calculate(before.snapshot), before.expected)).toEqual(before.expected);
  });

  it("uses the same exact reference when calendar, people, absences and tasks arrive in reverse order", () => {
    for (const id of ["absence-union-leap-boundaries", "exact-100-long-decimal", "generated-24"]) {
      const item = control(id);
      const snapshot: QuarterSnapshotV1 = {
        ...item.snapshot,
        calendar: [...item.snapshot.calendar].reverse(),
        competencies: [...item.snapshot.competencies].reverse(),
        members: [...item.snapshot.members].reverse(),
        absences: [...item.snapshot.absences].reverse(),
        directions: [...item.snapshot.directions].reverse(),
        tasks: [...item.snapshot.tasks].reverse(),
      };
      expect(asRecorded(calculate(snapshot), item.expected)).toEqual(item.expected);
    }
  });
});
