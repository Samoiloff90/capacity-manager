export const DEFAULT_HOURS_PER_DAY = 8;
export const DEFAULT_SPRINT_LENGTH_DAYS = 10;
export const DEFAULT_MEMBER_FOCUS_FACTOR = 0.7;
export const DEFAULT_LEAD_FOCUS_FACTOR = 0.6;

export type RoleType = "member" | "lead";
export type AbsenceType = "vacation" | "sick_leave" | "day_off" | "business_trip" | "training" | "other";
export type BucketType = "product" | "support" | "tech_debt" | "initiative" | "other";

export type Competency = {
  id: number;
  code: string;
  name: string;
  sort_order: number;
};

export type Employee = {
  id: number;
  full_name: string;
  competency_id: number;
  competency_code?: string;
  role_type: RoleType;
  fte: number;
  default_focus_factor: number;
  is_active: number;
  start_date?: string | null;
  end_date?: string | null;
};

export type CalendarMonth = {
  id: number;
  year: number;
  month: number;
  working_days: number;
  hours_per_day: number;
  sprint_length_days: number;
};

export type Absence = {
  id: number;
  employee_id: number;
  employee_name?: string;
  start_date: string;
  end_date: string;
  type: AbsenceType;
  comment?: string | null;
};

export type ProjectBucket = {
  id: number;
  name: string;
  type: BucketType;
  is_active: number;
};

export type AllocationProfile = {
  id: number;
  name: string;
  valid_from: string;
  valid_to?: string | null;
  created_at: string;
};

export type AllocationItem = {
  id: number;
  profile_id: number;
  bucket_id: number;
  bucket_name?: string;
  share: number;
};

export type ActualWorkItem = {
  id: number;
  external_source?: string | null;
  external_id?: string | null;
  title: string;
  employee_id?: number | null;
  employee_name?: string | null;
  bucket_id?: number | null;
  bucket_name?: string | null;
  competency_id?: number | null;
  competency_code?: string | null;
  work_date: string;
  spent_hours: number;
  estimate_hours?: number | null;
  status?: string | null;
};

export type CapacityWarning = {
  type:
    | "allocation_sum"
    | "employee_without_competency"
    | "employee_without_focus_factor"
    | "non_positive_capacity"
    | "actual_overload";
  message: string;
  severity: "info" | "warning" | "critical";
};

export type EmployeeCapacity = {
  employeeId: number;
  fullName: string;
  competency: string;
  roleType: RoleType;
  fte: number;
  workingDays: number;
  absenceDays: number;
  availableDays: number;
  focusFactor: number;
  focusedDays: number;
  focusedHours: number;
  sprintEquivalent: number;
  actualHours: number;
  utilizationRate: number | null;
};

export type CompetencyCapacity = {
  competencyId: number;
  competency: string;
  focusedHours: number;
  focusedDays: number;
  actualHours: number;
  utilizationRate: number | null;
};

export type BucketCapacity = {
  bucketId: number;
  bucketName: string;
  share: number;
  plannedHours: number;
  actualHours: number;
  varianceHours: number;
  utilizationRate: number | null;
};

export type MonthlyCapacityResult = {
  month: string;
  totalFte: number;
  totalFocusedDays: number;
  totalFocusedHours: number;
  totalSprintEquivalent: number;
  actualHours: number;
  utilizationRate: number | null;
  byEmployee: EmployeeCapacity[];
  byCompetency: CompetencyCapacity[];
  byBucket: BucketCapacity[];
  warnings: CapacityWarning[];
};

export type CapacityDataSource = {
  getCalendarMonth(monthId: number): Promise<CalendarMonth | null>;
  getActiveEmployees(): Promise<Employee[]>;
  getCompetencies(): Promise<Competency[]>;
  getAbsencesForMonth(year: number, month: number): Promise<Absence[]>;
  getActiveAllocationProfile(month: CalendarMonth): Promise<AllocationProfile | null>;
  getAllocationItems(profileId: number): Promise<AllocationItem[]>;
  getActualWorkForMonth(year: number, month: number): Promise<ActualWorkItem[]>;
};
