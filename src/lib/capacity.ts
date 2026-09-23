import {
  AllocationItem,
  CapacityDataSource,
  CapacityWarning,
  CompetencyCapacity,
  EmployeeCapacity,
  MonthlyCapacityResult
} from "./types";
import { businessDaysBetweenInclusive, monthBounds, monthLabel } from "./date";

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

export async function calculateMonthlyCapacity(
  monthId: number,
  source: CapacityDataSource
): Promise<MonthlyCapacityResult> {
  const month = await source.getCalendarMonth(monthId);
  if (!month) {
    throw new Error(`Calendar month ${monthId} was not found`);
  }

  const [employees, competencies, absences, profile, actualWork] = await Promise.all([
    source.getActiveEmployees(),
    source.getCompetencies(),
    source.getAbsencesForMonth(month.year, month.month),
    source.getActiveAllocationProfile(month),
    source.getActualWorkForMonth(month.year, month.month)
  ]);

  const allocationItems = profile ? await source.getAllocationItems(profile.id) : [];
  const competencyById = new Map(competencies.map((item) => [item.id, item]));
  const bounds = monthBounds(month.year, month.month);
  const warnings: CapacityWarning[] = [];

  const actualByEmployee = sumBy(actualWork, (item) => item.employee_id ?? -1, (item) => item.spent_hours);
  const actualByCompetency = sumBy(actualWork, (item) => item.competency_id ?? -1, (item) => item.spent_hours);
  const actualByBucket = sumBy(actualWork, (item) => item.bucket_id ?? -1, (item) => item.spent_hours);

  const byEmployee: EmployeeCapacity[] = employees.map((employee) => {
    const absenceDays = absences
      .filter((absence) => absence.employee_id === employee.id)
      .reduce((sum, absence) => sum + businessDaysBetweenInclusive(absence.start_date, absence.end_date, bounds), 0);
    const availableDays = Math.max(month.working_days - absenceDays, 0);
    const focusFactor = employee.default_focus_factor;
    const focusedDays = availableDays * focusFactor * employee.fte;
    const focusedHours = focusedDays * month.hours_per_day;
    const actualHours = actualByEmployee.get(employee.id) ?? 0;
    const utilizationRate = focusedHours > 0 ? actualHours / focusedHours : null;
    const competency = competencyById.get(employee.competency_id);

    if (!competency) {
      warnings.push({
        type: "employee_without_competency",
        severity: "critical",
        message: `${employee.full_name}: не найдена компетенция`
      });
    }
    if (!focusFactor || focusFactor <= 0) {
      warnings.push({
        type: "employee_without_focus_factor",
        severity: "critical",
        message: `${employee.full_name}: загрузка не задана`
      });
    }
    if (focusedHours <= 0) {
      warnings.push({
        type: "non_positive_capacity",
        severity: "warning",
        message: `${employee.full_name}: нулевая или отрицательная емкость`
      });
    }
    if (utilizationRate !== null && utilizationRate > 1) {
      warnings.push({
        type: "actual_overload",
        severity: "warning",
        message: `${employee.full_name}: факт выше плановой емкости`
      });
    }

    return {
      employeeId: employee.id,
      fullName: employee.full_name,
      competency: competency?.code ?? "N/A",
      roleType: employee.role_type,
      fte: employee.fte,
      workingDays: month.working_days,
      absenceDays,
      availableDays,
      focusFactor,
      focusedDays: round(focusedDays),
      focusedHours: round(focusedHours),
      sprintEquivalent: round(focusedDays / month.sprint_length_days),
      actualHours: round(actualHours),
      utilizationRate: utilizationRate === null ? null : round(utilizationRate, 4)
    };
  });

  const totalFte = round(byEmployee.reduce((sum, item) => sum + item.fte, 0));
  const totalFocusedDays = round(byEmployee.reduce((sum, item) => sum + item.focusedDays, 0));
  const totalFocusedHours = round(byEmployee.reduce((sum, item) => sum + item.focusedHours, 0));
  const totalSprintEquivalent = round(byEmployee.reduce((sum, item) => sum + item.sprintEquivalent, 0));
  const actualHours = round(actualWork.reduce((sum, item) => sum + item.spent_hours, 0));
  const utilizationRate = totalFocusedHours > 0 ? round(actualHours / totalFocusedHours, 4) : null;

  const byCompetency: CompetencyCapacity[] = competencies.map((competency) => {
    const employeesForCompetency = byEmployee.filter((item) => item.competency === competency.code);
    const focusedHours = round(employeesForCompetency.reduce((sum, item) => sum + item.focusedHours, 0));
    const focusedDays = round(employeesForCompetency.reduce((sum, item) => sum + item.focusedDays, 0));
    const actual = actualByCompetency.get(competency.id) ?? 0;
    return {
      competencyId: competency.id,
      competency: competency.code,
      focusedHours,
      focusedDays,
      actualHours: round(actual),
      utilizationRate: focusedHours > 0 ? round(actual / focusedHours, 4) : null
    };
  });

  const shareTotal = allocationItems.reduce((sum, item) => sum + item.share, 0);
  if (Math.abs(shareTotal - 1) > 0.0001) {
    warnings.push({
      type: "allocation_sum",
      severity: "critical",
      message: `Сумма нагрузки равна ${round(shareTotal * 100)}%, нужно 100%`
    });
  }

  const byBucket = allocationItems.map((item: AllocationItem) => {
    const plannedHours = totalFocusedHours * item.share;
    const actual = actualByBucket.get(item.bucket_id) ?? 0;
    return {
      bucketId: item.bucket_id,
      bucketName: item.bucket_name ?? `Bucket #${item.bucket_id}`,
      share: item.share,
      plannedHours: round(plannedHours),
      actualHours: round(actual),
      varianceHours: round(actual - plannedHours),
      utilizationRate: plannedHours > 0 ? round(actual / plannedHours, 4) : null
    };
  });

  return {
    month: monthLabel(month.year, month.month),
    totalFte,
    totalFocusedDays,
    totalFocusedHours,
    totalSprintEquivalent,
    actualHours,
    utilizationRate,
    byEmployee,
    byCompetency,
    byBucket,
    warnings
  };
}

function sumBy<T>(items: T[], key: (item: T) => number, value: (item: T) => number) {
  const result = new Map<number, number>();
  for (const item of items) {
    const itemKey = key(item);
    result.set(itemKey, (result.get(itemKey) ?? 0) + value(item));
  }
  return result;
}
