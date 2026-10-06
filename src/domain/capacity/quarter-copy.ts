import type { Quarter } from "./calendar-quarter";
import type { CalendarSource, QuarterSnapshot } from "./quarter-capacity.types";

export type NewQuarterBase = {
  year: number;
  quarter: Quarter;
  calendar: QuarterSnapshot["calendar"];
  calendarSource: CalendarSource;
};

/**
 * The next quarter starts from the saved team and shares of another quarter. The same ids
 * mean the same person or direction; absences, tasks and calendar belong to one period.
 */
export function copyQuarterSetup(source: QuarterSnapshot, base: NewQuarterBase): QuarterSnapshot {
  return {
    ...base,
    competencies: source.competencies.map(({ id, name }) => ({ id, name })),
    members: source.members.map(({ id, name, competencyId, fte }) => ({ id, name, competencyId, fte })),
    absences: [],
    // Own reserve shares refer to the same people, copied with the same ids.
    directions: source.directions.map(({ id, name, percent, kind, memberPercents }) => ({
      id, name, percent, kind, memberPercents: memberPercents.map(({ memberId, percent: own }) => ({ memberId, percent: own }))
    })),
    tasks: []
  };
}

type Period = { year: number; quarter: Quarter };

/** Suggested new period: the quarter after the latest saved one; for an empty project, today's quarter. */
export function nextQuarterAfter(plans: readonly Period[], today: { year: number; month: number }): Period {
  const latest = [...plans].sort((left, right) => right.year - left.year || right.quarter - left.quarter)[0];
  if (!latest) return { year: today.year, quarter: (Math.floor((today.month - 1) / 3) + 1) as Quarter };
  return latest.quarter === 4 ? { year: latest.year + 1, quarter: 1 } : { year: latest.year, quarter: (latest.quarter + 1) as Quarter };
}

/** Default source: the nearest saved quarter before the new one, otherwise the latest saved. */
export function defaultCopySource<T extends Period>(plans: readonly T[], target: Period): T | null {
  const order = (period: Period) => period.year * 4 + period.quarter;
  const sorted = [...plans].sort((left, right) => order(right) - order(left));
  return sorted.find((plan) => order(plan) < order(target)) ?? sorted[0] ?? null;
}
