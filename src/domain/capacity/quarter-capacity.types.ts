import type { Quarter } from "./calendar-quarter";

/** Frozen provenance of a saved plan. Resolved calendar dates remain authoritative. */
export type CalendarSource = Readonly<{
  kind: "ru-official" | "manual";
  version: string;
  baseWorkingDates: readonly string[];
  sourceUrls?: readonly string[];
}>;

/** A direction is a demand source: works take its quota; a reserve has no works (DEC-030). */
export type DirectionKind = "work" | "reserve";
/** Planning mark, not an execution status: candidate is shown as «На рассмотрении» (DEC-032, DEC-042). */
export type TaskMark = "candidate" | "plan" | "out";

type QuarterSetup = Readonly<{
  year: number;
  quarter: Quarter;
  calendar: readonly Readonly<{ date: string; isWorking: boolean }>[];
  calendarSource?: CalendarSource;
  competencies: readonly Readonly<{ id: string; name: string }>[];
  members: readonly Readonly<{ id: string; name: string; competencyId: string; fte: string }>[];
  absences: readonly Readonly<{ id: string; memberId: string; startDate: string; endDate: string }>[];
}>;

/**
 * Quarter snapshot, format 2. All numeric strings are canonical finite decimals; percentage 20
 * means 20%, not 0.2. A null percent is a share not set yet; a null estimate is unknown, not 0.
 */
export type QuarterSnapshot = QuarterSetup & Readonly<{
  directions: readonly Readonly<{
    id: string; name: string; percent: string | null; kind: DirectionKind;
    /** Own reserve shares that replace the direction's share for these people (DEC-038). */
    memberPercents: readonly Readonly<{ memberId: string; percent: string }>[];
  }>[];
  tasks: readonly Readonly<{
    id: string; name: string; directionId: string; estimateHours: string | null;
    mark: TaskMark; link: string | null; comment: string | null;
  }>[];
}>;

/** Format 1, saved by 0.1.0–0.3.0. Read as is and converted in memory (DEC-044). */
export type QuarterSnapshotV1 = QuarterSetup & Readonly<{
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
  /** null: the share is not set yet; the budget is then 0 and not complete. */
  percent: string | null;
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
