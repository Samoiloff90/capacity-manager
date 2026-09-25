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
      .toEqual(["Сводка", "Люди", "Компетенции", "Направления", "Задачи", "Отсутствия"]);
    expect(sheetXml(files, 2)).toContain("<v>252</v>");
    expect(sheetXml(files, 4)).toContain("<v>50.4</v>");
    expect(sheetXml(files, 4)).toContain("<v>-4.6</v>");
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
      { id: "t1", name: "Без оценки", directionId: "z-product", estimateHours: null },
      { id: "t2", name: "Большая", directionId: "z-product", estimateHours: "100" }
    ] }));
    const styles = files["xl/styles.xml"];
    for (const colour of ["FFE8EEF5", "FFFDECEC", "FF9B1C1C", "FF8A5A00"]) expect(styles).toContain(colour);
    expect(styles).toContain('formatCode="#,##0.00"');
    expect(styles).toContain('formatCode="dd.mm.yyyy"');
    // Hours use the custom format; percent (B2 of «Направления») and rate (C2 of «Люди») stay General.
    expect(cellStyle(files, 4, "C2")).toMatch(/numFmtId="1\d\d"/);
    expect(cellStyle(files, 4, "B2")).not.toMatch(/numFmtId="[1-9]/);
    expect(cellStyle(files, 2, "C2")).not.toMatch(/numFmtId="[1-9]/);
  });

  it("keeps user text as text, never as a formula", async () => {
    const files = await workbook(readmeQuarter({ tasks: [
      { id: "t1", name: "<b>A & B</b> =1+1", directionId: "z-product", estimateHours: "1" },
      { id: "t2", name: "=HYPERLINK(\"x\")", directionId: "z-product", estimateHours: "1" }
    ] }));
    const strings = sharedStrings(files).join("\n");
    expect(strings).toContain("&lt;b&gt;A &amp; B&lt;/b&gt; =1+1");
    expect(strings).toContain('=HYPERLINK("x")');
    for (let sheet = 1; sheet <= 6; sheet += 1) expect(sheetXml(files, sheet)).not.toMatch(/<f[\s>]/);
  });

  it("does not corrupt shared strings for names of Object.prototype members", async () => {
    const files = await workbook(readmeQuarter({ tasks: ["constructor", "__proto__", "toString", "valueOf"].map((name, index) => (
      { id: `t${index}`, name, directionId: "z-product", estimateHours: "1" }
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

  it("compresses large sheets without Web Workers", async () => {
    const worker = vi.fn(() => { throw new Error("Worker запрещён CSP"); });
    vi.stubGlobal("Worker", worker);
    vi.mocked(fflate.zip).mockClear();
    const tasks = Array.from({ length: 3000 }, (_, index) => ({
      id: `t${index}`, name: `Задача с достаточно длинным названием номер ${index}`,
      directionId: "z-product", estimateHours: String(index % 40)
    }));
    const files = await workbook(readmeQuarter({ tasks }));
    expect(new TextEncoder().encode(sheetXml(files, 5)).length).toBeGreaterThanOrEqual(160_000);
    expect(fflate.zip).toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });
});
