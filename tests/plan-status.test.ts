import { describe, expect, it } from "vitest";
import { describeQuarterPlanStatus } from "../src/domain/capacity/plan-status";
import { calculate, readmeQuarter } from "./fixtures/readme-quarter";

describe("quarter plan status", () => {
  it("is ready when allocation is 100% and every task has an estimate", () => {
    expect(describeQuarterPlanStatus(calculate(readmeQuarter()))).toEqual({ ready: true, reasons: [] });
  });

  it("reports missing directions instead of a 0% allocation", () => {
    const status = describeQuarterPlanStatus(calculate(readmeQuarter({ directions: [], tasks: [] })));
    expect(status).toEqual({ ready: false, reasons: ["Направления не заданы."] });
  });

  it.each([
    ["90", "Сумма долей направлений 90% вместо 100%."],
    ["110", "Сумма долей направлений 110% вместо 100%."],
    ["90.5", "Сумма долей направлений 90,5% вместо 100%."]
  ])("reports an allocation of %s%%", (reserve, reason) => {
    const snapshot = readmeQuarter({ directions: [
      { id: "z-product", name: "Продукт", percent: "20", kind: "work" as const, memberPercents: [] },
      { id: "a-meetings", name: "Встречи и прочее", percent: String(Number(reserve) - 20), kind: "work" as const, memberPercents: [] }
    ] });
    expect(describeQuarterPlanStatus(calculate(snapshot))).toEqual({ ready: false, reasons: [reason] });
  });

  it("counts tasks without an estimate and combines reasons in a fixed order", () => {
    const snapshot = readmeQuarter({
      directions: [{ id: "z-product", name: "Продукт", percent: "20", kind: "work" as const, memberPercents: [] }],
      tasks: [
        { id: "t1", name: "A", directionId: "z-product", estimateHours: null, mark: "plan" as const, link: null, comment: null },
        { id: "t2", name: "B", directionId: "z-product", estimateHours: null, mark: "plan" as const, link: null, comment: null },
        { id: "t3", name: "C", directionId: "z-product", estimateHours: "0", mark: "plan" as const, link: null, comment: null }
      ]
    });
    expect(describeQuarterPlanStatus(calculate(snapshot))).toEqual({
      ready: false,
      reasons: ["Сумма долей направлений 20% вместо 100%.", "Задач без оценки: 2."]
    });
  });
});
