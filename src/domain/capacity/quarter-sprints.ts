import { getQuarterDates, type Quarter } from "./calendar-quarter";

/** PO decision 2026-09-27: two-week sprints from the first Monday of the quarter. */
export const SPRINT_LENGTH_DAYS = 14;

export type QuarterSprint = {
  number: number;
  startDate: string;
  endDate: string;
  /** "YYYY-MM" of the last day: a sprint across two months counts in the month it ends. */
  month: string;
  /** Working days by the plan calendar with manual changes; null while a day has no status. */
  workingDays: number | null;
};

export type QuarterSprints = {
  sprints: QuarterSprint[];
  months: { month: string; sprintCount: number }[];
  /** Inclusive date ranges of the quarter that belong to no sprint. */
  outside: { startDate: string; endDate: string }[];
};

/**
 * Sprints restart every quarter on its first calendar Monday, even a holiday one. Only whole
 * sprints that end inside the quarter count, so a sprint never crosses into the next quarter.
 */
export function describeQuarterSprints(
  year: number,
  quarter: Quarter,
  calendar: readonly Readonly<{ date: string; isWorking: boolean }>[]
): QuarterSprints {
  const dates = getQuarterDates(year, quarter);
  const status = new Map(calendar.map((day) => [day.date, day.isWorking]));
  const firstMonday = dates.findIndex((date) => weekday(date) === 1);
  const sprints: QuarterSprint[] = [];
  for (let start = firstMonday; start + SPRINT_LENGTH_DAYS <= dates.length; start += SPRINT_LENGTH_DAYS) {
    const days = dates.slice(start, start + SPRINT_LENGTH_DAYS);
    const endDate = days[days.length - 1];
    const statuses = days.map((date) => status.get(date));
    sprints.push({
      number: sprints.length + 1, startDate: days[0], endDate, month: endDate.slice(0, 7),
      workingDays: statuses.includes(undefined) ? null : statuses.filter(Boolean).length
    });
  }
  const covered = firstMonday + sprints.length * SPRINT_LENGTH_DAYS;
  const outside = [
    ...(firstMonday > 0 ? [{ startDate: dates[0], endDate: dates[firstMonday - 1] }] : []),
    ...(covered < dates.length ? [{ startDate: dates[covered], endDate: dates[dates.length - 1] }] : [])
  ];
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))]
    .map((month) => ({ month, sprintCount: sprints.filter((sprint) => sprint.month === month).length }));
  return { sprints, months, outside };
}

/** 0 = Sunday … 6 = Saturday for a civil YYYY-MM-DD date, without Date or time zones. */
function weekday(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // Days from 1970-01-01 (a Thursday) by the proleptic Gregorian civil-date algorithm.
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146097 + dayOfEra - 719468;
  return ((days % 7) + 11) % 7;
}
