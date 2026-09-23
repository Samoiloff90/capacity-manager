import { describe, expect, it } from "vitest";
import { calculateMonthlyCapacity } from "../src/lib/capacity";
import { CapacityDataSource } from "../src/lib/types";

const source: CapacityDataSource = {
  async getCalendarMonth() {
    return { id: 1, year: 2026, month: 4, working_days: 22, hours_per_day: 8, sprint_length_days: 10 };
  },
  async getActiveEmployees() {
    return [
      {
        id: 1,
        full_name: "Java Lead",
        competency_id: 1,
        role_type: "lead",
        fte: 1,
        default_focus_factor: 0.6,
        is_active: 1
      },
      {
        id: 2,
        full_name: "QA Member",
        competency_id: 2,
        role_type: "member",
        fte: 1,
        default_focus_factor: 0.7,
        is_active: 1
      }
    ];
  },
  async getCompetencies() {
    return [
      { id: 1, code: "Java", name: "Java", sort_order: 1 },
      { id: 2, code: "QA", name: "QA", sort_order: 2 }
    ];
  },
  async getAbsencesForMonth() {
    return [{ id: 1, employee_id: 2, start_date: "2026-04-06", end_date: "2026-04-10", type: "vacation" }];
  },
  async getActiveAllocationProfile() {
    return { id: 1, name: "Base", valid_from: "2026-04-01", valid_to: null, created_at: "2026-04-01" };
  },
  async getAllocationItems() {
    return [
      { id: 1, profile_id: 1, bucket_id: 1, bucket_name: "Product", share: 0.7 },
      { id: 2, profile_id: 1, bucket_id: 2, bucket_name: "Support", share: 0.3 }
    ];
  },
  async getActualWorkForMonth() {
    return [
      {
        id: 1,
        title: "Task",
        employee_id: 1,
        bucket_id: 1,
        competency_id: 1,
        work_date: "2026-04-08",
        spent_hours: 80
      }
    ];
  }
};

describe("calculateMonthlyCapacity", () => {
  it("calculates focused capacity, absences, bucket plan and fact", async () => {
    const result = await calculateMonthlyCapacity(1, source);

    expect(result.month).toBe("2026-04");
    expect(result.totalFte).toBe(2);
    expect(result.byEmployee[0].focusedDays).toBe(13.2);
    expect(result.byEmployee[1].absenceDays).toBe(5);
    expect(result.byEmployee[1].focusedHours).toBe(95.2);
    expect(result.totalFocusedHours).toBe(200.8);
    expect(result.byBucket[0].plannedHours).toBe(140.56);
    expect(result.byBucket[0].actualHours).toBe(80);
    expect(result.byBucket[0].varianceHours).toBe(-60.56);
    expect(result.utilizationRate).toBe(0.3984);
  });

  it("warns when allocation is not 100 percent", async () => {
    const brokenSource: CapacityDataSource = {
      ...source,
      async getAllocationItems() {
        return [{ id: 1, profile_id: 1, bucket_id: 1, bucket_name: "Only one", share: 0.5 }];
      }
    };

    const result = await calculateMonthlyCapacity(1, brokenSource);

    expect(result.warnings.some((warning) => warning.type === "allocation_sum")).toBe(true);
  });
});
