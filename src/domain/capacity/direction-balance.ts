import { formatDeficitHours, formatHours } from "./input-format";
import type { QuarterDirectionCapacity } from "./quarter-capacity.types";

export type DirectionBalanceDescription = {
  status: "surplus" | "balanced" | "deficit" | "preliminary";
  balanceLabel: string;
  balanceText: string;
  demandLabel: string;
  demandText: string;
  note: string;
  deficit: boolean;
};

/** Presentation of a validated engine result; display rounding never decides its status. */
export function describeDirectionBalance(direction: QuarterDirectionCapacity): DirectionBalanceDescription {
  const deficit = direction.overrunKnownHours !== "0";
  const demandLabel = direction.demandComplete ? "Потребность" : "Известная потребность";
  const demandText = formatHours(direction.knownDemandHours);
  const balanceText = deficit
    ? formatDeficitHours(direction.overrunKnownHours)
    : formatHours(direction.remainingKnownHours);
  const missingNote = direction.demandComplete ? ""
    : `Задач без оценки: ${direction.missingEstimateCount}. Потребность неполная.`;

  if (!direction.budgetComplete) {
    return {
      status: "preliminary", deficit, demandLabel, demandText, balanceText,
      balanceLabel: deficit ? "Предварительный дефицит" : "Предварительный остаток",
      note: ["Для подтверждения бюджета сумма долей должна быть 100%.", missingNote].filter(Boolean).join(" ")
    };
  }
  if (!direction.demandComplete) {
    return {
      status: "preliminary", deficit, demandLabel, demandText, balanceText,
      balanceLabel: deficit ? "Дефицит не менее" : "Предварительный остаток",
      note: missingNote
    };
  }
  const balanced = direction.remainingKnownHours === "0";
  return {
    status: deficit ? "deficit" : balanced ? "balanced" : "surplus",
    balanceLabel: deficit ? "Дефицит" : balanced ? "Баланс" : "Остаток",
    balanceText, demandLabel, demandText, note: "", deficit
  };
}
