import { afterEach, describe, expect, it, vi } from "vitest";

// "fflate" resolves to the worker-free shim through the alias. Spying on its zip proves
// that write-excel-file (inlined in vitest.config.ts) goes through the same alias.
vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return { ...actual, zip: vi.fn(actual.zip) };
});

import * as fflate from "fflate";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { buildQuarterReport } from "../src/export/quarter-report";
import { renderQuarterReportXlsx } from "../src/export/xlsx";
import { calculate, readmeQuarter } from "./fixtures/readme-quarter";
import { readWorkbook } from "./fixtures/xlsx-cells";

const exportedAt = new Date(2026, 9, 5, 9, 7);
const decoder = new TextDecoder();

async function workbook(snapshot: QuarterSnapshot = readmeQuarter()): Promise<Record<string, string>> {
  const report = buildQuarterReport({ teamName: "Команда А", snapshot, result: calculate(snapshot), exportedAt });
  const bytes = await renderQuarterReportXlsx(report);
  expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  const files = fflate.unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, decoder.decode(content)]));
}

function sheetXml(files: Record<string, string>, index: number): string {
  const xml = files[`xl/worksheets/sheet${index}.xml`];
  if (!xml) throw new Error(`Нет листа ${index}`);
  return xml;
}

/** The style (cellXfs entry) of one cell, to check number formats. */
function cellStyle(files: Record<string, string>, sheet: number, address: string): string {
  const cell = new RegExp(`<c r="${address}"([^>]*)>`).exec(sheetXml(files, sheet));
  if (!cell) throw new Error(`Нет ячейки ${address}`);
  // A cell without s="…" uses the default style 0 (General).
  const styleIndex = Number(/\bs="(\d+)"/.exec(cell[1])?.[1] ?? 0);
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(files["xl/styles.xml"])![1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)!;
  return xfs[styleIndex];
}

