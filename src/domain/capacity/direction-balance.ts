import { formatBalanceHours, formatDeficitHours, formatHours, type HoursFormatter } from "./input-format";
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
export function describeDirectionBalance(
  direction: QuarterDirectionCapacity,
  format: HoursFormatter = formatHours
): DirectionBalanceDescription {
  const deficit = direction.overrunKnownHours !== "0";
  const demandLabel = direction.demandComplete ? "Потребность" : "Известная потребность";
  const demandText = format(direction.knownDemandHours);
  const balanceText = deficit
    ? formatDeficitHours(direction.overrunKnownHours, format)
    : format(direction.remainingKnownHours);
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

export type BalanceCell = { label: string | null; text: string };

/**
 * On screen the status column already names ordinary results, so only special labels stay
 * above the number. Without a label a deficit is shown with a minus sign: "−35,20 ч".
 */
export function describeScreenBalanceCells(
  direction: QuarterDirectionCapacity,
  format: HoursFormatter
): { demand: BalanceCell; balance: BalanceCell } {
  const description = describeDirectionBalance(direction, format);
  const plainBalance = description.status !== "preliminary";
  return {
    demand: { label: direction.demandComplete ? null : description.demandLabel, text: description.demandText },
    balance: plainBalance
      ? { label: null, text: description.deficit
        ? formatBalanceHours(`-${direction.overrunKnownHours}`, format)
        : description.balanceText }
      : { label: description.balanceLabel, text: description.balanceText }
  };
}
