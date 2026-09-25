import { describe, expect, it } from "vitest";
import { MAX_DECIMAL_INPUT_CHARACTERS } from "../src/domain/capacity/decimal-exact";
import { formatBalanceHours, formatDeficitHours, formatHours, normalizeUserDecimal, roundDecimal } from "../src/domain/capacity/input-format";

describe("exact user decimal normalization", () => {
  it.each([
    ["", null], [" \t\n", null], ["0", "0"], [" 0,50 ", "0.5"],
    ["00041.6000", "41.6"], ["+000.7500", "0.75"], [",75", "0.75"],
    [".125", "0.125"], ["20,", "20"], ["-0,000", "0"], ["-0008,400", "-8.4"],
    ["9007199254740993,1234567890123456789", "9007199254740993.1234567890123456789"]
  ])("normalizes %j without binary number conversion", (input, expected) => {
    expect(normalizeUserDecimal(input!)).toBe(expected);
  });

  it.each(["1e3", "NaN", "Infinity", "1 000", "1\u00a0000", "1,2.3", "1,2,3", "--1", "0x10", ".", "+", "1/2"])(
    "rejects malformed decimal %j", (input) => expect(() => normalizeUserDecimal(input)).toThrow()
  );

  it("keeps precision up to the existing technical character boundary", () => {
    const digits = "1".repeat(MAX_DECIMAL_INPUT_CHARACTERS);
    expect(normalizeUserDecimal(digits)).toBe(digits);
    expect(() => normalizeUserDecimal(digits + "1")).toThrow();
  });
});

describe("hours display without changing the saved value", () => {
  it.each([
    ["0", "0,00 ч"], ["208", "208,00 ч"], ["41.6", "41,60 ч"], ["-8.4", "−8,40 ч"],
    ["1.0049", "1,00 ч"], ["1.005", "1,01 ч"], ["-1.005", "−1,01 ч"],
    ["9.999", "10,00 ч"], ["-0.004", "0,00 ч"], ["-0.005", "−0,01 ч"],
    ["9007199254740993.125", "9007199254740993,13 ч"]
  ])("rounds %s half away from zero", (input, expected) => expect(formatHours(input)).toBe(expected));

  it.each(["0.0000000000000000000001", "0.004", "0.005", "0.009999"])(
    "keeps a tiny positive deficit visible: %s", (input) => {
      expect(formatDeficitHours(input)).toBe("<0,01 ч");
      expect(formatBalanceHours(`-${input}`)).toBe("Дефицит <0,01 ч");
    }
  );

  it("distinguishes zero, the threshold, and a signed non-tiny balance", () => {
    expect(formatDeficitHours("0")).toBe("0,00 ч");
    expect(formatDeficitHours("0.01")).toBe("0,01 ч");
    expect(formatDeficitHours("8.4")).toBe("8,40 ч");
    expect(formatBalanceHours("-0.01")).toBe("−0,01 ч");
    expect(formatBalanceHours("60")).toBe("60,00 ч");
    expect(() => formatDeficitHours("-1")).toThrow();
  });

  it("displays exact engine products longer than the input payload limit", () => {
    const whole = "9".repeat(MAX_DECIMAL_INPUT_CHARACTERS + 1);
    expect(formatHours(whole)).toBe(`${whole},00 ч`);
    expect(formatDeficitHours(`0.${"0".repeat(MAX_DECIMAL_INPUT_CHARACTERS)}1`)).toBe("<0,01 ч");
  });

  it.each(["1.00", "-0", "NaN", "", "1,25"])("requires canonical output: %j", (input) => {
    expect(() => formatHours(input)).toThrow();
    expect(() => formatBalanceHours(input)).toThrow();
    expect(() => formatDeficitHours(input)).toThrow();
  });
});

describe("exact decimal rounding shared by the screen and the report", () => {
  it.each([
    ["0", 2, "0"], ["252", 2, "252"], ["50.4", 2, "50.4"], ["1.005", 2, "1.01"], ["1.0049", 2, "1"],
    ["-1.005", 2, "-1.01"], ["-0.004", 2, "0"], ["-0.001", 2, "0"], ["9.999", 2, "10"],
    ["0.125", 0, "0"], ["2.5", 0, "3"], ["-2.5", 0, "-3"], ["12.3456", 3, "12.346"]
  ])("rounds %s to %i places as %s", (value, places, expected) => {
    expect(roundDecimal(value, places)).toBe(expected);
  });

  it("keeps long exact engine values without binary conversion", () => {
    const whole = "9".repeat(MAX_DECIMAL_INPUT_CHARACTERS + 1);
    expect(roundDecimal(`${whole}.994`, 2)).toBe(`${whole}.99`);
  });

  it.each([[-1], [1.5], [Number.NaN]])("rejects precision %s", (places) => {
    expect(() => roundDecimal("1", places)).toThrow();
  });
});
