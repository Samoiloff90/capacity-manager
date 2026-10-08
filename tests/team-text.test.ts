import { describe, expect, it } from "vitest";
import { describeCompetencyInUse } from "../src/app/validation-text";

describe("why a competency cannot be deleted (DEC-050)", () => {
  it("says how many people have it, with the real number", () => {
    expect(describeCompetencyInUse(1)).toBe("Компетенция назначена одному сотруднику. Сначала назначьте ему другую компетенцию.");
    expect(describeCompetencyInUse(3)).toBe("Компетенция назначена трём сотрудникам. Сначала измените их компетенцию.");
    expect(describeCompetencyInUse(5)).toBe("Компетенция назначена 5 сотрудникам. Сначала измените их компетенцию.");
    expect(describeCompetencyInUse(21)).toBe("Компетенция назначена 21 сотруднику. Сначала измените их компетенцию.");
    expect(describeCompetencyInUse(11)).toBe("Компетенция назначена 11 сотрудникам. Сначала измените их компетенцию.");
  });
});
