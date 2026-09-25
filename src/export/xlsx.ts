import writeXlsxFile, { type Cell, type CellObject, type Row, type Sheet } from "write-excel-file/universal";
import { formatHours, roundDecimal } from "../domain/capacity/input-format";
import type { QuarterReport, ReportCell, ReportRow, ReportSheet } from "./quarter-report";

type CellStyle = Pick<CellObject, "fontWeight" | "backgroundColor" | "textColor">;

const HEADER_STYLE: CellStyle = { fontWeight: "bold", backgroundColor: "#E8EEF5" };
const TONE_STYLE: Record<NonNullable<ReportRow["tone"]>, CellStyle> = {
  deficit: { backgroundColor: "#FDECEC", textColor: "#9B1C1C" },
  preliminary: { textColor: "#8A5A00" }
};
const HOURS_FORMAT = "#,##0.00";
const DATE_FORMAT = "dd.mm.yyyy";
// Beyond this a double no longer keeps two exact decimal places in Excel.
const MAX_EXACT_NUMBER = 1e15;
const ZERO_WIDTH_SPACE = "​";

/** Renders the format-neutral report; percent and rate stay "General", as on screen (DEC-024). */
export async function renderQuarterReportXlsx(report: QuarterReport): Promise<Uint8Array> {
  const blob = await writeXlsxFile(report.sheets.map(toSheet)).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

function toSheet(sheet: ReportSheet): Sheet<Blob> {
  const header: Row = sheet.columns.map((column) => ({ ...HEADER_STYLE, type: String, value: safeText(column.title) }));
  return {
    sheet: sheet.name,
    columns: sheet.columns.map((column) => ({ width: column.width })),
    stickyRowsCount: 1,
    data: [header, ...sheet.rows.map(toRow)]
  };
}

function toRow(row: ReportRow): Row {
  const style: CellStyle = {
    ...(row.tone ? TONE_STYLE[row.tone] : {}),
    ...(row.emphasis === "total" ? { fontWeight: "bold" } : {})
  };
  return row.cells.map((cell) => toCell(cell, style));
}

function toCell(cell: ReportCell, style: CellStyle): Cell {
  switch (cell.kind) {
    case "text":
      return { ...style, type: String, value: safeText(cell.value) };
    case "hours":
      // Same half-away-from-zero rounding as the screen, so -0.001 shows as 0,00 there and here.
      return decimalCell(roundDecimal(cell.value, 2), HOURS_FORMAT, () => formatHours(cell.value), style);
    case "percent":
    case "rate":
      return decimalCell(cell.value, undefined, () => cell.value.replace(".", ","), style);
    case "count":
      if (!Number.isInteger(cell.value)) throw new Error("Некорректное количество в отчёте.");
      return { ...style, type: Number, value: cell.value };
    case "date":
      return dateCell(cell.value, style);
    case "empty":
      // No value: an empty cell that still carries the row background.
      return Object.keys(style).length ? { ...style } : null;
  }
}

function decimalCell(value: string, format: string | undefined, fallback: () => string, style: CellStyle): Cell {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) >= MAX_EXACT_NUMBER) {
    return { ...style, type: String, value: fallback() };
  }
  return format ? { ...style, type: Number, value: number, format } : { ...style, type: Number, value: number };
}

function dateCell(value: string, style: CellStyle): Cell {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Некорректная дата в отчёте.");
  const [, year, month, day] = match;
  // Excel has no dates before 1900; keep such a date readable as text.
  if (Number(year) < 1900) return { ...style, type: String, value: `${day}.${month}.${year}` };
  // write-excel-file converts with getTime(): midnight UTC keeps the calendar date in any time zone.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (!Number.isFinite(date.getTime())) throw new Error("Некорректная дата в отчёте.");
  return { ...style, type: Date, value: date, format: DATE_FORMAT };
}

/**
 * write-excel-file 4.1.1 indexes shared strings in a plain object, so a text equal to an
 * Object.prototype member ("constructor", "__proto__", …) would corrupt the workbook.
 * An invisible zero-width space keeps the visible text unchanged.
 */
function safeText(value: string): string {
  return Object.prototype.hasOwnProperty.call(Object.prototype, value) ? value + ZERO_WIDTH_SPACE : value;
}
