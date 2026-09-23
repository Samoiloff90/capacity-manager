export type CapacityAbsence = {
  id?: number;
  personId: number;
  startDate: string;
  endDate: string;
};

export type CapacityPerson = {
  id: number;
  fullName: string;
  fte: number;
  productiveRatio: number;
};

export type CapacityMonth = {
  year: number;
  month: number;
  workingDays: number;
  hoursPerDay: number;
  daysPerSprint: number;
};

export type WorkloadCategoryInput = {
  id: number;
  name: string;
  percent: number;
};

export type PersonCapacityResult = {
  personId: number;
  fullName: string;
  fte: number;
  productiveRatio: number;
  workingDays: number;
  absenceWorkingDays: number;
  availableDays: number;
  productiveDays: number;
  productiveHours: number;
  sprints: number | null;
};

export type WorkloadCapacityResult = {
  categoryId: number;
  name: string;
  percent: number;
  plannedHours: number;
};

export type CapacityResult = {
  people: PersonCapacityResult[];
  workload: WorkloadCapacityResult[];
  totals: {
    fte: number;
    absenceWorkingDays: number;
    availableDays: number;
    productiveDays: number;
    productiveHours: number;
    sprints: number | null;
  };
};

export type PlanFactResult = {
  plannedHours: number;
  actualHours: number;
  utilization: number | null;
  variance: number;
};

export type CalculateCapacityInput = {
  month: CapacityMonth;
  people: CapacityPerson[];
  absences?: CapacityAbsence[];
  workloadCategories?: WorkloadCategoryInput[];
};

