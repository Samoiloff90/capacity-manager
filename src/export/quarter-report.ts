import { describeDirectionBalance } from "../domain/capacity/direction-balance";
import { describeQuarterPlanStatus } from "../domain/capacity/plan-status";
import { getCalendarOverrides } from "../domain/capacity/project-calendar";
import type { CalendarSource, QuarterCapacityResult, QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";

/** Format-neutral cells. Numbers stay canonical engine decimals; dates stay YYYY-MM-DD. */
export type ReportCell =
  | { kind: "text"; value: string }
  | { kind: "hours"; value: string }
  | { kind: "percent"; value: string }
  | { kind: "rate"; value: string }
  | { kind: "count"; value: number }
  | { kind: "date"; value: string }
  | { kind: "empty" };
export type ReportTone = "deficit" | "preliminary";
export type ReportRow = { cells: ReportCell[]; tone?: ReportTone; emphasis?: "total" };
export type ReportColumn = { title: string; width: number };
export type ReportSheet = { name: string; columns: ReportColumn[]; rows: ReportRow[] };
export type QuarterReport = { fileBaseName: string; sheets: ReportSheet[] };
export type QuarterReportInput = {
  teamName: string;
  snapshot: QuarterSnapshot;
  result: QuarterCapacityResult;
  exportedAt: Date;
};

export const ROUNDING_NOTE = "Часы показаны с точностью до 0,01; итоги рассчитаны по точным значениям, "
  + "поэтому сумма округлённых строк может отличаться от итога.";
const MAX_TEAM_NAME_UNITS = 100;
// Windows and macOS forbidden file-name characters plus C0/C1 control characters.
const FORBIDDEN_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g;

const text = (value: string): ReportCell => ({ kind: "text", value });
const hours = (value: string): ReportCell => ({ kind: "hours", value });
const percent = (value: string): ReportCell => ({ kind: "percent", value });
const rate = (value: string): ReportCell => ({ kind: "rate", value });
const count = (value: number): ReportCell => ({ kind: "count", value });
const date = (value: string): ReportCell => ({ kind: "date", value });
const empty: ReportCell = { kind: "empty" };
const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * Presentation of an already calculated quarter. Nothing is recalculated here:
 * totals come from the engine and statuses from the same helpers as the screen.
 * Rows follow the snapshot order, which is the order shown in the interface.
 */
export function buildQuarterReport({ teamName, snapshot, result, exportedAt }: QuarterReportInput): QuarterReport {
  if (result.year !== snapshot.year || result.quarter !== snapshot.quarter) {
    throw new Error("Расчёт относится к другому кварталу.");
  }
  if (!Number.isFinite(exportedAt.getTime())) throw new Error("Некорректная дата выгрузки.");
  const members = rowsById(snapshot.members, result.members, (row) => row.memberId);
  const competencies = rowsById(snapshot.competencies, result.competencies, (row) => row.competencyId);
  const directions = rowsById(snapshot.directions, result.directions, (row) => row.directionId);
  const competencyNames = new Map(snapshot.competencies.map((item) => [item.id, item.name]));
  const directionNames = new Map(snapshot.directions.map((item) => [item.id, item.name]));
  const memberNames = new Map(snapshot.members.map((item) => [item.id, item.name]));
  const status = describeQuarterPlanStatus(result);
  const overrides = getCalendarOverrides(snapshot);
  const { totals, allocation } = result;

  const summary: ReportRow[] = [
    { cells: [text("Команда"), text(teamName)] },
    { cells: [text("Период"), text(`${snapshot.quarter} квартал ${snapshot.year} года`)] },
    { cells: [text("Дата выгрузки"), text(formatTimestamp(exportedAt))] },
    { cells: [text("Статус плана"), text(status.ready ? "Готовый" : "Предварительный")],
      tone: status.ready ? undefined : "preliminary" },
    ...(status.ready ? [] : [{ cells: [text("Причины"), text(status.reasons.join(" "))], tone: "preliminary" as const }]),
    { cells: [text("Календарь"), text(calendarLabel(snapshot.calendarSource))] },
    { cells: [text("Ручных поправок календаря"), overrides ? count(overrides.length) : text("Не выделены")] },
    { cells: [text("Рабочих дней"), count(totals.workingDays)] },
    { cells: [text("Сотрудников"), count(totals.memberCount)] },
    { cells: [text("Доступно часов команды"), hours(totals.availableHours)] },
    { cells: [text("Сумма долей, %"), percent(allocation.totalPercent)],
      tone: allocation.status === "complete" ? undefined : "preliminary" },
    { cells: [text(totals.demandComplete ? "Потребность задач, ч" : "Известная потребность задач, ч"),
      hours(totals.knownDemandHours)], tone: totals.demandComplete ? undefined : "preliminary" },
    { cells: [text("Задач без оценки"), count(totals.missingEstimateCount)] },
    { cells: [text("Примечание"), text(ROUNDING_NOTE)] }
  ];

  const people: ReportRow[] = snapshot.members.map((member) => {
    const row = members.get(member.id)!;
    return { cells: [
      text(member.name), text(competencyNames.get(member.competencyId) ?? ""), rate(member.fte),
      count(row.workingDays), count(row.absenceWorkingDays), count(row.availableDays), hours(row.availableHours)
    ] };
  });
  // Only engine totals: sums the engine does not provide are not derived here.
  people.push({ emphasis: "total", cells: [
    text("Итого"), empty, empty, empty, empty, count(totals.availableDays), hours(totals.availableHours)
  ] });

  const competencyRows: ReportRow[] = snapshot.competencies.map((competency) => {
    const row = competencies.get(competency.id)!;
    return { cells: [text(competency.name), count(row.memberCount), hours(row.availableHours)] };
  });

  const directionRows: ReportRow[] = snapshot.directions.map((direction) => {
    const row = directions.get(direction.id)!;
    const balance = describeDirectionBalance(row);
    return {
      tone: balance.deficit ? "deficit" : balance.status === "preliminary" ? "preliminary" : undefined,
      cells: [
        text(direction.name), percent(row.percent), hours(row.budgetHours), hours(row.knownDemandHours),
        count(row.missingEstimateCount), hours(row.remainingKnownHours),
        text(`${balance.balanceLabel} ${balance.balanceText}`), balance.note ? text(balance.note) : empty
      ]
    };
  });

  const taskRows: ReportRow[] = snapshot.tasks.map((task) => ({
    tone: task.estimateHours === null ? "preliminary" : undefined,
    cells: [
      text(task.name), text(directionNames.get(task.directionId) ?? ""),
      task.estimateHours === null ? text("Не оценена") : hours(task.estimateHours)
    ]
  }));

  const absenceRows: ReportRow[] = snapshot.absences.map((absence) => ({
    cells: [text(memberNames.get(absence.memberId) ?? ""), date(absence.startDate), date(absence.endDate)]
  }));

  return {
    fileBaseName: reportFileBaseName(teamName, snapshot.year, snapshot.quarter),
    sheets: [
      { name: "Сводка", columns: [col("Показатель", 34), col("Значение", 70)], rows: summary },
      { name: "Люди", columns: [
        col("Сотрудник", 32), col("Компетенция", 20), col("Ставка", 9), col("Рабочих дней", 14),
        col("Дней отсутствия", 16), col("Доступно дней", 15), col("Доступно часов", 16)
      ], rows: people },
      { name: "Компетенции", columns: [col("Компетенция", 28), col("Сотрудников", 14), col("Доступно часов", 16)],
        rows: competencyRows },
      { name: "Направления", columns: [
        col("Направление", 28), col("Доля, %", 9), col("Бюджет, ч", 12), col("Потребность, ч", 15),
        col("Задач без оценки", 17), col("Остаток, ч", 12), col("Статус", 28), col("Примечание", 60)
      ], rows: directionRows },
      { name: "Задачи", columns: [col("Задача", 50), col("Направление", 28), col("Оценка, ч", 12)], rows: taskRows },
      { name: "Отсутствия", columns: [col("Сотрудник", 32), col("С", 12), col("По", 12)], rows: absenceRows }
    ]
  };
}

/** "Capacity {team} {year} Q{quarter}" without characters forbidden on Windows or macOS. */
export function reportFileBaseName(teamName: string, year: number, quarter: number): string {
  const cleaned = teamName.replace(FORBIDDEN_FILE_NAME_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  let team = "";
  // Count UTF-16 units (the native command's limit) and never split a surrogate pair.
  for (const character of cleaned) {
    if (team.length + character.length > MAX_TEAM_NAME_UNITS) break;
    team += character;
  }
  team = team.replace(/[.\s]+$/, "");
  return team ? `Capacity ${team} ${year} Q${quarter}` : `Capacity ${year} Q${quarter}`;
}

/** dd.mm.yyyy hh:mm in the local time of the computer; no Intl, whose separators vary. */
export function formatTimestamp(value: Date): string {
  return `${pad(value.getDate())}.${pad(value.getMonth() + 1)}.${pad(value.getFullYear(), 4)} `
    + `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function calendarLabel(source: CalendarSource | undefined): string {
  if (source?.kind === "ru-official") return "Производственный календарь РФ";
  if (source?.kind === "manual") return "Ручной: основа — пятидневка без праздников и переносов";
  return "Источник не указан";
}

function col(title: string, width: number): ReportColumn {
  return { title, width };
}

function rowsById<S extends { id: string }, R>(
  snapshotRows: readonly S[], resultRows: readonly R[], idOf: (row: R) => string
): Map<string, R> {
  const byId = new Map(resultRows.map((row) => [idOf(row), row]));
  if (byId.size !== snapshotRows.length || snapshotRows.some((row) => !byId.has(row.id))) {
    throw new Error("Расчёт не соответствует сохранённому кварталу.");
  }
  return byId;
}
