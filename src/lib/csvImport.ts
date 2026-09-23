import Papa from "papaparse";
import { repository } from "./db";
import { ActualWorkItem } from "./types";

type CsvRow = {
  external_id?: string;
  title?: string;
  assignee?: string;
  bucket?: string;
  competency?: string;
  work_date?: string;
  spent_hours?: string;
  estimate_hours?: string;
  status?: string;
};

export async function importActualWorkCsv(content: string) {
  const parsed = Papa.parse<CsvRow>(content, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message);
  }

  const [employees, buckets, competencies] = await Promise.all([
    repository.getEmployees(),
    repository.getBuckets(),
    repository.getCompetencies()
  ]);
  const employeeByName = new Map(employees.map((item) => [item.full_name.toLowerCase(), item]));
  const bucketByName = new Map(buckets.map((item) => [item.name.toLowerCase(), item]));
  const competencyByCode = new Map(competencies.map((item) => [item.code.toLowerCase(), item]));

  const items: Array<Omit<ActualWorkItem, "id">> = parsed.data.map((row, index) => {
    if (!row.title || !row.work_date) {
      throw new Error(`CSV row ${index + 2}: title and work_date are required`);
    }
    const employee = row.assignee ? employeeByName.get(row.assignee.toLowerCase()) : undefined;
    const bucket = row.bucket ? bucketByName.get(row.bucket.toLowerCase()) : undefined;
    const competency = row.competency ? competencyByCode.get(row.competency.toLowerCase()) : undefined;
    return {
      external_source: "csv",
      external_id: row.external_id ?? null,
      title: row.title,
      employee_id: employee?.id ?? null,
      bucket_id: bucket?.id ?? null,
      competency_id: competency?.id ?? employee?.competency_id ?? null,
      work_date: row.work_date,
      spent_hours: Number(row.spent_hours ?? 0),
      estimate_hours: row.estimate_hours ? Number(row.estimate_hours) : null,
      status: row.status ?? null
    };
  });

  await repository.insertActualWork(items);
  return items.length;
}
