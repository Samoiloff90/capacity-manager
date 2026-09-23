import { getQuarterDates, Quarter } from "./calendar-quarter";
import type { CalendarSource, QuarterSnapshot } from "./quarter-capacity.types";

export type CalendarMode = CalendarSource["kind"];
export type QuarterCalendar = Pick<QuarterSnapshot, "calendar"> & { calendarSource: CalendarSource };
export type CreateQuarterCalendarResult =
  | ({ ok: true } & QuarterCalendar)
  | { ok: false; reason: "needs-manual"; message: string };

export const BUNDLED_CALENDAR_YEARS = [2026] as const;
export const RU_2026_CALENDAR_VERSION = "ru-2026-tk112-pp1466-2025-09-24-v1";
export const MANUAL_CALENDAR_VERSION = "manual-weekdays-v1";

/** Attribution only. The application never fetches these sources at runtime. */
export const RU_2026_CALENDAR_SOURCES = [
  {
    title: "ТК РФ, статья 112 — текст на сайте Минтруда России",
    url: "https://mintrud.gov.ru/labour/relationship/351"
  },
  {
    title: "Постановление Правительства РФ от 24.09.2025 № 1466",
    url: "https://government.ru/docs/all/161028/"
  }
] as const;

// Federal non-working dates only, for the five-day week in 2026.
// Jan 9 and Dec 31: PP 1466; Mar 9 and May 11: TK 112 weekend overlap.
// Jan 3/4 remain non-working holidays; the transfer does not make them workdays.
const RU_2026_NON_WORKING = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
  "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
  "2026-02-23", "2026-03-08", "2026-03-09",
  "2026-05-01", "2026-05-09", "2026-05-11", "2026-06-12",
  "2026-11-04", "2026-12-31"
]);

/**
 * Call only when creating a new plan, never to refresh an opened snapshot.
 * The caller must explicitly offer/confirm manual mode: it is only a Mon–Fri
 * template, not a verified Russian calendar. All working dates count as eight
 * hours before FTE under the MVP; shortened holiday-eve hours are not modelled.
 */
export function createQuarterCalendar(
  year: number,
  quarter: Quarter,
  mode: CalendarMode = "ru-official"
): CreateQuarterCalendarResult {
  const dates = getQuarterDates(year, quarter);
  if (mode !== "ru-official" && mode !== "manual") throw new Error("Неизвестный режим календаря");
  if (mode === "ru-official" && year !== 2026) {
    return {
      ok: false,
      reason: "needs-manual",
      message: `Проверенный календарь РФ на ${year} год не включён. Выберите ручную настройку календаря.`
    };
  }
  const calendar = dates.map((date) => ({
    date,
    isWorking: isWeekday(date) && (mode === "manual" || !RU_2026_NON_WORKING.has(date))
  }));
  return {
    ok: true,
    calendar,
    calendarSource: {
      kind: mode,
      version: mode === "ru-official" ? RU_2026_CALENDAR_VERSION : MANUAL_CALENDAR_VERSION,
      baseWorkingDates: calendar.filter((day) => day.isWorking).map((day) => day.date),
      sourceUrls: mode === "ru-official" ? RU_2026_CALENDAR_SOURCES.map((source) => source.url) : []
    }
  };
}

/** Differences use the saved baseline, even when its version is no longer bundled. */
export function getCalendarOverrides(
  snapshot: Pick<QuarterSnapshot, "calendar" | "calendarSource">
): Readonly<{ date: string; isWorking: boolean }>[] | null {
  if (!snapshot.calendarSource) return null;
  const base = new Set(snapshot.calendarSource.baseWorkingDates);
  return snapshot.calendar
    .filter((day) => day.isWorking !== base.has(day.date))
    .map((day) => ({ ...day }))
    .sort((left, right) => left.date < right.date ? -1 : left.date > right.date ? 1 : 0);
}

// Proleptic Gregorian ordinal: 0001-01-01 was Monday. No Date/timezone involved.
function isWeekday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const previousYear = year - 1;
  const monthOffset = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][month - 1];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const ordinal = previousYear * 365 + Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100) + Math.floor(previousYear / 400)
    + monthOffset + (leap && month > 2 ? 1 : 0) + day - 1;
  return ordinal % 7 < 5;
}
