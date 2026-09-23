import {
  CalculateCapacityInput,
  CapacityAbsence,
  CapacityMonth,
  CapacityResult,
  PersonCapacityResult,
  PlanFactResult,
  WorkloadCapacityResult
} from "./capacity.types";

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

export function calculateCapacity(input: CalculateCapacityInput): CapacityResult {
  const people = input.people.map((person): PersonCapacityResult => {
    const personAbsences = (input.absences ?? []).filter((absence) => absence.personId === person.id);
    const absenceWorkingDays = calculateAbsenceWorkingDays(input.month, personAbsences);
    const availableDays = Math.max(input.month.workingDays - absenceWorkingDays, 0);
    const productiveDays = availableDays * person.productiveRatio * person.fte;
    const productiveHours = productiveDays * input.month.hoursPerDay;
    const sprints = safeDivide(productiveDays, input.month.daysPerSprint);

    return {
      personId: person.id,
      fullName: person.fullName,
      fte: person.fte,
      productiveRatio: person.productiveRatio,
      workingDays: input.month.workingDays,
      absenceWorkingDays: round(absenceWorkingDays),
      availableDays: round(availableDays),
      productiveDays: round(productiveDays),
      productiveHours: round(productiveHours),
      sprints: sprints === null ? null : round(sprints)
    };
  });

  const totals = {
    fte: round(people.reduce((sum, person) => sum + person.fte, 0)),
    absenceWorkingDays: round(people.reduce((sum, person) => sum + person.absenceWorkingDays, 0)),
    availableDays: round(people.reduce((sum, person) => sum + person.availableDays, 0)),
    productiveDays: round(people.reduce((sum, person) => sum + person.productiveDays, 0)),
    productiveHours: round(people.reduce((sum, person) => sum + person.productiveHours, 0)),
    sprints: safeDivide(
      people.reduce((sum, person) => sum + person.productiveDays, 0),
      input.month.daysPerSprint
    )
  };

  const workload: WorkloadCapacityResult[] = (input.workloadCategories ?? []).map((category) => ({
    categoryId: category.id,
    name: category.name,
    percent: category.percent,
    plannedHours: round(calculateWorkloadHours(totals.productiveHours, category.percent))
  }));

  return {
    people,
    workload,
    totals: {
      ...totals,
      sprints: totals.sprints === null ? null : round(totals.sprints)
    }
  };
}

export function calculateAbsenceWorkingDays(month: CapacityMonth, absences: CapacityAbsence[]) {
  const bounds = getMonthBounds(month.year, month.month);
  const workingDates = new Set<string>();

  for (const absence of absences) {
    const start = maxDate(parseIsoDate(absence.startDate), bounds.start);
    const end = minDate(parseIsoDate(absence.endDate), bounds.end);
    if (end < start) continue;

    const cursor = new Date(start);
    while (cursor <= end) {
      if (isBusinessDay(cursor)) {
        workingDates.add(toIsoDate(cursor));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return workingDates.size;
}

export function calculateWorkloadHours(productiveHours: number, percent: number) {
  return productiveHours * percent;
}

export function calculatePlanFact(plannedHours: number, actualHours: number): PlanFactResult {
  return {
    plannedHours,
    actualHours,
    utilization: safeDivide(actualHours, plannedHours),
    variance: round(actualHours - plannedHours)
  };
}

function safeDivide(numerator: number, denominator: number) {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function getMonthBounds(year: number, month: number) {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0))
  };
}

function parseIsoDate(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isBusinessDay(date: Date) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

function maxDate(left: Date, right: Date) {
  return left > right ? left : right;
}

function minDate(left: Date, right: Date) {
  return left < right ? left : right;
}

