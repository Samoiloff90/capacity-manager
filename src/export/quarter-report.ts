import { formatHours } from "../domain/capacity/input-format";
import { getCalendarOverrides } from "../domain/capacity/project-calendar";
import type {
  CalendarSource, QuarterCapacityResult, QuarterDirectionCapacity, QuarterSnapshot, TaskMark
} from "../domain/capacity/quarter-capacity.types";
import { pluralRu } from "../domain/capacity/quarter-totals";
import { describeAllocation, describeRest, describeSaveProblems, effectivePercent, formatPercent, sourceState } from "../domain/capacity/source-plan";

/** Format-neutral cells. Numbers stay canonical engine decimals; dates stay YYYY-MM-DD. */
export type ReportCell =
  | { kind: "text"; value: string }
  /** keepNonzero: an overrun or an excess, never written as 0,00 (R-002). */
  | { kind: "hours"; value: string; keepNonzero?: true }
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
/** The report is built from the saved quarter only (ProjectWorkspaceController.reportAvailability). */
export const SAVED_STATE_NOTE = "Сохранённый квартал. Отчёт выгружается, только когда в квартале нет несохранённых изменений, "
  + "поэтому числа те же, что на экране.";
export const MARK_LABELS: Readonly<Record<TaskMark, string>> = {
  plan: "В плане квартала", candidate: "На рассмотрении", out: "Не в этом квартале"
};
const MAX_TEAM_NAME_UNITS = 100;
// Windows and macOS forbidden file-name characters plus C0/C1 control characters.
const FORBIDDEN_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g;

const text = (value: string): ReportCell => ({ kind: "text", value });
const hours = (value: string): ReportCell => ({ kind: "hours", value });
const excess = (value: string): ReportCell => ({ kind: "hours", value, keepNonzero: true });
const percent = (value: string): ReportCell => ({ kind: "percent", value });
const rate = (value: string): ReportCell => ({ kind: "rate", value });
const count = (value: number): ReportCell => ({ kind: "count", value });
const date = (value: string): ReportCell => ({ kind: "date", value });
const empty: ReportCell = { kind: "empty" };
const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const works = (value: number) => `${value} ${pluralRu(value, "работа", "работы", "работ")}`;
const people = (value: number) => `${value} ${pluralRu(value, "сотрудника", "сотрудников", "сотрудников")}`;
const MARK_ORDER: readonly TaskMark[] = ["plan", "candidate", "out"];

/**
 * Presentation of an already calculated quarter by the rules of the quarter planner
 * (DEC-030–DEC-043, DEC-053). Nothing is recalculated here: totals come from the engine
 * and texts from the same helpers as the screen. Rows follow the snapshot order, which is
 * the order shown in the interface.
 */
