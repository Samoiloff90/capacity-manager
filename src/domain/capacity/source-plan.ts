import { addDecimal, compareDecimal, decimalToString, parseDecimal, subtractDecimal, type ExactDecimal } from "./decimal-exact";
import { formatDeficitHours, normalizeUserDecimal, roundDecimal, type HoursFormatter } from "./input-format";
import type { QuarterCapacityResult, QuarterDirectionCapacity } from "./quarter-capacity.types";

/**
 * Presentation of the quarter planner (QUARTER_PLANNING_UX.md): consequences of planning
 * decisions, «не менее / не более» while estimates are missing, shares and warnings. All
 * numbers come from the engine result as exact decimals; only display text is rounded.
 */

const zero = parseDecimal("0");

/** A work source as it is, or as it would be after a change of the works in its plan. */
export type SourceState = {
  quotaSet: boolean;
  budgetHours: string;
  plannedKnownHours: string;
  /** Works in the plan without an estimate: the known hours are a lower bound. */
  missingEstimateCount: number;
  remainingHours: string;
  overrunHours: string;
};

export function sourceState(source: QuarterDirectionCapacity): SourceState {
  return {
    quotaSet: source.quotaSet, budgetHours: source.budgetHours, plannedKnownHours: source.knownDemandHours,
    missingEstimateCount: source.missingEstimateCount,
    remainingHours: source.overrunKnownHours === "0" ? source.remainingKnownHours : "0",
    overrunHours: source.overrunKnownHours
  };
}

/** Estimates of works that enter or leave the plan; null is a work without an estimate. */
export type PlanChange = { add?: readonly (string | null)[]; remove?: readonly (string | null)[] };

export function forecastSource(source: QuarterDirectionCapacity, change: PlanChange): SourceState {
  let known: ExactDecimal = parseDecimal(source.knownDemandHours);
  let missing = source.missingEstimateCount;
  for (const estimate of change.add ?? []) {
    if (estimate === null) missing += 1; else known = addDecimal(known, parseDecimal(estimate));
  }
  for (const estimate of change.remove ?? []) {
    if (estimate === null) missing -= 1; else known = subtractDecimal(known, parseDecimal(estimate));
  }
  const rest = subtractDecimal(parseDecimal(source.budgetHours), known);
  const over = compareDecimal(rest, zero) < 0;
  return {
    quotaSet: source.quotaSet, budgetHours: source.budgetHours, plannedKnownHours: decimalToString(known),
    missingEstimateCount: Math.max(0, missing),
    remainingHours: over ? "0" : decimalToString(rest),
    overrunHours: over ? decimalToString(subtractDecimal(zero, rest)) : "0"
  };
}

const lowerBound = (state: SourceState) => state.missingEstimateCount > 0 ? "не менее " : "";
const upperBound = (state: SourceState) => state.missingEstimateCount > 0 ? "не более " : "";
const overrun = (state: SourceState) => state.overrunHours !== "0";

/** «228 ч» or «не менее 228 ч» while works in the plan have no estimate. */
export function describePlanned(state: SourceState, format: HoursFormatter): string {
  return `${lowerBound(state)}${format(state.plannedKnownHours)}`;
}

/** «остаток 22 ч», «остаток не более 22 ч», «перебор 10 ч», «перебор не менее 10 ч». */
export function describeRest(state: SourceState, format: HoursFormatter): string {
  if (!state.quotaSet) return "доля не задана";
  return overrun(state)
    ? `перебор ${lowerBound(state)}${formatDeficitHours(state.overrunHours, format)}`
    : `остаток ${upperBound(state)}${format(state.remainingHours)}`;
}

/**
 * The consequence next to «Включить в план квартала» (DEC-042): «После включения работы на
 * 16 ч в плане будет 216 ч, останется 34 ч».
 */
export function describeInclusion(source: QuarterDirectionCapacity, estimate: string | null, format: HoursFormatter): string {
  if (!source.quotaSet) return "Доля источника не задана: остаток появится, когда будет задана доля.";
  const after = forecastSource(source, { add: [estimate] });
  if (estimate === null) {
    return overrun(after)
      ? `Оценки нет, поэтому точный перебор пока неизвестен: перебор не менее ${formatDeficitHours(after.overrunHours, format)}.`
      : `Оценки нет, поэтому точный остаток пока неизвестен: останется не более ${format(after.remainingHours)}.`;
  }
  const rest = overrun(after)
    ? `перебор ${lowerBound(after)}${formatDeficitHours(after.overrunHours, format)}`
    : `останется ${upperBound(after)}${format(after.remainingHours)}`;
  return `После включения работы на ${format(estimate)} в плане будет ${describePlanned(after, format)}, ${rest}.`;
}

