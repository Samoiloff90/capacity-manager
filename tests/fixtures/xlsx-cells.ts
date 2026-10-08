import { unzipSync } from "fflate";

/**
 * Reads a written workbook back from its bytes — the zip and the sheet XML — not from the report
 * model, so a test sees what Excel would open. Text cells come back as text (shared strings),
 * number cells as numbers, empty cells as null. Artificial data only.
 */
export type WorkbookCell = string | number | null;

const decoder = new TextDecoder();
const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of /^[A-Z]+/.exec(reference)![0]) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

export function readWorkbook(bytes: Uint8Array): Record<string, WorkbookCell[][]> {
  const files = Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, content]) => [name, decoder.decode(content)]));
  const strings = [...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((match) => unescape(match[1].replace(/<[^>]+>/g, "")));
  const names = [...files["xl/workbook.xml"].matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => unescape(match[1]));
  return Object.fromEntries(names.map((name, index) => {
    const xml = files[`xl/worksheets/sheet${index + 1}.xml`];
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells: WorkbookCell[] = [];
      for (const cell of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const [, reference, attributes, content = ""] = cell;
        const raw = /<v>([\s\S]*?)<\/v>/.exec(content)?.[1];
        const position = columnIndex(reference);
        while (cells.length < position) cells.push(null);
        cells[position] = raw === undefined ? null : /\bt="s"/.test(attributes) ? strings[Number(raw)] : Number(raw);
      }
      return cells;
    });
    return [name, rows];
  }));
}
