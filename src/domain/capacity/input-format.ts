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

/** Exact half-away-from-zero rounding of an engine decimal; the result is canonical ("-0" becomes "0"). */
export function roundDecimal(value: string, places: number): string {
  if (!Number.isInteger(places) || places < 0) throw new Error("Некорректная точность округления");
  const { negative, magnitude } = decimalParts(value);
  const [whole, fraction = ""] = magnitude.split(".");
  let units = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
  if (fraction.length > places && fraction[places] >= "5") units += 1n;
  if (units === 0n) return "0";
  const digits = units.toString().padStart(places + 1, "0");
  const integer = places ? digits.slice(0, -places) : digits;
  const decimals = places ? digits.slice(-places).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${integer}${decimals ? `.${decimals}` : ""}`;
}

/** Display only: half away from zero, exactly two places. Persist the original value. */
export function formatHours(value: string): string {
  const rounded = roundDecimal(value, 2);
  const negative = rounded.startsWith("-");
  const [whole, fraction = ""] = (negative ? rounded.slice(1) : rounded).split(".");
  return `${negative ? "−" : ""}${whole},${fraction.padEnd(2, "0")} ч`;
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
