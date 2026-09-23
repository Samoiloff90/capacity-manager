import type { Quarter } from "./calendar-quarter";

/** Frozen provenance of a saved plan. Resolved calendar dates remain authoritative. */
export type CalendarSource = Readonly<{
  kind: "ru-official" | "manual";
  version: string;
  baseWorkingDates: readonly string[];
  sourceUrls?: readonly string[];
}>;

/** All numeric strings are canonical finite decimals; percentage 20 means 20%, not 0.2. */
export type QuarterSnapshot = Readonly<{
  year: number;
  quarter: Quarter;
  calendar: readonly Readonly<{ date: string; isWorking: boolean }>[];
  calendarSource?: CalendarSource;
  competencies: readonly Readonly<{ id: string; name: string }>[];
  members: readonly Readonly<{ id: string; name: string; competencyId: string; fte: string }>[];
  absences: readonly Readonly<{ id: string; memberId: string; startDate: string; endDate: string }>[];
  directions: readonly Readonly<{ id: string; name: string; percent: string }>[];
  tasks: readonly Readonly<{ id: string; name: string; directionId: string; estimateHours: string | null }>[];
}>;

export type QuarterValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type QuarterValidationFailure = { ok: false; errors: QuarterValidationIssue[] };
export type QuarterValidationResult = { ok: true; snapshot: QuarterSnapshot } | QuarterValidationFailure;

export type QuarterMemberCapacity = {
  memberId: string;
  name: string;
  competencyId: string;
  fte: string;
  workingDays: number;
  absenceWorkingDays: number;
  availableDays: number;
  availableHours: string;
};

export type QuarterCompetencyCapacity = {
  competencyId: string;
  name: string;
  memberCount: number;
  availableHours: string;
};

export type QuarterDirectionCapacity = {
  directionId: string;
  name: string;
  percent: string;
  budgetHours: string;
  knownDemandHours: string;
  missingEstimateCount: number;
  budgetComplete: boolean;
  demandComplete: boolean;
  balanceComplete: boolean;
  remainingKnownHours: string;
  overrunKnownHours: string;
  /** Signed remaining hours only when allocation and demand are complete; never a feasibility claim. */
  confirmedRemainingHours: string | null;
};

export type QuarterCapacityResult = {
  year: number;
  quarter: Quarter;
  members: QuarterMemberCapacity[];
  competencies: QuarterCompetencyCapacity[];
  directions: QuarterDirectionCapacity[];
  allocation: { totalPercent: string; status: "complete" | "underallocated" | "overallocated" };
  totals: {
    memberCount: number;
    workingDays: number;
    availableDays: number;
    availableHours: string;
    knownDemandHours: string;
    missingEstimateCount: number;
    demandComplete: boolean;
  };
};

export type CalculateQuarterCapacityResult = { ok: true; result: QuarterCapacityResult } | QuarterValidationFailure;