export function buildQuarterReport({ teamName, snapshot, result, exportedAt }: QuarterReportInput): QuarterReport {
  if (result.year !== snapshot.year || result.quarter !== snapshot.quarter) {
    throw new Error("Расчёт относится к другому кварталу.");
  }
  if (!Number.isFinite(exportedAt.getTime())) throw new Error("Некорректная дата выгрузки.");
  const members = rowsById(snapshot.members, result.members, (row) => row.memberId);
  const competencies = rowsById(snapshot.competencies, result.competencies, (row) => row.competencyId);
  const sources = rowsById(snapshot.directions, result.directions, (row) => row.directionId);
  const competencyNames = new Map(snapshot.competencies.map((item) => [item.id, item.name]));
  const sourceNames = new Map(snapshot.directions.map((item) => [item.id, item.name]));
  const memberNames = new Map(snapshot.members.map((item) => [item.id, item.name]));
  const overrides = getCalendarOverrides(snapshot);
  const { totals, plan } = result;
  const allocation = describeAllocation(result);
  const reserves = snapshot.directions.filter((item) => item.kind === "reserve").map((item) => sources.get(item.id)!);
  const missing = plan.plannedMissingEstimateCount > 0;

  const summary: ReportRow[] = [
    { cells: [text("Команда"), text(teamName)] },
    { cells: [text("Период"), text(`${snapshot.quarter} квартал ${snapshot.year} года`)] },
    { cells: [text("Дата выгрузки"), text(formatTimestamp(exportedAt))] },
    { cells: [text("Состояние квартала"), text(SAVED_STATE_NOTE)] },
    { cells: [text("Календарь"), text(calendarLabel(snapshot.calendarSource))] },
    { cells: [text("Ручных поправок календаря"), overrides ? count(overrides.length) : text("Не выделены")] },
    { cells: [text("Рабочих дней"), count(totals.workingDays)] },
    { cells: [text("Сотрудников"), count(totals.memberCount)] },
    { cells: [text("Доступно команде, ч"), hours(totals.availableHours)] },
    { cells: [text("Резерв, ч"), plan.reserveCount ? hours(plan.reserveHours) : text("Не задан")] },
    ...reserves.map((reserve) => ({ cells: [text(`Как считается резерв «${reserve.name}»`), text(describeReserveRule(reserve))] })),
    { cells: [text(missing ? "Занято работами в плане, не менее, ч" : "Занято работами в плане, ч"), hours(plan.plannedKnownHours)],
      tone: missing ? "preliminary" as const : undefined },
    { cells: [text("Работ в плане"), count(plan.planCount)] },
    { cells: [text("Работ в плане без оценки"), count(plan.plannedMissingEstimateCount)], tone: missing ? "preliminary" as const : undefined },
    { cells: [text(missing && plan.remainingHours !== "0" ? "Остатки квот, не более, ч" : "Остатки квот, ч"), hours(plan.remainingHours)],
      tone: missing ? "preliminary" as const : undefined },
    { cells: [text("Перебор квот, ч"), excess(plan.overrunHours)], tone: plan.overrunHours !== "0" ? "deficit" as const : undefined },
    { cells: [text("Источников с перебором"), count(plan.overrunSourceCount)], tone: plan.overrunSourceCount ? "deficit" as const : undefined },
    { cells: [text("Выделено источникам, ч"), hours(plan.allocatedHours)] },
    { cells: [text("Выделено источникам, % ёмкости"), text(allocation.allocatedPercentText)],
      tone: allocation.overallocated ? "deficit" as const : undefined },
    { cells: [text("Не распределено, ч"), excess(plan.unallocatedHours)], tone: allocation.overallocated ? "deficit" as const : undefined },
    { cells: [text("Не распределено, % ёмкости"), text(allocation.unallocatedPercentText)],
      tone: allocation.overallocated ? "deficit" as const : undefined },
    { cells: [text("Источников без доли"), count(plan.unsetQuotaCount)] },
    ...describeWarnings(result).map((warning) => ({ cells: [text("Предупреждение"), text(warning.text)], tone: warning.tone })),
    { cells: [text("Примечание"), text(ROUNDING_NOTE)] }
  ];

  // Reserve by person (DEC-038): each reserve gets its share, whose share it is and the hours.
  const people: ReportRow[] = snapshot.members.map((member) => {
    const row = members.get(member.id)!;
    return { cells: [
      text(member.name), text(competencyNames.get(member.competencyId) ?? ""), rate(member.fte),
      count(row.workingDays), count(row.absenceWorkingDays), count(row.availableDays), hours(row.availableHours),
      ...reserves.flatMap((reserve) => {
        const person = reserve.reserveMembers.find((item) => item.memberId === member.id);
        if (!person) return [empty, empty, empty];
        return [person.percent === null ? text("не задана") : percent(person.percent),
          text(person.own ? "своя" : "общая"), person.reserveHours === null ? empty : hours(person.reserveHours)];
      })
    ] };
  });
  // Only engine totals: sums the engine does not provide are not derived here.
  people.push({ emphasis: "total", cells: [
    text("Итого"), empty, empty, empty, empty, count(totals.availableDays), hours(totals.availableHours),
    ...reserves.flatMap((reserve) => [empty, empty, reserve.quotaSet ? hours(reserve.budgetHours) : empty])
  ] });

  const competencyRows: ReportRow[] = snapshot.competencies.map((competency) => {
    const row = competencies.get(competency.id)!;
    return { cells: [text(competency.name), count(row.memberCount), hours(row.availableHours)] };
  });

  const sourceRows: ReportRow[] = snapshot.directions.map((direction) => {
    const row = sources.get(direction.id)!;
    const share = row.quotaSet && row.percent !== null ? percent(row.percent) : text("не задана");
    const actual = effectivePercent(row, totals.availableHours);
    const actualCell = actual === null ? empty : percent(actual);
    if (row.kind === "reserve") {
      return { cells: [
        text(direction.name), text("Резерв"), share, actualCell, row.quotaSet ? hours(row.budgetHours) : empty,
        empty, empty, empty, empty, empty, empty, text(describeReserveRule(row))
      ] };
    }
    const state = sourceState(row);
    const over = row.quotaSet && row.overrunKnownHours !== "0";
    const note = !row.quotaSet
      ? (row.planCount ? "Доля не задана: работы в плане не сравниваются с бюджетом." : "Доля не задана.")
      : `${capitalize(describeRest(state, formatHours))}.${row.missingEstimateCount ? ` В плане без оценки: ${works(row.missingEstimateCount)}.` : ""}`;
    return {
      tone: over ? "deficit" : row.missingEstimateCount || (!row.quotaSet && row.planCount) ? "preliminary" : undefined,
      cells: [
        text(direction.name), text("Работы"), share, actualCell, row.quotaSet ? hours(row.budgetHours) : empty,
        hours(row.knownDemandHours), count(row.missingEstimateCount),
        row.quotaSet ? hours(state.remainingHours) : empty, row.quotaSet ? excess(row.overrunKnownHours) : empty,
        count(row.candidateCount), count(row.outCount), text(note)
      ]
    };
  });
  sourceRows.push({
    tone: allocation.overallocated ? "deficit" : undefined,
    cells: [
      text("Не распределено"), empty, empty, text(allocation.unallocatedPercentText), excess(plan.unallocatedHours),
      empty, empty, empty, empty, empty, empty,
      text(allocation.overallocated ? "Сумма долей больше 100%: источникам выделено больше доступной ёмкости." : "Никому не выделено.")
    ]
  });

  // Every work with its decision; only works in the plan take the budget (DEC-032).
  const workRows: ReportRow[] = snapshot.directions.flatMap((direction) => MARK_ORDER.flatMap((mark) =>
    snapshot.tasks.filter((task) => task.directionId === direction.id && task.mark === mark).map((task) => ({
      tone: mark === "plan" && task.estimateHours === null ? "preliminary" as const : undefined,
      cells: [
        text(sourceNames.get(task.directionId) ?? ""), text(task.name), text(MARK_LABELS[mark]),
        task.estimateHours === null ? text("Без оценки") : hours(task.estimateHours),
        text(mark !== "plan" ? "нет" : !sources.get(task.directionId)!.quotaSet ? "да, доля источника не задана"
          : task.estimateHours === null ? "да, оценка неизвестна" : "да")
      ]
    }))));

  const absenceRows: ReportRow[] = snapshot.absences.map((absence) => ({
    cells: [text(memberNames.get(absence.memberId) ?? ""), date(absence.startDate), date(absence.endDate)]
  }));

  return {
    fileBaseName: reportFileBaseName(teamName, snapshot.year, snapshot.quarter),
    sheets: [
      { name: "Сводка", columns: [col("Показатель", 38), col("Значение", 90)], rows: summary },
      { name: "Люди", columns: [
        col("Сотрудник", 32), col("Компетенция", 20), col("Ставка", 9), col("Рабочих дней", 14),
        col("Дней отсутствия", 16), col("Доступно дней", 15), col("Доступно часов", 16),
        ...reserves.flatMap((reserve) => [
          col(`«${reserve.name}»: доля, %`, 18), col(`«${reserve.name}»: чья доля`, 18), col(`«${reserve.name}»: резерв, ч`, 18)
        ])
      ], rows: people },
      { name: "Компетенции", columns: [col("Компетенция", 28), col("Сотрудников", 14), col("Доступно часов", 16)],
        rows: competencyRows },
      { name: "Источники", columns: [
        col("Источник", 30), col("Вид", 10), col("Доля, %", 10), col("Доля ёмкости фактически, %", 16), col("Бюджет, ч", 12),
        col("Занято в плане, ч", 15), col("В плане без оценки", 12), col("Остаток, ч", 12), col("Перебор, ч", 12),
        col("На рассмотрении", 14), col("Не в этом квартале", 14), col("Примечание", 70)
      ], rows: sourceRows },
      { name: "Работы", columns: [
        col("Источник", 30), col("Работа", 50), col("Решение по плану", 20), col("Оценка, ч", 12), col("Занимает бюджет", 22)
      ], rows: workRows },
      { name: "Отсутствия", columns: [col("Сотрудник", 32), col("С", 12), col("По", 12)], rows: absenceRows }
    ]
  };
}

