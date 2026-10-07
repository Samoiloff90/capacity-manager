import { describe, expect, it } from "vitest";
import { currentDemoQuarter, legacyDemoQuarter } from "./fixtures/demo-projects";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult } from "../src/domain/capacity/quarter-capacity.types";
import { upgradeQuarterSnapshotV1 } from "../src/domain/capacity/quarter-snapshot-format";
import { validateQuarterSnapshot, validateQuarterSnapshotV1 } from "../src/domain/capacity/quarter-snapshot.validation";

function calculate(input: unknown): QuarterCapacityResult {
  const output = calculateQuarterCapacity(input);
  if (!output.ok) throw new Error(JSON.stringify(output.errors));
  return output.result;
}

const source = (result: QuarterCapacityResult, id: string) => result.directions.find((row) => row.directionId === id)!;

describe("fictional demo projects of a preview build", () => {
  it("current format: 2 000 h, «Запросы УИ» 250 h with 200 h in the plan (start of the DEC-041 control example)", async () => {
    const snapshot = currentDemoQuarter();
    expect(validateQuarterSnapshot(snapshot).ok).toBe(true);
    const result = calculate(snapshot);
    expect(result.totals.availableHours).toBe("2000");
    expect([source(result, "src-requests").budgetHours, source(result, "src-requests").knownDemandHours,
      source(result, "src-requests").remainingKnownHours]).toEqual(["250", "200", "50"]);
    // An overrun and a plan with an unestimated work are part of the demo too.
    expect(source(result, "src-mobile").overrunKnownHours).toBe("20");
    expect([source(result, "src-product").knownDemandHours, source(result, "src-product").missingEstimateCount]).toEqual(["600", 1]);
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot("./fixtures/demo/current-2027-q1.json");
  });

  it("format of 0.3.0: valid as saved by that version, opened with the same numbers", async () => {
    const legacy = legacyDemoQuarter();
    expect(validateQuarterSnapshotV1(legacy).ok).toBe(true);
    const result = calculate(upgradeQuarterSnapshotV1(legacy));
    expect(result.totals.availableHours).toBe("1408");
    expect([source(result, "dir-product").budgetHours, source(result, "dir-product").knownDemandHours]).toEqual(["704", "160"]);
    await expect(`${JSON.stringify(legacy, null, 2)}\n`).toMatchFileSnapshot("./fixtures/demo/legacy-2026-q4.format1.json");
  });
});
