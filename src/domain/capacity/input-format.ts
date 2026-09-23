import { isCanonicalDecimal, MAX_DECIMAL_INPUT_CHARACTERS } from "./decimal-exact";

/** Blank stays missing, not zero. No exponent/group separators or Number conversion. */
export function normalizeUserDecimal(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (value.length > MAX_DECIMAL_INPUT_CHARACTERS || !/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value)) {
    throw new Error("Введите десятичное число с точкой или запятой без разделителей тысяч");
  }
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "").replace(",", ".");
  const [whole = "", fraction = ""] = unsigned.split(".");
  const integer = whole.replace(/^0+/, "") || "0";
  const decimals = fraction.replace(/0+$/, "");
  const magnitude = decimals ? `${integer}.${decimals}` : integer;
  const canonical = negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
  if (!isCanonicalDecimal(canonical)) throw new Error("Число превышает технический предел длины");
  return canonical;
}

/** Display only: half away from zero, exactly two places. Persist the original value. */
export function formatHours(value: string): string {
  const { negative, magnitude } = decimalParts(value);
  const [whole, fraction = ""] = magnitude.split(".");
  let hundredths = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if (fraction.length > 2 && fraction[2] >= "5") hundredths += 1n;
  const digits = hundredths.toString().padStart(3, "0");
  const sign = negative && hundredths !== 0n ? "−" : "";
  return `${sign}${digits.slice(0, -2)},${digits.slice(-2)} ч`;
}

/** A strictly positive deficit must never become a displayed zero after rounding. */
export function formatDeficitHours(value: string): string {
  const { negative, magnitude } = decimalParts(value);
  if (negative) throw new Error("Превышение бюджета не может быть отрицательным");
  if (isTinyNonzero(magnitude)) return "<0,01 ч";
  return formatHours(value);
}

/** Signed balance with a separate, readable indication for a sub-cent deficit. */
export function formatBalanceHours(value: string): string {
  const { negative, magnitude } = decimalParts(value);
  if (negative && isTinyNonzero(magnitude)) return "Дефицит <0,01 ч";
  return formatHours(value);
}

function isTinyNonzero(value: string): boolean {
  return value !== "0" && value.startsWith("0.") && value.slice(2, 4).padEnd(2, "0") === "00";
}

function decimalParts(value: string): { negative: boolean; magnitude: string } {
  // Engine outputs can exceed the input's technical length after exact multiplication.
  // Do not feed them back through the input validator or lose high precision results.
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) || value === "-0") {
    throw new Error("Ожидается каноническое десятичное число");
  }
  return { negative: value.startsWith("-"), magnitude: value.startsWith("-") ? value.slice(1) : value };
}
