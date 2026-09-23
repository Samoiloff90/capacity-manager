import {
  addDecimal, compareDecimal, decimalToString, divideDecimalBy100, ExactDecimal,
  multiplyDecimal, parseDecimal, subtractDecimal
} from "./decimal-exact";
import type { CalculateQuarterCapacityResult, QuarterDirectionCapacity } from "./quarter-capacity.types";
import { validateQuarterSnapshot } from "./quarter-snapshot.validation";

const zero = parseDecimal("0");
const hundred = parseDecimal("100");
const byId = (left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

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
  const members = [...snapshot.members].sort(byId).map((member) => {
    const absenceWorkingDays = absentDatesByMember.get(member.id)?.size ?? 0;
    const availableDays = workingDates.length - absenceWorkingDays;
    const hours = multiplyDecimal(parseDecimal(String(availableDays * 8)), parseDecimal(member.fte));
    totalHours = addDecimal(totalHours, hours);
    totalAvailableDays += availableDays;
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

  let totalPercent = zero;
  for (const direction of snapshot.directions) totalPercent = addDecimal(totalPercent, parseDecimal(direction.percent));
  const percentComparison = compareDecimal(totalPercent, hundred);
  const budgetComplete = percentComparison === 0;
  let totalKnownDemand = zero;
  let totalMissingEstimates = 0;
  const knownDemandByDirection = new Map<string, ExactDecimal>();
  const missingByDirection = new Map<string, number>();
  for (const task of snapshot.tasks) {
    if (task.estimateHours === null) {
      missingByDirection.set(task.directionId, (missingByDirection.get(task.directionId) ?? 0) + 1);
      totalMissingEstimates += 1;
    } else {
      const hours = parseDecimal(task.estimateHours);
      knownDemandByDirection.set(task.directionId, addDecimal(knownDemandByDirection.get(task.directionId) ?? zero, hours));
      totalKnownDemand = addDecimal(totalKnownDemand, hours);
    }
  }
  const directions: QuarterDirectionCapacity[] = [...snapshot.directions].sort(byId).map((direction) => {
    const budget = divideDecimalBy100(multiplyDecimal(totalHours, parseDecimal(direction.percent)));
    const knownDemand = knownDemandByDirection.get(direction.id) ?? zero;
    const missingEstimateCount = missingByDirection.get(direction.id) ?? 0;
    const demandComplete = missingEstimateCount === 0;
    const balanceComplete = budgetComplete && demandComplete;
    const remaining = subtractDecimal(budget, knownDemand);
    const overrun = compareDecimal(remaining, zero) < 0 ? subtractDecimal(zero, remaining) : zero;
    const remainingKnownHours = decimalToString(remaining);
    return {
      directionId: direction.id, name: direction.name, percent: direction.percent,
      budgetHours: decimalToString(budget), knownDemandHours: decimalToString(knownDemand),
      missingEstimateCount, budgetComplete, demandComplete, balanceComplete,
      remainingKnownHours, overrunKnownHours: decimalToString(overrun),
      confirmedRemainingHours: balanceComplete ? remainingKnownHours : null
    };
  });

  return { ok: true, result: {
    year: snapshot.year,
    quarter: snapshot.quarter,
    members, competencies, directions,
    allocation: {
      totalPercent: decimalToString(totalPercent),
      status: budgetComplete ? "complete" : percentComparison < 0 ? "underallocated" : "overallocated"
    },
    totals: {
      memberCount: members.length, workingDays: workingDates.length,
      availableDays: totalAvailableDays, availableHours: decimalToString(totalHours),
      knownDemandHours: decimalToString(totalKnownDemand), missingEstimateCount: totalMissingEstimates,
      demandComplete: totalMissingEstimates === 0
    }
  } };
}
