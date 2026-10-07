import {
  addDecimal, compareDecimal, decimalToString, divideDecimalBy100, ExactDecimal,
  multiplyDecimal, parseDecimal, subtractDecimal
} from "./decimal-exact";
import type {
  CalculateQuarterCapacityResult, QuarterDirectionCapacity, QuarterReserveMember, QuarterSnapshot
} from "./quarter-capacity.types";
import { validateQuarterSnapshot } from "./quarter-snapshot.validation";
import { reserveByPerson } from "./reserve";

const zero = parseDecimal("0");
const hundred = parseDecimal("100");
const byId = (left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const share = (hours: ExactDecimal, percent: string) => divideDecimalBy100(multiplyDecimal(hours, parseDecimal(percent)));

type Direction = QuarterSnapshot["directions"][number];
type Quota = { set: boolean; hours: ExactDecimal; members: QuarterReserveMember[] };

/**
 * A work source gets its share of all available hours. A reserve is summed per person
 * (reserveByPerson, DEC-038). Without own shares the two are the same exact number, so
 * quarters saved by 0.3.0 keep their budgets.
 */
function quota(direction: Direction, people: readonly { memberId: string; availableHours: string }[], total: ExactDecimal): Quota {
  if (direction.kind !== "reserve") {
    return direction.percent === null ? { set: false, hours: zero, members: [] }
      : { set: true, hours: share(total, direction.percent), members: [] };
  }
  const reserve = reserveByPerson(people, direction.percent, new Map(direction.memberPercents.map((row) => [row.memberId, row.percent])));
  return { set: reserve.total !== null, hours: reserve.total === null ? zero : parseDecimal(reserve.total), members: reserve.members };
}

/** A complete, resolved quarter snapshot is the only source of calendar and capacity data. */
export function calculateQuarterCapacity(input: unknown): CalculateQuarterCapacityResult {
  const validated = validateQuarterSnapshot(input, { requireCompleteCalendar: true });
  if (!validated.ok) return validated;
  const snapshot = validated.snapshot;
  const workingDates = snapshot.calendar.filter((day) => day.isWorking).map((day) => day.date);
  const absentDatesByMember = new Map<string, Set<string>>();
  for (const absence of snapshot.absences) {
    const dates = absentDatesByMember.get(absence.memberId) ?? new Set<string>();
    // At most one quarter is inspected, including for absence intervals spanning many years.
    for (const date of workingDates) {
      if (date >= absence.startDate && date <= absence.endDate) dates.add(date);
    }
    absentDatesByMember.set(absence.memberId, dates);
  }

  let totalHours = zero;
  let totalAvailableDays = 0;
  const hoursByCompetency = new Map<string, ExactDecimal>();
  const countByCompetency = new Map<string, number>();
  const hoursByMember = new Map<string, ExactDecimal>();
  const members = [...snapshot.members].sort(byId).map((member) => {
    const absenceWorkingDays = absentDatesByMember.get(member.id)?.size ?? 0;
    const availableDays = workingDates.length - absenceWorkingDays;
    const hours = multiplyDecimal(parseDecimal(String(availableDays * 8)), parseDecimal(member.fte));
    totalHours = addDecimal(totalHours, hours);
    totalAvailableDays += availableDays;
    hoursByMember.set(member.id, hours);
    hoursByCompetency.set(member.competencyId, addDecimal(hoursByCompetency.get(member.competencyId) ?? zero, hours));
    countByCompetency.set(member.competencyId, (countByCompetency.get(member.competencyId) ?? 0) + 1);
    return {
      memberId: member.id, name: member.name, competencyId: member.competencyId, fte: member.fte,
      workingDays: workingDates.length, absenceWorkingDays, availableDays, availableHours: decimalToString(hours)
    };
  });
  const competencies = [...snapshot.competencies].sort(byId).map((competency) => ({
    competencyId: competency.id,
    name: competency.name,
    memberCount: countByCompetency.get(competency.id) ?? 0,
    availableHours: decimalToString(hoursByCompetency.get(competency.id) ?? zero)
  }));
  // Team order, as on the screen: the reserve window lists people as the team tab does.
  const people = snapshot.members.map((member) => ({ memberId: member.id, availableHours: decimalToString(hoursByMember.get(member.id) ?? zero) }));

  // A share not set yet adds nothing and leaves the allocation incomplete.
  let totalPercent = zero;
  for (const direction of snapshot.directions) {
    if (direction.percent !== null) totalPercent = addDecimal(totalPercent, parseDecimal(direction.percent));
  }
  const percentComparison = compareDecimal(totalPercent, hundred);
  // MVP completeness (0.3.0): shares add up to 100%. The general report still reads it.
  const budgetComplete = percentComparison === 0 && snapshot.directions.every((direction) => direction.percent !== null);

  type Counts = { known: ExactDecimal; missing: number; count: number };
  const empty = (): Counts => ({ known: zero, missing: 0, count: 0 });
  const byMark = { plan: new Map<string, Counts>(), candidate: new Map<string, Counts>(), out: new Map<string, Counts>() };
  // Only works in the quarter plan take the budget; candidates and «Не в этом квартале» do not (DEC-032).
  for (const task of snapshot.tasks) {
    const counts = byMark[task.mark].get(task.directionId) ?? empty();
    counts.count += 1;
    if (task.estimateHours === null) counts.missing += 1;
    else counts.known = addDecimal(counts.known, parseDecimal(task.estimateHours));
    byMark[task.mark].set(task.directionId, counts);
  }

  const directions: QuarterDirectionCapacity[] = [...snapshot.directions].sort(byId).map((direction) => {
    const budget = quota(direction, people, totalHours);
    const plan = byMark.plan.get(direction.id) ?? empty();
    const candidates = byMark.candidate.get(direction.id) ?? empty();
    const demandComplete = plan.missing === 0;
    const balanceComplete = budgetComplete && demandComplete;
    const remaining = subtractDecimal(budget.hours, plan.known);
    const overrun = compareDecimal(remaining, zero) < 0 ? subtractDecimal(zero, remaining) : zero;
    const remainingKnownHours = decimalToString(remaining);
    return {
      directionId: direction.id, name: direction.name, kind: direction.kind, percent: direction.percent,
      quotaSet: budget.set, ownPercentCount: direction.kind === "reserve" ? direction.memberPercents.length : 0,
      reserveMembers: budget.members,
      budgetHours: decimalToString(budget.hours), knownDemandHours: decimalToString(plan.known),
      missingEstimateCount: plan.missing, budgetComplete, demandComplete, balanceComplete,
      remainingKnownHours, overrunKnownHours: decimalToString(overrun),
      confirmedRemainingHours: balanceComplete ? remainingKnownHours : null,
      planCount: plan.count, candidateCount: candidates.count,
      candidateKnownHours: decimalToString(candidates.known), candidateMissingEstimateCount: candidates.missing,
      outCount: byMark.out.get(direction.id)?.count ?? 0
    };
  });

  let reserveHours = zero;
  let allocated = zero;
  let planned = zero;
  let remainingHours = zero;
  let overrunHours = zero;
  let planCount = 0;
  let plannedMissing = 0;
  let overrunSourceCount = 0;
  for (const direction of directions) {
    if (!direction.quotaSet) continue;
    allocated = addDecimal(allocated, parseDecimal(direction.budgetHours));
    if (direction.kind === "reserve") reserveHours = addDecimal(reserveHours, parseDecimal(direction.budgetHours));
  }
  for (const direction of directions) {
    if (direction.kind === "reserve") continue;
    planned = addDecimal(planned, parseDecimal(direction.knownDemandHours));
    plannedMissing += direction.missingEstimateCount;
    planCount += direction.planCount;
    if (!direction.quotaSet) continue;
    if (direction.overrunKnownHours !== "0") {
      overrunHours = addDecimal(overrunHours, parseDecimal(direction.overrunKnownHours));
      overrunSourceCount += 1;
    } else {
      remainingHours = addDecimal(remainingHours, parseDecimal(direction.remainingKnownHours));
    }
  }
  const unallocated = subtractDecimal(totalHours, allocated);

  return { ok: true, result: {
    year: snapshot.year,
    quarter: snapshot.quarter,
    members, competencies, directions,
    allocation: {
      totalPercent: decimalToString(totalPercent),
      status: budgetComplete ? "complete" : percentComparison > 0 ? "overallocated" : "underallocated"
    },
    plan: {
      reserveCount: directions.filter((direction) => direction.kind === "reserve").length,
      reserveHours: decimalToString(reserveHours),
      allocatedHours: decimalToString(allocated),
      unallocatedHours: decimalToString(unallocated),
      // Nobody available: every quota is 0 h, the entered shares still tell an excess.
      overallocated: compareDecimal(totalHours, zero) > 0 ? compareDecimal(unallocated, zero) < 0 : percentComparison > 0,
      nominalPercent: decimalToString(totalPercent),
      unsetQuotaCount: directions.filter((direction) => !direction.quotaSet).length,
      planCount,
      plannedKnownHours: decimalToString(planned),
      plannedMissingEstimateCount: plannedMissing,
      remainingHours: decimalToString(remainingHours),
      overrunHours: decimalToString(overrunHours),
      overrunSourceCount
    },
    totals: {
      memberCount: members.length, workingDays: workingDates.length,
      availableDays: totalAvailableDays, availableHours: decimalToString(totalHours),
      knownDemandHours: decimalToString(planned), missingEstimateCount: plannedMissing,
      demandComplete: plannedMissing === 0
    }
  } };
}
