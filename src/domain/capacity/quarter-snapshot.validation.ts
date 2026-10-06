import { z } from "zod";
import { getQuarterDates, isCalendarDate, isCalendarYear, Quarter } from "./calendar-quarter";
import { compareDecimal, isCanonicalDecimal, MAX_DECIMAL_INPUT_CHARACTERS, parseDecimal } from "./decimal-exact";
import type { QuarterSnapshot, QuarterSnapshotV1, QuarterValidationFailure, QuarterValidationResult } from "./quarter-capacity.types";

/** Technical payload protection; these are not team-size or decimal-precision business limits. */
export const QUARTER_INPUT_LIMITS = {
  decimalCharacters: MAX_DECIMAL_INPUT_CHARACTERS,
  idCharacters: 128,
  nameCharacters: 1000,
  linkCharacters: 2048,
  commentCharacters: 2000,
  entitiesPerCollection: 10000
} as const;

/**
 * A work link opens in the system browser on an explicit click (DEC-034, DEC-045): only an
 * absolute http(s) address without credentials. The native handler checks the same rule again.
 */
export function isWebLink(value: string): boolean {
  if (value.length > QUARTER_INPUT_LIMITS.linkCharacters || value.trim() !== value || /\s/.test(value)) return false;
  let url: URL;
  try { url = new URL(value); }
  catch { return false; }
  return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== ""
    && url.username === "" && url.password === "" && /^https?:\/\//i.test(value);
}

const id = z.string().min(1).max(QUARTER_INPUT_LIMITS.idCharacters)
  .refine((value) => value.trim() === value, "ID не должен содержать пробелы по краям");
const name = z.string().max(QUARTER_INPUT_LIMITS.nameCharacters)
  .refine((value) => value.trim().length > 0, "Укажите название или имя");
const date = z.string().refine(isCalendarDate, "Укажите существующую дату в формате ГГГГ-ММ-ДД");
const link = z.string().refine(isWebLink, "Ссылка должна начинаться с https:// или http://");
const comment = z.string().max(QUARTER_INPUT_LIMITS.commentCharacters, `Комментарий длиннее ${QUARTER_INPUT_LIMITS.commentCharacters} символов`);

