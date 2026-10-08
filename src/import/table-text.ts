/**
 * Rows copied from a spreadsheet (QUARTER_PLANNING_UX.md, «Вставка строк из таблицы»).
 * Excel, Google Sheets and Numbers put tab-separated text on the clipboard: cells by tabs,
 * rows by line breaks, and a cell with a tab, a line break or a quote inside is quoted with
 * the inner quotes doubled. Text that only looks quoted, such as «"Срочно"», is kept as typed.
 */

/** Parses clipboard text into rows of cells; the line break after the last row adds no row. */
export function parseTableText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let cellStart = true;
  let index = 0;
  const endOfCell = (at: number) => at >= text.length || text[at] === "\t" || text[at] === "\n" || text[at] === "\r";

  while (index < text.length) {
    const char = text[index];
    if (cellStart && char === "\"") {
      const quoted = readQuoted(text, index);
      // Excel quotes only a cell with a tab, a line break or a quote inside; «"Срочно"» was typed so.
      if (quoted && endOfCell(quoted.end) && /[\t\r\n"]/.test(quoted.value)) {
        cell = quoted.value;
        index = quoted.end;
        cellStart = false;
        continue;
      }
    }
    if (char === "\t") {
      row.push(cell);
      cell = "";
      cellStart = true;
      index += 1;
    } else if (char === "\n" || char === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStart = true;
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
    } else {
      cell += char;
      cellStart = false;
      index += 1;
    }
  }
  if (!cellStart || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A quoted cell from `start` (the opening quote): its value and the index after the closing quote. */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") {
      if (text[index + 1] === "\"") {
        value += "\"";
        index += 2;
        continue;
      }
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return null;
}

/** The reverse, for «Скопировать пропущенные»: pastes back into a spreadsheet cell by cell. */
export function toTableText(rows: readonly (readonly string[])[]): string {
  const quote = (cell: string) => /[\t\r\n"]/.test(cell) ? `"${cell.replace(/"/g, "\"\"")}"` : cell;
  return rows.map((row) => row.map(quote).join("\t")).join("\n");
}
