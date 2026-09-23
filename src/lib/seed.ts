import {
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_LEAD_FOCUS_FACTOR,
  DEFAULT_MEMBER_FOCUS_FACTOR,
  DEFAULT_SPRINT_LENGTH_DAYS
} from "./types";
import { getDb } from "./db";

const competencies = ["SA", "BPMN", "Frontend", "Java", "Python", "QA", "DevOps", "Support"];

const buckets = [
  { name: "Продукт А", type: "product", share: 0.3 },
  { name: "Направление Б", type: "initiative", share: 0.2 },
  { name: "Поддержка", type: "support", share: 0.15 },
  { name: "База знаний", type: "support", share: 0.25 },
  { name: "Влеты", type: "support", share: 0.1 }
] as const;

const teamPlan = [
  ["SA", 1],
  ["BPMN", 6],
  ["Frontend", 2],
  ["Java", 4],
  ["Python", 1],
  ["DevOps", 1],
  ["QA", 5]
] as const;

export async function seedDatabase() {
  const db = await getDb();
  for (const [index, code] of competencies.entries()) {
    await db.execute("INSERT OR IGNORE INTO competencies (code, name, sort_order) VALUES ($1, $2, $3)", [
      code,
      code,
      index + 1
    ]);
  }

  const competencyRows = await db.select<Array<{ id: number; code: string }>>("SELECT id, code FROM competencies");
  const competencyIdByCode = new Map(competencyRows.map((item) => [item.code, item.id]));

  for (const [competencyCode, count] of teamPlan) {
    const competencyId = competencyIdByCode.get(competencyCode);
    if (!competencyId) continue;
    for (let index = 1; index <= count; index += 1) {
      const role = index === 1 && ["BPMN", "Java", "QA"].includes(competencyCode) ? "lead" : "member";
      const focus = role === "lead" ? DEFAULT_LEAD_FOCUS_FACTOR : DEFAULT_MEMBER_FOCUS_FACTOR;
      const fullName = `${competencyCode} ${String(index).padStart(2, "0")}`;
      await db.execute(
        `INSERT INTO employees (full_name, competency_id, role_type, fte, default_focus_factor)
         SELECT $1, $2, $3, 1.0, $4
         WHERE NOT EXISTS (SELECT 1 FROM employees WHERE full_name = $1)`,
        [fullName, competencyId, role, focus]
      );
    }
  }

  const months = [
    [2026, 4, 21],
    [2026, 5, 22],
    [2026, 6, 22]
  ];
  for (const [year, month, workingDays] of months) {
    await db.execute(
      `INSERT INTO calendar_months (year, month, working_days, hours_per_day, sprint_length_days)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(year, month) DO UPDATE SET
         working_days = excluded.working_days,
         hours_per_day = excluded.hours_per_day,
         sprint_length_days = excluded.sprint_length_days`,
      [year, month, workingDays, DEFAULT_HOURS_PER_DAY, DEFAULT_SPRINT_LENGTH_DAYS]
    );
  }

  for (const bucket of buckets) {
    await db.execute(
      `INSERT INTO project_buckets (name, type, is_active)
       SELECT $1, $2, 1
       WHERE NOT EXISTS (SELECT 1 FROM project_buckets WHERE name = $1)`,
      [bucket.name, bucket.type]
    );
  }

  const profileRows = await db.select<Array<{ count: number }>>(
    "SELECT COUNT(*) AS count FROM allocation_profiles WHERE name = 'Base 2026'"
  );
  if ((profileRows[0]?.count ?? 0) === 0) {
    const profile = await db.execute(
      "INSERT INTO allocation_profiles (name, valid_from, valid_to, created_at) VALUES ('Base 2026', '2026-04-01', NULL, datetime('now'))"
    );
    const profileId = Number(profile.lastInsertId);
    const bucketRows = await db.select<Array<{ id: number; name: string }>>("SELECT id, name FROM project_buckets");
    for (const bucket of buckets) {
      const bucketId = bucketRows.find((row) => row.name === bucket.name)?.id;
      if (bucketId) {
        await db.execute("INSERT INTO allocation_items (profile_id, bucket_id, share) VALUES ($1, $2, $3)", [
          profileId,
          bucketId,
          bucket.share
        ]);
      }
    }
  }
}