function nonnegativeDecimal(maximum?: string) {
  return z.string().superRefine((value, context) => {
    if (!isCanonicalDecimal(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Ожидается каноническое десятичное число длиной не более ${MAX_DECIMAL_INPUT_CHARACTERS} символов` });
      return;
    }
    const parsed = parseDecimal(value);
    if (compareDecimal(parsed, parseDecimal("0")) < 0 || (maximum !== undefined && compareDecimal(parsed, parseDecimal(maximum)) > 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: maximum === undefined ? "Число не может быть отрицательным" : `Число должно быть от 0 до ${maximum}` });
    }
  });
}

const setup = {
  year: z.number().refine(isCalendarYear, "Год должен помещаться в формат ГГГГ: от 0001 до 9999"),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  calendar: z.array(z.object({ date, isWorking: z.boolean() }).strict()).max(92),
  calendarSource: z.object({
    kind: z.enum(["ru-official", "manual"]),
    version: id,
    baseWorkingDates: z.array(date).max(92),
    sourceUrls: z.array(z.string().max(2048).url().refine((value) => /^https?:\/\//.test(value), "Ожидается HTTP(S) ссылка на источник")).max(8).optional()
  }).strict().optional(),
  competencies: z.array(z.object({ id, name }).strict()),
  members: z.array(z.object({ id, name, competencyId: id, fte: nonnegativeDecimal("1") }).strict()),
  absences: z.array(z.object({ id, memberId: id, startDate: date, endDate: date }).strict())
};

/** Format 1 (0.1.0–0.3.0), exactly as those versions wrote it. */
const structureV1 = z.object({
  ...setup,
  directions: z.array(z.object({ id, name, percent: nonnegativeDecimal("100") }).strict()),
  tasks: z.array(z.object({ id, name, directionId: id, estimateHours: nonnegativeDecimal().nullable() }).strict())
}).strict();

/** Format 2: every field is written; there are no implicit defaults in a stored quarter. */
const structure = z.object({
  ...setup,
  directions: z.array(z.object({
    id, name, percent: nonnegativeDecimal("100").nullable(), kind: z.enum(["work", "reserve"]),
    memberPercents: z.array(z.object({ memberId: id, percent: nonnegativeDecimal("100") }).strict())
      .max(QUARTER_INPUT_LIMITS.entitiesPerCollection)
  }).strict()),
  tasks: z.array(z.object({
    id, name, directionId: id, estimateHours: nonnegativeDecimal().nullable(),
    mark: z.enum(["candidate", "plan", "out"]), link: link.nullable(), comment: comment.nullable()
  }).strict())
}).strict();

// Check collection sizes before traversing rows or parsing decimal coefficients.
const payloadSize = z.unknown().superRefine((value, context) => {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const field of ["calendar", "competencies", "members", "absences", "directions", "tasks"]) {
    const rows = record[field];
    const limit = field === "calendar" ? 92 : QUARTER_INPUT_LIMITS.entitiesPerCollection;
    if (Array.isArray(rows) && rows.length > limit) {
      context.addIssue({ code: z.ZodIssueCode.custom, fatal: true, path: [field], message: `Превышен технический предел размера списка: ${limit}` });
    }
  }
  const source = record.calendarSource;
  if (typeof source === "object" && source !== null) {
    for (const [field, limit] of [["baseWorkingDates", 92], ["sourceUrls", 8]] as const) {
      const rows = (source as Record<string, unknown>)[field];
      if (Array.isArray(rows) && rows.length > limit) {
        context.addIssue({ code: z.ZodIssueCode.custom, fatal: true, path: ["calendarSource", field], message: `Превышен технический предел размера списка: ${limit}` });
      }
    }
  }
});

type Checked = Pick<QuarterSnapshotV1, "year" | "quarter" | "calendar" | "calendarSource" | "competencies" | "members" | "absences"> & {
  directions: readonly { id: string }[];
  tasks: readonly { id: string; directionId: string }[];
};

/** References and dates shared by both formats; returns ids for the format-specific checks. */
function checkReferences(snapshot: Checked, context: z.RefinementCtx) {
  const uniqueIds = (field: "competencies" | "members" | "absences" | "directions" | "tasks") => {
    const known = new Set<string>();
    snapshot[field].forEach((row, index) => {
      if (known.has(row.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field, index, "id"], message: "ID повторяется внутри списка" });
      }
      known.add(row.id);
    });
    return known;
  };
  const competencyIds = uniqueIds("competencies");
  const memberIds = uniqueIds("members");
  uniqueIds("absences");
  const directionIds = uniqueIds("directions");
  uniqueIds("tasks");

  snapshot.members.forEach((member, index) => {
    if (!competencyIds.has(member.competencyId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["members", index, "competencyId"], message: "Компетенция не найдена в этом плане" });
    }
  });
  snapshot.absences.forEach((absence, index) => {
    if (!memberIds.has(absence.memberId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["absences", index, "memberId"], message: "Участник не найден в этом плане" });
    }
    if (absence.endDate < absence.startDate) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["absences", index, "endDate"], message: "Конец отсутствия раньше начала" });
    }
  });
  snapshot.tasks.forEach((task, index) => {
    if (!directionIds.has(task.directionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "directionId"], message: "Направление не найдено в этом плане" });
    }
  });

  if (isCalendarYear(snapshot.year)) {
    const expectedDates = new Set(getQuarterDates(snapshot.year, snapshot.quarter));
    const seenDates = new Set<string>();
    snapshot.calendar.forEach((day, index) => {
      if (!expectedDates.has(day.date)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["calendar", index, "date"], message: "Дата не принадлежит выбранному кварталу" });
      }
      if (seenDates.has(day.date)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["calendar", index, "date"], message: "Дата календаря повторяется" });
      }
      seenDates.add(day.date);
    });
    const seenBaseDates = new Set<string>();
    snapshot.calendarSource?.baseWorkingDates.forEach((day, index) => {
      if (!expectedDates.has(day)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["calendarSource", "baseWorkingDates", index], message: "Дата исходного календаря не принадлежит выбранному кварталу" });
      }
      if (seenBaseDates.has(day)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["calendarSource", "baseWorkingDates", index], message: "Дата исходного календаря повторяется" });
      }
      seenBaseDates.add(day);
    });
  }
  return { memberIds };
}

const quarterSnapshotV1Schema = payloadSize.pipe(structureV1).superRefine((snapshot, context) => {
  checkReferences(snapshot, context);
});

/** Storage validation allows a calendar being prepared; computation additionally requires every date. */
export const quarterSnapshotSchema = payloadSize.pipe(structure).superRefine((snapshot, context) => {
  const { memberIds } = checkReferences(snapshot, context);
  const reserves = new Set(snapshot.directions.filter((direction) => direction.kind === "reserve").map((direction) => direction.id));
  snapshot.directions.forEach((direction, index) => {
    if (direction.kind !== "reserve" && direction.memberPercents.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["directions", index, "memberPercents"], message: "Свои доли сотрудников задаются только для резерва" });
    }
    const seen = new Set<string>();
    direction.memberPercents.forEach((row, rowIndex) => {
      if (!memberIds.has(row.memberId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["directions", index, "memberPercents", rowIndex, "memberId"], message: "Участник не найден в этом плане" });
      }
      if (seen.has(row.memberId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["directions", index, "memberPercents", rowIndex, "memberId"], message: "Своя доля сотрудника указана дважды" });
      }
      seen.add(row.memberId);
    });
  });
  snapshot.tasks.forEach((task, index) => {
    if (reserves.has(task.directionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "directionId"], message: "Резерв не может содержать работы" });
    }
  });
});

function failure(error: z.ZodError): QuarterValidationFailure {
  return { ok: false, errors: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) };
}

function completeCalendar(snapshot: { year: number; quarter: Quarter; calendar: readonly unknown[] }): QuarterValidationFailure | null {
  return snapshot.calendar.length === getQuarterDates(snapshot.year, snapshot.quarter).length ? null
    : { ok: false, errors: [{ path: "calendar", code: "incomplete_calendar", message: "Для расчёта необходимо заполнить каждую дату квартала" }] };
}

export function validateQuarterSnapshot(
  input: unknown,
  options: { requireCompleteCalendar?: boolean } = {}
): QuarterValidationResult {
  const parsed = quarterSnapshotSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error);
  const snapshot: QuarterSnapshot = { ...parsed.data, quarter: parsed.data.quarter as Quarter };
  return (options.requireCompleteCalendar && completeCalendar(snapshot)) || { ok: true, snapshot };
}

/** Validates a quarter stored by 0.1.0–0.3.0 without converting it. */
export function validateQuarterSnapshotV1(input: unknown):
  { ok: true; snapshot: QuarterSnapshotV1 } | QuarterValidationFailure {
  const parsed = quarterSnapshotV1Schema.safeParse(input);
  if (!parsed.success) return failure(parsed.error);
  return { ok: true, snapshot: { ...parsed.data, quarter: parsed.data.quarter as Quarter } };
}
