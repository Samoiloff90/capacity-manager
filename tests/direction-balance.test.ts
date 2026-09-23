import { describe, expect, it } from "vitest";
import { getQuarterDates } from "../src/domain/capacity/calendar-quarter";
import { describeDirectionBalance } from "../src/domain/capacity/direction-balance";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterCapacityResult, QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";

// Synthetic 20-day calendar × 8 hours × 0.625 FTE = 100 available hours.
function snapshot(changes: Partial<QuarterSnapshot> = {}): QuarterSnapshot {
  return {
    year: 2026, quarter: 1,
    calendar: getQuarterDates(2026, 1).map((date, index) => ({ date, isWorking: index < 20 })),
    competencies: [{ id: "dev", name: "Разработка" }],
    members: [{ id: "person", name: "Участник", competencyId: "dev", fte: "0.625" }],
    absences: [],
    directions: [{ id: "product", name: "Продукт", percent: "20" }, { id: "reserve", name: "Встречи", percent: "80" }],
    tasks: [], ...changes
  };
}

function task(id: string, estimateHours: string | null) {
  return { id, name: `Задача ${id}`, directionId: "product", estimateHours };
}

function calculate(changes: Partial<QuarterSnapshot> = {}): QuarterCapacityResult {
  const result = calculateQuarterCapacity(snapshot(changes));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.result;
}

function product(changes: Partial<QuarterSnapshot> = {}) {
  const direction = calculate(changes).directions.find((item) => item.directionId === "product");
  if (!direction) throw new Error("Product direction missing");
  return direction;
}

describe("direction balance presentation from exact engine results", () => {
  it.each([
    ["10", "surplus", "Остаток", "10,00 ч", false],
    ["20", "balanced", "Баланс", "0,00 ч", false],
    ["21", "deficit", "Дефицит", "1,00 ч", true]
  ] as const)("describes complete demand %s with the correct sign", (estimate, status, balanceLabel, balanceText, deficit) => {
    expect(describeDirectionBalance(product({ tasks: [task("one", estimate)] }))).toMatchObject({
      status, balanceLabel, balanceText, deficit, demandLabel: "Потребность", note: ""
    });
  });

  it("distinguishes a missing estimate from an explicit zero without confirming spare hours", () => {
    const unknown = describeDirectionBalance(product({ tasks: [task("one", null)] }));
    const zero = describeDirectionBalance(product({ tasks: [task("one", "0")] }));
    expect(unknown).toMatchObject({
      status: "preliminary", balanceLabel: "Предварительный остаток", balanceText: "20,00 ч",
      demandLabel: "Известная потребность", demandText: "0,00 ч", deficit: false
    });
    expect(unknown.note).toContain("Задач без оценки: 1");
    expect(unknown.note).toContain("Потребность неполная");
    expect(zero).toMatchObject({ status: "surplus", balanceLabel: "Остаток", demandLabel: "Потребность", note: "" });
  });

  it.each([
    ["10", "Предварительный остаток", "10,00 ч", false],
    ["20", "Предварительный остаток", "0,00 ч", false],
    ["30", "Дефицит не менее", "10,00 ч", true]
  ] as const)("keeps demand incomplete with known hours %s and two missing estimates", (known, balanceLabel, balanceText, deficit) => {
    const description = describeDirectionBalance(product({ tasks: [task("known", known), task("blank-a", null), task("blank-b", null)] }));
    expect(description).toMatchObject({ status: "preliminary", balanceLabel, balanceText, deficit, demandLabel: "Известная потребность" });
    expect(description.note).toContain("Задач без оценки: 2");
  });

  it.each([
    ["70", "10", "Предварительный остаток", false], ["70", "20", "Предварительный остаток", false],
    ["70", "30", "Предварительный дефицит", true], ["90", "10", "Предварительный остаток", false],
    ["90", "20", "Предварительный остаток", false], ["90", "30", "Предварительный дефицит", true]
  ] as const)("keeps all balances preliminary with reserve share %s and known demand %s", (reserve, known, balanceLabel, deficit) => {
    const direction = product({
      directions: [{ id: "product", name: "Продукт", percent: "20" }, { id: "reserve", name: "Резерв", percent: reserve }],
      tasks: [task("one", known)]
    });
    expect(direction.budgetComplete).toBe(false);
    expect(describeDirectionBalance(direction)).toMatchObject({
      status: "preliminary", balanceLabel, deficit, demandLabel: "Потребность"
    });
    expect(describeDirectionBalance(direction).note).toContain("100%");
  });

  it("explains both invalid allocation and missing estimates together", () => {
    const description = describeDirectionBalance(product({
      directions: [{ id: "product", name: "Продукт", percent: "20" }],
      tasks: [task("known", "21"), task("blank", null)]
    }));
    expect(description).toMatchObject({
      status: "preliminary", balanceLabel: "Предварительный дефицит", deficit: true, demandLabel: "Известная потребность"
    });
    expect(description.note).toContain("100%");
    expect(description.note).toContain("Задач без оценки: 1");
  });

  it.each(["complete", "missing", "allocation"] as const)("never rounds a tiny %s deficit to zero", (mode) => {
    const changes: Partial<QuarterSnapshot> = {
      tasks: mode === "missing"
        ? [task("known", "20.0000000000000001"), task("blank", null)]
        : [task("known", "20.0000000000000001")],
      ...(mode === "allocation" ? { directions: [{ id: "product", name: "Продукт", percent: "20" }] } : {})
    };
    const description = describeDirectionBalance(product(changes));
    expect(description.balanceText).toBe("<0,01 ч");
    expect(description.deficit).toBe(true);
    expect(description.status).toBe(mode === "complete" ? "deficit" : "preliminary");
  });

  it("decides the status from exact hours even when a tiny positive surplus displays as zero", () => {
    const description = describeDirectionBalance(product({ tasks: [task("one", "19.9999999999999999")] }));
    expect(description).toMatchObject({ status: "surplus", balanceLabel: "Остаток", balanceText: "0,00 ч", deficit: false });
  });

  it("keeps a task-free reserve separate from another direction's overrun", () => {
    const result = calculate({ tasks: [task("one", "30")] });
    const descriptions = Object.fromEntries(result.directions.map((direction) => [direction.directionId, describeDirectionBalance(direction)]));
    expect(descriptions.product).toMatchObject({ status: "deficit", balanceText: "10,00 ч", deficit: true });
    expect(descriptions.reserve).toMatchObject({ status: "surplus", balanceText: "80,00 ч", demandText: "0,00 ч", deficit: false });
  });

  it("distinguishes a zero-capacity reserve from a zero-capacity direction with tasks", () => {
    const result = calculate({ members: [], tasks: [task("one", "3")] });
    const descriptions = Object.fromEntries(result.directions.map((direction) => [direction.directionId, describeDirectionBalance(direction)]));
    expect(descriptions.product).toMatchObject({ status: "deficit", balanceText: "3,00 ч", deficit: true });
    expect(descriptions.reserve).toMatchObject({ status: "balanced", balanceText: "0,00 ч", deficit: false });
  });
});
