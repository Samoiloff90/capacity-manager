import { describe, expect, it } from "vitest";
import fixture from "./fixtures/quarter-acceptance.json";
import { readWorkbook, type WorkbookCell } from "./fixtures/xlsx-cells";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { buildQuarterReport } from "../src/export/quarter-report";
import { renderQuarterReportXlsx } from "../src/export/xlsx";

/**
 * Control examples of the quarter planner (DEC-030–DEC-043): expected values are the committed
 * output of the independent Python Fraction oracle (scripts/check-capacity-reference.py) with
 * hand-written manual checks, never produced by the application. Run the oracle with --check.
 */
type Expected = {
  availableHours: string;
  plan: Record<string, unknown>;
  directions: (Record<string, unknown> & { directionId: string; reserveMembers: { memberId: string; reserveHours: string | null }[] })[];
};
type QuarterCase = {
  id: string;
  title: string;
  manualChecks: Record<string, unknown>;
  snapshot: QuarterSnapshot;
  expected: Expected;
  report?: { summary: Record<string, WorkbookCell>; sources: WorkbookCell[][] };
};
const cases = (fixture as unknown as { cases: QuarterCase[] }).cases;

function calculate(snapshot: QuarterSnapshot): QuarterCapacityResult {
  const output = calculateQuarterCapacity(snapshot);
  if (!output.ok) throw new Error(`Valid control snapshot was rejected: ${JSON.stringify(output.errors)}`);
  return output.result;
}

describe("independent control examples of the quarter planner (Python Fraction oracle)", () => {
  it("covers the examples the PO named", () => {
    expect(cases.map((item) => item.id)).toEqual(expect.arrayContaining([
      "dec041-included-28", "dec041-estimate-34", "reserve-80x30-40x40", "review-plan-step-2", "review-plan-step-4",
      "empty-is-not-zero", "zero-is-known", "under-allocation-80", "over-allocation-106", "small-excess-of-shares",
      "small-overrun", "overrun-below-hundredth", "own-reserve-small-excess", "fractions"
    ]));
    expect(cases.filter((item) => item.report).length).toBeGreaterThanOrEqual(8);
  });

  it.each(cases)("$id — $title", ({ snapshot, expected }) => {
    const result = calculate(snapshot);
    expect(result.totals.availableHours).toBe(expected.availableHours);
    expect(result.plan).toEqual(expected.plan);
    for (const row of expected.directions) {
      const actual = result.directions.find((direction) => direction.directionId === row.directionId)!;
      const { reserveMembers, ...fields } = row;
      expect(actual).toMatchObject(fields);
      expect(actual.reserveMembers.map(({ memberId, reserveHours }) => ({ memberId, reserveHours }))).toEqual(reserveMembers);
    }
  });

  it.each(cases.filter((item) => item.report))("$id — the written report holds the same figures", async ({ snapshot, report }) => {
    const bytes = await renderQuarterReportXlsx(buildQuarterReport({
      teamName: "Контрольная команда", snapshot, result: calculate(snapshot), exportedAt: new Date(2033, 3, 1, 9, 0)
    }));
    const book = readWorkbook(bytes);
    const summary = new Map(book["Сводка"].slice(1).map((row) => [row[0], row[1]]));
    for (const [label, value] of Object.entries(report!.summary)) expect([label, summary.get(label)]).toEqual([label, value]);
    expect(book["Источники"].slice(1).map((row) => row.slice(0, 11).concat(Array(Math.max(0, 11 - row.length)).fill(null)).slice(0, 11)))
      .toEqual(report!.sources);
  });
});
