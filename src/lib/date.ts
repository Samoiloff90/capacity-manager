export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function monthBounds(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end, startIso: toIsoDate(start), endIso: toIsoDate(end) };
}

export function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function businessDaysBetweenInclusive(startIso: string, endIso: string, clamp?: { start: Date; end: Date }) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const first = clamp && start < clamp.start ? new Date(clamp.start) : start;
  const last = clamp && end > clamp.end ? new Date(clamp.end) : end;
  if (last < first) return 0;

  let days = 0;
  const cursor = new Date(first);
  while (cursor <= last) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
