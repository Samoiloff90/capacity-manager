/** Exact finite decimals. These internal values never cross the JSON boundary. */
export type ExactDecimal = Readonly<{ coefficient: bigint; scale: number }>;

// Technical input-size protection, not a business precision or rounding rule.
export const MAX_DECIMAL_INPUT_CHARACTERS = 1024;
const canonicalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

export function isCanonicalDecimal(value: string): boolean {
  return value.length <= MAX_DECIMAL_INPUT_CHARACTERS && value !== "-0" && canonicalPattern.test(value);
}

export function parseDecimal(value: string): ExactDecimal {
  if (!isCanonicalDecimal(value)) throw new Error("Некорректная десятичная строка");
  const dot = value.indexOf(".");
  return normalize({
    coefficient: BigInt(value.replace(".", "")),
    scale: dot === -1 ? 0 : value.length - dot - 1
  });
}

export function addDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalize({ coefficient: rescale(left, scale) + rescale(right, scale), scale });
}

export function subtractDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return addDecimal(left, { coefficient: -right.coefficient, scale: right.scale });
}

export function multiplyDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalize({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

export function divideDecimalBy100(value: ExactDecimal): ExactDecimal {
  return normalize({ coefficient: value.coefficient, scale: value.scale + 2 });
}

export function compareDecimal(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const difference = rescale(left, scale) - rescale(right, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function decimalToString(value: ExactDecimal): string {
  const normalized = normalize(value);
  const negative = normalized.coefficient < 0n;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  const padded = digits.padStart(normalized.scale + 1, "0");
  const number = normalized.scale === 0
    ? padded
    : `${padded.slice(0, -normalized.scale)}.${padded.slice(-normalized.scale)}`;
  return negative ? `-${number}` : number;
}

function rescale(value: ExactDecimal, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function normalize(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value;
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}
