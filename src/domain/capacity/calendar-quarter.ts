export type Quarter = 1 | 2 | 3 | 4;

/** YYYY-MM-DD has four year digits. This is an encoding boundary, not calendar coverage. */
export function isCalendarYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return isCalendarYear(year) && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Civil Gregorian dates only: no Date, timezone, current date or supplied holiday assumptions. */
export function getQuarterDates(year: number, quarter: Quarter): string[] {
  if (!isCalendarYear(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new Error("Некорректный год или квартал");
  }
  const result: string[] = [];
  const firstMonth = (quarter - 1) * 3 + 1;
  for (let month = firstMonth; month < firstMonth + 3; month += 1) {
    for (let day = 1; day <= daysInMonth(year, month); day += 1) {
      result.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
