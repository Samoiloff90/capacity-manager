import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as fflate from "fflate";
import writeXlsxFile, { type Row } from "write-excel-file/universal";
import { IMPORT_TEMPLATE_HEADER, IMPORT_TEMPLATE_NOTES, IMPORT_TEMPLATE_ROWS, importTemplateNotes } from "./fixtures/import-template";

/**
 * The small template with made-up works the PO tries the import with (DEC-050): open it in
 * Excel, select the rows of the first sheet with the header, copy and paste them into
 * «Вставить из таблицы». The demo archive gets it from CI (CAPACITY_TEMPLATE_OUT).
 */
async function renderTemplate(): Promise<Uint8Array> {
  const bold = { fontWeight: "bold" as const, backgroundColor: "#E8EEF5" };
  // Hours are numbers in Excel, as in a real list: 12,5 and 1 200 are shown in the user's format.
  const cell = (value: string, column: number) => {
    if (!value) return null;
    if (column === 1 && /^[\d\s,]+$/.test(value)) {
      const number = Number(value.replace(/\s/g, "").replace(",", "."));
      // Thousands are grouped by Excel in the user's format: «1 200» in Russian.
      return number >= 1000 ? { type: Number, value: number, format: "#,##0" } : { type: Number, value: number };
    }
    return { type: String, value, wrap: value.includes("\n") };
  };
  const works: Row[] = [IMPORT_TEMPLATE_HEADER.map((value) => ({ type: String, value, ...bold })),
    ...IMPORT_TEMPLATE_ROWS.map((row) => row.cells.map(cell))];
  const notes: Row[] = [IMPORT_TEMPLATE_NOTES.map((value) => ({ type: String, value, ...bold })),
    ...importTemplateNotes().map((row) => row.map((value) => ({ type: String, value })))];
  const blob = await writeXlsxFile([
    { sheet: "Работы", data: works, columns: [{ width: 34 }, { width: 11 }, { width: 44 }, { width: 38 }, { width: 24 }] },
    { sheet: "Что проверяет", data: notes, columns: [{ width: 8 }, { width: 52 }, { width: 44 }] }
  ]).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

describe("import template with made-up works (DEC-050)", () => {
  it("holds the works of the first sheet and what each row checks on the second", async () => {
    const files = fflate.unzipSync(await renderTemplate());
    const text = (name: string) => new TextDecoder().decode(files[name]);
    expect(text("xl/workbook.xml")).toMatch(/name="Работы".*name="Что проверяет"/s);
    const strings = text("xl/sharedStrings.xml");
    for (const row of IMPORT_TEMPLATE_ROWS) if (row.cells[0]) expect(strings).toContain(row.cells[0]);
    // Made-up data only: no e-mail addresses, links only to example.com.
    expect(strings).not.toContain("@");
    for (const link of strings.match(/<t>https?:\/\/[^<]+/g) ?? []) expect(link).toMatch(/^<t>https:\/\/kaiten\.example\.com\//);
    // 28, 12,5, 0 and 1 200 are numbers; M and «2-3 дня» stay text.
    const sheet = text("xl/worksheets/sheet1.xml");
    expect(sheet).toMatch(/<c r="B2"[^>]*><v>28<\/v>/);
    expect(sheet).toMatch(/<c r="B3"[^>]*><v>12\.5<\/v>/);
    expect(sheet).toMatch(/<c r="B14"[^>]*><v>1200<\/v>/);
    expect(sheet).not.toMatch(/<c r="B7"/);
  });

  it.runIf(Boolean(process.env.CAPACITY_TEMPLATE_OUT))("writes the template for the demo archive", async () => {
    await writeFile(process.env.CAPACITY_TEMPLATE_OUT!, await renderTemplate());
  });
});
