import { z } from "zod";
import { getQuarterDates, isCalendarDate, isCalendarYear, Quarter } from "./calendar-quarter";
import { compareDecimal, isCanonicalDecimal, MAX_DECIMAL_INPUT_CHARACTERS, parseDecimal } from "./decimal-exact";
import type { QuarterSnapshot, QuarterValidationResult } from "./quarter-capacity.types";

/** Technical payload protection; these are not team-size or decimal-precision business limits. */
export const QUARTER_INPUT_LIMITS = {
  decimalCharacters: MAX_DECIMAL_INPUT_CHARACTERS,
  idCharacters: 128,
  nameCharacters: 1000,
  entitiesPerCollection: 10000
} as const;

const id = z.string().min(1).max(QUARTER_INPUT_LIMITS.idCharacters)
  .refine((value) => value.trim() === value, "ID не должен содержать пробелы по краям");
const name = z.string().max(QUARTER_INPUT_LIMITS.nameCharacters)
  .refine((value) => value.trim().length > 0, "Укажите название или имя");
const date = z.string().refine(isCalendarDate, "Укажите существующую дату в формате ГГГГ-ММ-ДД");

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

const structure = z.object({
  year: z.number().refine(isCalendarYear, "Год должен помещаться в формат ГГГГ: от 0001 до 9999"),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  calendar: z.array(z.object({ date, isWorking: z.boolean() }).strict()).max(92),
  competencies: z.array(z.object({ id, name }).strict()),
  members: z.array(z.object({ id, name, competencyId: id, fte: nonnegativeDecimal("1") }).strict()),
  absences: z.array(z.object({ id, memberId: id, startDate: date, endDate: date }).strict()),
  directions: z.array(z.object({ id, name, percent: nonnegativeDecimal("100") }).strict()),
  tasks: z.array(z.object({ id, name, directionId: id, estimateHours: nonnegativeDecimal().nullable() }).strict())
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
});

/** Storage validation allows a calendar being prepared; computation additionally requires every date. */
export const quarterSnapshotSchema = payloadSize.pipe(structure).superRefine((snapshot, context) => {
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

  if (!isCalendarYear(snapshot.year)) return;
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
});

export function validateQuarterSnapshot(
  input: unknown,
  options: { requireCompleteCalendar?: boolean } = {}
): QuarterValidationResult {
  const parsed = quarterSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) };
  }
  const snapshot: QuarterSnapshot = { ...parsed.data, quarter: parsed.data.quarter as Quarter };
  if (options.requireCompleteCalendar && snapshot.calendar.length !== getQuarterDates(snapshot.year, snapshot.quarter).length) {
    return { ok: false, errors: [{ path: "calendar", code: "incomplete_calendar", message: "Для расчёта необходимо заполнить каждую дату квартала" }] };
  }
  return { ok: true, snapshot };
}