/** Shorter form for a row of a candidate: «В плане будет 216 ч, останется 34 ч». */
export function describeInclusionShort(source: QuarterDirectionCapacity, estimate: string | null, format: HoursFormatter): string {
  if (!source.quotaSet) return "Доля источника не задана";
  const after = forecastSource(source, { add: [estimate] });
  const rest = overrun(after)
    ? `перебор ${lowerBound(after)}${formatDeficitHours(after.overrunHours, format)}`
    : `останется ${upperBound(after)}${format(after.remainingHours)}`;
  return estimate === null ? `Без оценки: ${rest}` : `В плане будет ${describePlanned(after, format)}, ${rest}`;
}

/** «Оценка: 28 ч → 34 ч. Остаток квоты станет 16 ч.» A new estimate replaces the old one (DEC-041). */
export function describeEstimateChange(source: QuarterDirectionCapacity, before: string | null, after: string | null,
  inPlan: boolean, format: HoursFormatter): string | null {
  if (before === after) return null;
  const text = (value: string | null) => value === null ? "без оценки" : format(value);
  const head = `Оценка: ${text(before)} → ${text(after)}.`;
  if (!inPlan) return `${head} Бюджет не занимает, пока работа не в плане квартала.`;
  if (!source.quotaSet) return `${head} Доля источника не задана.`;
  const state = forecastSource(source, { remove: [before], add: [after] });
  return overrun(state)
    ? `${head} Перебор квоты станет ${lowerBound(state)}${formatDeficitHours(state.overrunHours, format)}.`
    : `${head} Остаток квоты станет ${upperBound(state)}${format(state.remainingHours)}.`;
}

/** Display of a share: «12,5%». Exact input values are never rounded. */
export function formatPercent(value: string): string {
  const negative = value.startsWith("-");
  return `${negative ? "−" : ""}${(negative ? value.slice(1) : value).replace(".", ",")}%`;
}

/** part / whole × 100, half away from zero; null when whole is 0 (no division by zero). */
export function ratioPercent(part: string, whole: string, places = 1): string | null {
  const numerator = parseDecimal(part);
  const denominator = parseDecimal(whole);
  if (denominator.coefficient === 0n) return null;
  const scale = 10n ** BigInt(places + 2);
  // Common scale, then integer division with one guard digit for rounding.
  const shift = numerator.scale - denominator.scale;
  let top = numerator.coefficient * scale * 10n;
  let bottom = denominator.coefficient;
  if (shift > 0) bottom *= 10n ** BigInt(shift); else top *= 10n ** BigInt(-shift);
  const negative = (top < 0n) !== (bottom < 0n);
  const quotient = (top < 0n ? -top : top) / (bottom < 0n ? -bottom : bottom);
  const rounded = (quotient + 5n) / 10n;
  const digits = rounded.toString().padStart(places + 1, "0");
  const whole1 = places ? digits.slice(0, -places) : digits;
  const fraction = places ? digits.slice(-places).replace(/0+$/, "") : "";
  const text = `${whole1}${fraction ? `.${fraction}` : ""}`;
  return negative && text !== "0" ? `-${text}` : text;
}

/** Share of the available capacity actually given to a source; a reserve with own shares differs from its common share. */
export function effectivePercent(source: QuarterDirectionCapacity, availableHours: string): string | null {
  if (!source.quotaSet) return null;
  if (source.ownPercentCount === 0) return source.percent;
  return ratioPercent(source.budgetHours, availableHours, 2);
}

export type AllocationSummary = {
  allocatedHours: string;
  allocatedPercent: string;
  unallocatedHours: string;
  unallocatedPercent: string;
  overallocated: boolean;
};

/** «Выделено источникам» and «Не распределено»; by hours, by entered shares when nobody is available. */
export function describeAllocation(result: Pick<QuarterCapacityResult, "plan" | "totals">): AllocationSummary {
  const available = result.totals.availableHours;
  const allocatedPercent = ratioPercent(result.plan.allocatedHours, available, 2) ?? result.plan.nominalPercent;
  return {
    allocatedHours: result.plan.allocatedHours,
    allocatedPercent,
    unallocatedHours: result.plan.unallocatedHours,
    unallocatedPercent: decimalToString(subtractDecimal(parseDecimal("100"), parseDecimal(allocatedPercent))),
    overallocated: result.plan.overallocated
  };
}