function sharedStrings(files: Record<string, string>): string[] {
  return [...files["xl/sharedStrings.xml"].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => match[1]);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("XLSX rendering of the quarter report", () => {
  it("writes six named sheets with numbers, dates and a frozen header", async () => {
    const files = await workbook();
    expect([...files["xl/workbook.xml"].matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["Сводка", "Люди", "Компетенции", "Источники", "Работы", "Отсутствия"]);
    expect(sheetXml(files, 2)).toContain("<v>252</v>");
    expect(sheetXml(files, 4)).toContain("<v>50.4</v>");
    expect(sheetXml(files, 4)).toContain("<v>4.6</v>");
    // 2026-10-01 and 2026-10-02 as Excel serial dates, independent of the time zone.
    expect(sheetXml(files, 6)).toContain("<v>46296</v>");
    expect(sheetXml(files, 6)).toContain("<v>46297</v>");
    for (let sheet = 1; sheet <= 6; sheet += 1) {
      expect(sheetXml(files, sheet)).toContain('ySplit="1"');
      expect(sheetXml(files, sheet)).toContain('state="frozen"');
    }
  });

  it("applies the agreed formats and colours", async () => {
    const files = await workbook(readmeQuarter({ tasks: [
      { id: "t1", name: "Без оценки", directionId: "z-product", estimateHours: null, mark: "plan" as const, link: null, comment: null },
      { id: "t2", name: "Большая", directionId: "z-product", estimateHours: "100", mark: "plan" as const, link: null, comment: null }
    ] }));
    const styles = files["xl/styles.xml"];
    for (const colour of ["FFE8EEF5", "FFFDECEC", "FF9B1C1C", "FF8A5A00"]) expect(styles).toContain(colour);
    expect(styles).toContain('formatCode="#,##0.00"');
    expect(styles).toContain('formatCode="dd.mm.yyyy"');
    // Hours use the custom format; percent (C2 of «Источники») and rate (C2 of «Люди») stay General.
    expect(cellStyle(files, 4, "E2")).toMatch(/numFmtId="1\d\d"/);
    expect(cellStyle(files, 4, "C2")).not.toMatch(/numFmtId="[1-9]/);
    expect(cellStyle(files, 2, "C2")).not.toMatch(/numFmtId="[1-9]/);
  });

  it("keeps user text as text, never as a formula", async () => {
    const files = await workbook(readmeQuarter({ tasks: [
      { id: "t1", name: "<b>A & B</b> =1+1", directionId: "z-product", estimateHours: "1", mark: "plan" as const, link: null, comment: null },
      { id: "t2", name: "=HYPERLINK(\"x\")", directionId: "z-product", estimateHours: "1", mark: "plan" as const, link: null, comment: null }
    ] }));
    const strings = sharedStrings(files).join("\n");
    expect(strings).toContain("&lt;b&gt;A &amp; B&lt;/b&gt; =1+1");
    expect(strings).toContain('=HYPERLINK("x")');
    for (let sheet = 1; sheet <= 6; sheet += 1) expect(sheetXml(files, sheet)).not.toMatch(/<f[\s>]/);
  });

  it("does not corrupt shared strings for names of Object.prototype members", async () => {
    const files = await workbook(readmeQuarter({ tasks: ["constructor", "__proto__", "toString", "valueOf"].map((name, index) => (
      { id: `t${index}`, name, directionId: "z-product", estimateHours: "1", mark: "plan" as const, link: null, comment: null }
    )) }));
    const count = sharedStrings(files).length;
    for (let sheet = 1; sheet <= 6; sheet += 1) {
      for (const match of sheetXml(files, sheet).matchAll(/<c [^>]*t="s"[^>]*><v>([^<]*)<\/v>/g)) {
        expect(match[1]).toMatch(/^\d+$/);
        expect(Number(match[1])).toBeLessThan(count);
      }
    }
    expect(sharedStrings(files)).toEqual(expect.arrayContaining(["<t>constructor​</t>", "<t>__proto__​</t>"]));
  });

  it("writes dates Excel cannot represent exactly as text", async () => {
    const files = await workbook(readmeQuarter({ absences: [
      { id: "a1", memberId: "z-member", startDate: "1900-01-01", endDate: "1900-02-28" },
      { id: "a2", memberId: "z-member", startDate: "1900-03-01", endDate: "1900-03-01" }
    ] }));
    const strings = sharedStrings(files);
    expect(strings).toEqual(expect.arrayContaining(["<t>01.01.1900</t>", "<t>28.02.1900</t>"]));
    // 1900-03-01 is the first date whose Excel serial (61) is exact.
    expect(sheetXml(files, 6)).toContain("<v>61</v>");
    expect(sheetXml(files, 6)).not.toMatch(/<v>(2|60)<\/v>/);
  });

  it("keeps every digit: values beyond Excel's 15 significant digits become the screen text", async () => {
    const files = await workbook(readmeQuarter({
      directions: [
        { id: "z-product", name: "Продукт", percent: "33.3333333333333333", kind: "work" as const, memberPercents: [] },
        { id: "a-meetings", name: "Встречи и прочее", percent: "66.6666666666666667", kind: "work" as const, memberPercents: [] }
      ],
      tasks: [{ id: "t1", name: "Огромная", directionId: "z-product", estimateHours: "12345678901234.56", mark: "plan" as const, link: null, comment: null }]
    }));
    const strings = sharedStrings(files);
    expect(strings).toEqual(expect.arrayContaining([
      "<t>12345678901234,56 ч</t>", "<t>33,3333333333333333</t>", "<t>66,6666666666666667</t>"
    ]));
    expect(sheetXml(files, 5)).not.toContain("12345678901234.56");
    // The shares add up to exactly 100%: nothing is shown as over or under.
    expect(strings).toEqual(expect.arrayContaining(["<t>100%</t>", "<t>0%</t>"]));
  });

  it("the written file holds the report of the quarter planner (B-1): read back from its bytes", async () => {
    const snapshot = readmeQuarter();
    const book = readWorkbook(await renderQuarterReportXlsx(buildQuarterReport({ teamName: "Команда А", snapshot, result: calculate(snapshot), exportedAt })));
    expect(Object.keys(book)).toEqual(["Сводка", "Люди", "Компетенции", "Источники", "Работы", "Отсутствия"]);
    // 252 h; «Продукт» 20% = 50,4 h, 30 + 25 = 55 h in the plan, 4,6 h over; «Встречи и прочее» 80% = 201,6 h free.
    const summary = new Map(book["Сводка"].slice(1).map((row) => [row[0], row[1]]));
    expect(Object.fromEntries([...summary].filter(([label]) => [
      "Доступно команде, ч", "Резерв, ч", "Занято работами в плане, ч", "Работ в плане", "Работ в плане без оценки", "Остатки квот, ч",
      "Перебор квот, ч", "Источников с перебором", "Выделено источникам, ч", "Выделено источникам, % ёмкости", "Не распределено, ч",
      "Не распределено, % ёмкости", "Предупреждение"
    ].includes(String(label))))).toEqual({
      "Доступно команде, ч": 252, "Резерв, ч": "Не задан", "Занято работами в плане, ч": 55, "Работ в плане": 2, "Работ в плане без оценки": 0,
      "Остатки квот, ч": 201.6, "Перебор квот, ч": 4.6, "Источников с перебором": 1, "Выделено источникам, ч": 252,
      "Выделено источникам, % ёмкости": "100%", "Не распределено, ч": 0, "Не распределено, % ёмкости": "0%",
      "Предупреждение": "Перебор квоты — «Продукт» 4,60 ч."
    });
    expect(book["Источники"]).toEqual([
      ["Источник", "Вид", "Доля, %", "Доля ёмкости фактически, %", "Бюджет, ч", "Занято в плане, ч", "В плане без оценки",
        "Остаток, ч", "Перебор, ч", "На рассмотрении", "Не в этом квартале", "Примечание"],
      ["Продукт", "Работы", 20, 20, 50.4, 55, 0, 0, 4.6, 0, 0, "Перебор 4,60 ч."],
      ["Встречи и прочее", "Работы", 80, 80, 201.6, 0, 0, 201.6, 0, 0, 0, "Остаток 201,60 ч."],
      ["Не распределено", null, null, "0%", 0, null, null, null, null, null, null, "Никому не выделено."]
    ]);
    expect(book["Работы"]).toEqual([
      ["Источник", "Работа", "Решение по плану", "Оценка, ч", "Занимает бюджет"],
      ["Продукт", "Задача 30", "В плане квартала", 30, "да"],
      ["Продукт", "Задача 25", "В плане квартала", 25, "да"]
    ]);
  });

  it("an overrun or an excess below a hundredth is written as «<0,01 ч», never as 0,00 (R-002)", async () => {
    const snapshot = readmeQuarter({
      directions: [
        { id: "z-product", name: "Продукт", percent: "20", kind: "work" as const, memberPercents: [] },
        { id: "a-meetings", name: "Встречи и прочее", percent: "80.0001", kind: "work" as const, memberPercents: [] }
      ],
      tasks: [{ id: "t1", name: "Почти весь бюджет", directionId: "z-product", estimateHours: "50.401", mark: "plan" as const, link: null, comment: null }]
    });
    const book = readWorkbook(await renderQuarterReportXlsx(buildQuarterReport({ teamName: "Команда А", snapshot, result: calculate(snapshot), exportedAt })));
    const summary = new Map(book["Сводка"].slice(1).map((row) => [row[0], row[1]]));
    // 252 × 80,0001% + 50,4 = 252,000252 h given; 50,401 − 50,4 = 0,001 h over «Продукт».
    expect([summary.get("Не распределено, ч"), summary.get("Выделено источникам, % ёмкости"), summary.get("Перебор квот, ч")])
      .toEqual(["−<0,01 ч", "100,0001%", "<0,01 ч"]);
    expect(book["Источники"][1].slice(8)).toEqual(["<0,01 ч", 0, 0, "Перебор <0,01 ч."]);
    expect(book["Источники"][3].slice(3, 5)).toEqual(["−0,0001%", "−<0,01 ч"]);
  });

  it("runs the worker-free zip shim in tests and in the production Vite config", async () => {
    expect((fflate as unknown as { WORKER_FREE_ZIP?: boolean }).WORKER_FREE_ZIP).toBe(true);
    const { default: viteConfig, fflateSyncZipAlias } = await import("../vite.config");
    const aliases = (viteConfig as { resolve?: { alias?: unknown } }).resolve?.alias;
    expect(aliases).toEqual(expect.arrayContaining([fflateSyncZipAlias]));
    expect(fflateSyncZipAlias.replacement.replace(/\\/g, "/")).toMatch(/\/src\/export\/fflate-sync-zip\.ts$/);
    expect(fflateSyncZipAlias.find.test("fflate")).toBe(true);
    expect(fflateSyncZipAlias.find.test("fflate/browser")).toBe(false);
  });

  it("compresses large sheets without Web Workers", async () => {
    const worker = vi.fn(() => { throw new Error("Worker запрещён CSP"); });
    vi.stubGlobal("Worker", worker);
    vi.mocked(fflate.zip).mockClear();
    const tasks = Array.from({ length: 3000 }, (_, index) => ({
      id: `t${index}`, name: `Задача с достаточно длинным названием номер ${index}`,
      directionId: "z-product", estimateHours: String(index % 40), mark: "plan" as const, link: null, comment: null
    }));
    const files = await workbook(readmeQuarter({ tasks }));
    expect(new TextEncoder().encode(sheetXml(files, 5)).length).toBeGreaterThanOrEqual(160_000);
    expect(fflate.zip).toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });
});