/** «15% доступных часов каждого сотрудника; своя доля — у 1 сотрудника (лист «Люди»)». */
export function describeReserveRule(reserve: QuarterDirectionCapacity): string {
  const common = reserve.percent === null ? "общая доля не задана" : `${formatPercent(reserve.percent)} доступных часов каждого сотрудника`;
  const own = reserve.ownPercentCount ? `; своя доля — у ${people(reserve.ownPercentCount)}` : "";
  return `Резерв без работ: ${common}${own}. По людям — лист «Люди».`;
}

/**
 * The warnings of the screen by the current rules: an excess of shares and overruns (as on
 * save), works in the plan without an estimate, works in the plan of a source without a share.
 * A sum of shares under 100% is not a warning: the rest is «Не распределено».
 */
export function describeWarnings(result: QuarterCapacityResult): { text: string; tone: ReportTone }[] {
  const warnings: { text: string; tone: ReportTone }[] = describeSaveProblems(result, formatHours)
    .map((problem) => ({ text: `${capitalize(problem)}.`, tone: "deficit" }));
  const missing = result.plan.plannedMissingEstimateCount;
  if (missing) {
    warnings.push({ text: `В плане ${works(missing)} без оценки: занятость — не менее указанной, остатки квот — не более.`, tone: "preliminary" });
  }
  const unset = result.directions.filter((row) => row.kind === "work" && !row.quotaSet && row.planCount > 0);
  if (unset.length) {
    warnings.push({ text: `Доля не задана: ${unset.map((row) => `«${row.name}»`).join(", ")} — работы в плане не сравниваются с бюджетом.`, tone: "preliminary" });
  }
  return warnings;
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