/** Problems a save does not fix (QUARTER_PLANNING_UX.md, «Сохранение с проблемами»). */
export function describeSaveProblems(result: QuarterCapacityResult, format: HoursFormatter): string[] {
  const problems: string[] = [];
  const allocation = describeAllocation(result);
  if (allocation.overallocated) {
    const excess = allocation.unallocatedHours.startsWith("-") ? allocation.unallocatedHours.slice(1) : "0";
    problems.push(`сумма долей ${formatPercent(allocation.allocatedPercent)}, на ${format(excess)} больше доступной ёмкости`);
  }
  const over = result.directions.filter((source) => source.kind === "work" && source.quotaSet && source.overrunKnownHours !== "0");
  if (over.length) {
    problems.push(`перебор квоты — ${over.map((source) => {
      const state = sourceState(source);
      return `«${source.name}» ${lowerBound(state)}${formatDeficitHours(state.overrunHours, format)}`;
    }).join(", ")}`);
  }
  return problems;
}

/**
 * Sources whose quota changed and whose overrun grew since the saved version: «квота
 * 250 ч → 175 ч, в плане 200 ч, перебор 25 ч». Works are never excluded automatically.
 */
export function describeQuotaDrops(saved: QuarterCapacityResult | null, current: QuarterCapacityResult, format: HoursFormatter): string[] {
  if (!saved) return [];
  return current.directions.flatMap((source) => {
    const before = saved.directions.find((row) => row.directionId === source.directionId);
    if (!before || source.kind !== "work" || !source.quotaSet || !before.quotaSet) return [];
    if (before.budgetHours === source.budgetHours) return [];
    if (compareDecimal(parseDecimal(source.overrunKnownHours), parseDecimal(before.overrunKnownHours)) <= 0) return [];
    const state = sourceState(source);
    return [`«${source.name}» — квота ${format(before.budgetHours)} → ${format(source.budgetHours)}, в плане ${describePlanned(state, format)}, перебор ${lowerBound(state)}${formatDeficitHours(state.overrunHours, format)}`];
  });
}

/** Rounded fill for the bar and «85% квоты»; null without a quota. */
export function fillPercent(source: QuarterDirectionCapacity): number | null {
  if (!source.quotaSet) return null;
  const percent = ratioPercent(source.knownDemandHours, source.budgetHours, 0);
  return percent === null ? null : Number(percent);
}

export type EstimateInput =
  | { kind: "empty" }
  | { kind: "hours"; hours: string }
  | { kind: "invalid"; message: string };

// A size such as M or XL is not hours (DEC-041); Cyrillic М, Х, С typed for Latin count too.
const SIZE = /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL)$/;

/** «Полная оценка, ч»: «28», «12,5», «12.5», «28 ч». Empty is «Без оценки», not 0 (DEC-043). */
export function parseEstimateInput(input: string): EstimateInput {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const latin = text.toUpperCase().replace(/М/g, "M").replace(/Х/g, "X").replace(/С/g, "S");
  if (SIZE.test(latin)) return { kind: "invalid", message: `«${text}» — размер, а нужны часы. Размеры в часы не переводятся.` };
  const number = text.replace(/\s*(?:ч|час|часа|часов|h)\.?$/i, "");
  let hours: string | null;
  try { hours = normalizeUserDecimal(number); }
  catch { return { kind: "invalid", message: `«${text}» — не число часов. Пример: 28 или 12,5.` }; }
  if (hours === null) return { kind: "invalid", message: `«${text}» — не число часов. Пример: 28 или 12,5.` };
  if (hours.startsWith("-")) return { kind: "invalid", message: "Оценка не может быть отрицательной." };
  return { kind: "hours", hours };
}

/** The non-blocking note for 0 h on a new work (DEC-043). */
export const ZERO_ESTIMATE_NOTE = "Указана нулевая трудоёмкость. Если оценка неизвестна, оставьте поле пустым";

export type ShareInput = { kind: "empty" } | { kind: "percent"; percent: string } | { kind: "invalid"; message: string };

/** «Доля, %»: empty is «доля не задана» and not an error (QUARTER_PLANNING_UX.md). */
export function parseShareInput(input: string): ShareInput {
  const text = input.trim().replace(/\s*%$/, "");
  if (!text) return { kind: "empty" };
  let percent: string | null;
  try { percent = normalizeUserDecimal(text); }
  catch { return { kind: "invalid", message: "Число от 0 до 100." }; }
  if (percent === null || percent.startsWith("-") || compareDecimal(parseDecimal(percent), parseDecimal("100")) > 0) {
    return { kind: "invalid", message: "Число от 0 до 100." };
  }
  return { kind: "percent", percent };
}

/** Hours rounded for a «было» marker: changes smaller than a hundredth are not shown. */
export function sameOnScreen(left: string, right: string): boolean {
  return roundDecimal(left, 2) === roundDecimal(right, 2);
}
