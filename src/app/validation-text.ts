import type { QuarterValidationIssue } from "../domain/capacity/quarter-capacity.types";

function fieldLabel(path: string): string {
  const [collection, row, field] = path.split(".");
  const section: Record<string, string> = {
    members: "Сотрудник", competencies: "Компетенция", absences: "Отсутствие",
    directions: "Направление", tasks: "Задача", calendar: "Календарь"
  };
  const fields: Record<string, string> = {
    name: "название или имя", fte: "ставка", percent: "доля", competencyId: "компетенция",
    memberId: "сотрудник", startDate: "дата начала", endDate: "дата окончания", date: "дата",
    directionId: "направление", estimateHours: "оценка в часах"
  };
  const label = section[collection] ?? "Данные квартала";
  return `${label}${row !== undefined && /^\d+$/.test(row) ? ` ${Number(row) + 1}` : ""}${fields[field] ? `, ${fields[field]}` : ""}`;
}

/** One readable line per issue: which row and field, then what to fix. */
export function describeValidationIssue(issue: QuarterValidationIssue): string {
  const message = issue.message.includes("каноническое")
    ? "введите число; дробную часть можно отделить запятой или точкой."
    : issue.message;
  return `${fieldLabel(issue.path)}: ${message}`;
}
