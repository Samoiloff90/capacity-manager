export type Team = {
  id: number;
  name: string;
  lead_name: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type Competency = {
  id: number;
  name: string;
  sort_order: number;
  color: string | null;
};

export type Person = {
  id: number;
  team_id: number;
  full_name: string;
  competency_id: number;
  fte: number;
  productive_ratio: number;
  active_from: string | null;
  active_to: string | null;
  is_active: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type QuarterPlan = {
  id: number;
  team_id: number;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  hours_per_day: number;
  days_per_sprint: number;
  created_at: string;
  updated_at: string;
};

export type QuarterMonth = {
  id: number;
  quarter_plan_id: number;
  month: number;
  month_name: string;
  working_days: number;
};

export type AbsenceType = "vacation" | "sick_leave" | "day_off" | "business_trip" | "education" | "other";

export type Absence = {
  id: number;
  person_id: number;
  type: AbsenceType;
  start_date: string;
  end_date: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkloadCategory = {
  id: number;
  quarter_plan_id: number;
  name: string;
  percent: number;
  kind: string;
  color: string | null;
};

export type ActualWork = {
  id: number;
  external_id: string | null;
  title: string | null;
  assignee_name: string | null;
  person_id: number | null;
  bucket_name: string | null;
  workload_category_id: number | null;
  competency_name: string | null;
  competency_id: number | null;
  work_date: string;
  spent_hours: number | null;
  estimate_hours: number | null;
  status: string | null;
  imported_at: string;
};

