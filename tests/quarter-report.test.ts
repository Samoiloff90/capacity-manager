import { describe, expect, it } from "vitest";
import { createQuarterCalendar } from "../src/domain/capacity/project-calendar";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import {
  buildQuarterReport, formatTimestamp, reportFileBaseName, ROUNDING_NOTE, SAVED_STATE_NOTE,
  type QuarterReport, type ReportCell, type ReportRow
} from "../src/export/quarter-report";
import { calculate, readmeQuarter } from "./fixtures/readme-quarter";

const exportedAt = new Date(2026, 9, 5, 9, 7);

function report(snapshot: QuarterSnapshot = readmeQuarter(), teamName = "Команда А"): QuarterReport {
  return buildQuarterReport({ teamName, snapshot, result: calculate(snapshot), exportedAt });
}

function value(cell: ReportCell): string | number | null {
  return cell.kind === "empty" ? null : cell.value;
}

function sheet(result: QuarterReport, name: string): ReportRow[] {
  const found = result.sheets.find((item) => item.name === name);
  if (!found) throw new Error(`Нет листа ${name}`);
  return found.rows;
}

function rows(result: QuarterReport, name: string): (string | number | null)[][] {
  return sheet(result, name).map((row) => row.cells.map(value));
}

function summary(result: QuarterReport): Map<string, string | number | null> {
  return new Map(sheet(result, "Сводка").map((row) => [String(value(row.cells[0])), value(row.cells[1])]));
}

describe("quarter report model: README scenario", () => {
  const result = report();

  it("has the sheets of the quarter planner and their columns (B-1)", () => {
    expect(result.sheets.map((item) => item.name)).toEqual(["Сводка", "Люди", "Компетенции", "Источники", "Работы", "Отсутствия"]);
    expect(result.sheets.map((item) => item.columns.map((column) => column.title))).toEqual([
      ["Показатель", "Значение"],
      ["Сотрудник", "Компетенция", "Ставка", "Рабочих дней", "Дней отсутствия", "Доступно дней", "Доступно часов"],
      ["Компетенция", "Сотрудников", "Доступно часов"],
      ["Источник", "Вид", "Доля, %", "Доля ёмкости фактически, %", "Бюджет, ч", "Занято в плане, ч", "В плане без оценки",
        "Остаток, ч", "Перебор, ч", "На рассмотрении", "Не в этом квартале", "Примечание"],
      ["Источник", "Работа", "Решение по плану", "Оценка, ч", "Занимает бюджет"],
      ["Сотрудник", "С", "По"]
    ]);
    for (const item of result.sheets) {
      for (const row of item.rows) expect(row.cells).toHaveLength(item.columns.length);
    }
  });

  it("summarises the quarter as the screen does: capacity, reserve, plan, rests, overrun, not allocated", () => {
    // 252 h; «Продукт» 20% = 50,4 h with 30 + 25 = 55 h in the plan: over by 4,6 h; «Встречи и прочее» 201,6 h free.
    expect([...summary(result)]).toEqual([
      ["Команда", "Команда А"],
      ["Период", "4 квартал 2026 года"],
      ["Дата выгрузки", "05.10.2026 09:07"],
      ["Состояние квартала", SAVED_STATE_NOTE],
      ["Календарь", "Производственный календарь РФ"],
      ["Ручных поправок календаря", 1],
      ["Рабочих дней", 65],
      ["Сотрудников", 1],
      ["Доступно команде, ч", "252"],
      ["Резерв, ч", "Не задан"],
      ["Занято работами в плане, ч", "55"],
      ["Работ в плане", 2],
      ["Работ в плане без оценки", 0],
      ["Остатки квот, ч", "201.6"],
      ["Перебор квот, ч", "4.6"],
      ["Источников с перебором", 1],
      ["Выделено источникам, ч", "252"],
      ["Выделено источникам, % ёмкости", "100%"],
      ["Не распределено, ч", "0"],
      ["Не распределено, % ёмкости", "0%"],
      ["Источников без доли", 0],
      ["Предупреждение", "Перебор квоты — «Продукт» 4,60 ч."],
      ["Примечание", ROUNDING_NOTE]
    ]);
    const tones = new Map(sheet(result, "Сводка").map((row) => [String(value(row.cells[0])), row.tone]));
    expect([tones.get("Перебор квот, ч"), tones.get("Источников с перебором"), tones.get("Предупреждение")]).toEqual(["deficit", "deficit", "deficit"]);
    expect(tones.get("Занято работами в плане, ч")).toBeUndefined();
  });

  it("lists people with a total row taken from the engine", () => {
    expect(rows(result, "Люди")).toEqual([
      ["Тестовый сотрудник", "Разработка", "0.5", 65, 2, 63, "252"],
      ["Итого", null, null, null, null, 63, "252"]
    ]);
    expect(sheet(result, "Люди")[1].emphasis).toBe("total");
    expect(rows(result, "Компетенции")).toEqual([["Разработка", 1, "252"]]);
  });

  it("shows each source with its kind, share, budget, use and rest, in snapshot order", () => {
    expect(rows(result, "Источники")).toEqual([
      ["Продукт", "Работы", "20", "20", "50.4", "55", 0, "0", "4.6", 0, 0, "Перебор 4,60 ч."],
      ["Встречи и прочее", "Работы", "80", "80", "201.6", "0", 0, "201.6", "0", 0, 0, "Остаток 201,60 ч."],
      ["Не распределено", null, null, "0%", "0", null, null, null, null, null, null, "Никому не выделено."]
    ]);
    expect(sheet(result, "Источники").map((row) => row.tone)).toEqual(["deficit", undefined, undefined]);
  });

  it("lists every work with its decision; absences in snapshot order", () => {
    expect(rows(result, "Работы")).toEqual([
      ["Продукт", "Задача 30", "В плане квартала", "30", "да"],
      ["Продукт", "Задача 25", "В плане квартала", "25", "да"]
    ]);
    expect(rows(result, "Отсутствия")).toEqual([["Тестовый сотрудник", "2026-10-01", "2026-10-02"]]);
  });

  it("builds a safe default file name", () => {
    expect(result.fileBaseName).toBe("Capacity Команда А 2026 Q4");
  });
});

describe("quarter report model: the rules of the quarter planner", () => {
  const work = (id: string, name: string, estimateHours: string | null, mark: "plan" | "candidate" | "out", directionId = "z-product") =>
    ({ id, name, directionId, estimateHours, mark, link: null, comment: null });
  const warnings = (result: QuarterReport) => sheet(result, "Сводка").filter((row) => value(row.cells[0]) === "Предупреждение");

  it("works on review or outside the quarter are listed with their decision and take no budget", () => {
    const result = report(readmeQuarter({ tasks: [
      work("t1", "Вне квартала", "100", "out"), work("t2", "Кандидат", "40", "candidate"), work("t3", "В плане", "20", "plan"),
      work("t4", "Кандидат без оценки", null, "candidate")
    ] }));
    expect(rows(result, "Работы")).toEqual([
      ["Продукт", "В плане", "В плане квартала", "20", "да"],
      ["Продукт", "Кандидат", "На рассмотрении", "40", "нет"],
      ["Продукт", "Кандидат без оценки", "На рассмотрении", "Без оценки", "нет"],
      ["Продукт", "Вне квартала", "Не в этом квартале", "100", "нет"]
    ]);
    // Only the 20 h in the plan are taken from 50,4 h: 30,4 h left.
    expect(rows(result, "Источники")[0]).toEqual(["Продукт", "Работы", "20", "20", "50.4", "20", 0, "30.4", "0", 2, 1, "Остаток 30,40 ч."]);
    expect(summary(result).get("Занято работами в плане, ч")).toBe("20");
    expect(summary(result).get("Работ в плане")).toBe(1);
  });

  it("a work in the plan without an estimate: «не менее», «не более» and a warning, not 0", () => {
    const result = report(readmeQuarter({ tasks: [...readmeQuarter().tasks, work("t3", "Без оценки", null, "plan")] }));
    const values = summary(result);
    expect(values.get("Занято работами в плане, не менее, ч")).toBe("55");
    expect(values.has("Занято работами в плане, ч")).toBe(false);
    expect(values.get("Работ в плане без оценки")).toBe(1);
    expect(values.get("Остатки квот, не более, ч")).toBe("201.6");
    expect(warnings(result).map((row) => [value(row.cells[1]), row.tone])).toEqual([
      ["Перебор квоты — «Продукт» не менее 4,60 ч.", "deficit"],
      ["В плане 1 работа без оценки: занятость — не менее указанной, остатки квот — не более.", "preliminary"]
    ]);
    expect(rows(result, "Работы")[2]).toEqual(["Продукт", "Без оценки", "В плане квартала", "Без оценки", "да, оценка неизвестна"]);
    expect(sheet(result, "Работы")[2].tone).toBe("preliminary");
    expect(rows(result, "Источники")[0].slice(6)).toEqual([1, "0", "4.6", 0, 0, "Перебор не менее 4,60 ч. В плане без оценки: 1 работа."]);
  });

  it("a sum of shares under 100% is not a problem: the rest is «Не распределено»", () => {
    const result = report(readmeQuarter({ directions: [
      { id: "z-product", name: "Продукт", percent: "20", kind: "work", memberPercents: [] },
      { id: "a-meetings", name: "Встречи и прочее", percent: "70", kind: "work", memberPercents: [] }
    ], tasks: [] }));
    const values = summary(result);
    expect([values.get("Выделено источникам, % ёмкости"), values.get("Не распределено, ч"), values.get("Не распределено, % ёмкости")]).toEqual(["90%", "25.2", "10%"]);
    expect(warnings(result)).toEqual([]);
    expect(sheet(result, "Сводка").every((row) => row.tone === undefined)).toBe(true);
    expect([...values.values()].join(" ")).not.toMatch(/Предварительный|вместо 100%/);
  });

  it("an excess of shares and an overrun below a hundredth stay visible (R-002)", () => {
    const result = report(readmeQuarter({ directions: [
      { id: "z-product", name: "Продукт", percent: "20", kind: "work", memberPercents: [] },
      { id: "a-meetings", name: "Встречи и прочее", percent: "80.0001", kind: "work", memberPercents: [] }
    ], tasks: [work("t1", "Почти весь бюджет", "50.401", "plan")] }));
    const values = summary(result);
    // 252 × 0,000001 = 0,000252 h over the capacity; 50,401 − 50,4 = 0,001 h over the quota.
    expect([values.get("Не распределено, ч"), values.get("Выделено источникам, % ёмкости"), values.get("Перебор квот, ч")]).toEqual(["-0.000252", "100,0001%", "0.001"]);
    const cells = new Map(sheet(result, "Сводка").map((row) => [String(value(row.cells[0])), row.cells[1]]));
    expect(cells.get("Не распределено, ч")).toEqual({ kind: "hours", value: "-0.000252", keepNonzero: true });
    expect(cells.get("Перебор квот, ч")).toEqual({ kind: "hours", value: "0.001", keepNonzero: true });
    expect(warnings(result).map((row) => value(row.cells[1]))).toEqual([
      "Сумма долей 100,0001%, на <0,01 ч больше доступной ёмкости.", "Перебор квоты — «Продукт» <0,01 ч."
    ]);
    expect(rows(result, "Источники")[0][11]).toBe("Перебор <0,01 ч.");
  });

  it("a reserve by person: the share and its owner per person, and how it is counted (DEC-038)", () => {
    const snapshot = readmeQuarter({
      members: [
        { id: "z-member", name: "Тестовый сотрудник", competencyId: "z-dev", fte: "0.5" },
        { id: "b-member", name: "Второй сотрудник", competencyId: "z-dev", fte: "1" }
      ],
      directions: [
        { id: "r-meet", name: "Встречи", percent: "30", kind: "reserve", memberPercents: [{ memberId: "b-member", percent: "40" }] },
        { id: "z-product", name: "Продукт", percent: "20", kind: "work", memberPercents: [] }
      ],
      tasks: []
    });
    const result = report(snapshot);
    // 252 h × 30% = 75,6 h and 520 h × 40% = 208 h: 283,6 h of reserve, 36,74% of 772 h.
    expect(result.sheets[1].columns.slice(7).map((column) => column.title)).toEqual(["«Встречи»: доля, %", "«Встречи»: чья доля", "«Встречи»: резерв, ч"]);
    expect(rows(result, "Люди")).toEqual([
      ["Тестовый сотрудник", "Разработка", "0.5", 65, 2, 63, "252", "30", "общая", "75.6"],
      ["Второй сотрудник", "Разработка", "1", 65, 0, 65, "520", "40", "своя", "208"],
      ["Итого", null, null, null, null, 128, "772", null, null, "283.6"]
    ]);
    const rule = "Резерв без работ: 30% доступных часов каждого сотрудника; своя доля — у 1 сотрудника. По людям — лист «Люди».";
    expect(rows(result, "Источники")[0]).toEqual(["Встречи", "Резерв", "30", "36.74", "283.6", null, null, null, null, null, null, rule]);
    const values = summary(result);
    expect(values.get("Резерв, ч")).toBe("283.6");
    expect(values.get("Как считается резерв «Встречи»")).toBe(rule);
  });

  it("a source without a share: no budget, works in its plan are named", () => {
    const result = report(readmeQuarter({ directions: [
      { id: "z-product", name: "Продукт", percent: null, kind: "work", memberPercents: [] },
      { id: "a-meetings", name: "Встречи и прочее", percent: "80", kind: "work", memberPercents: [] }
    ] }));
    expect(rows(result, "Источники")[0]).toEqual(["Продукт", "Работы", "не задана", null, null, "55", 0, null, null, 0, 0,
      "Доля не задана: работы в плане не сравниваются с бюджетом."]);
    expect(summary(result).get("Источников без доли")).toBe(1);
    expect(warnings(result).map((row) => value(row.cells[1])))
      .toEqual(["Доля не задана: «Продукт» — работы в плане не сравниваются с бюджетом."]);
    expect(rows(result, "Работы").map((row) => row[4])).toEqual(["да, доля источника не задана", "да, доля источника не задана"]);
  });

  it("handles an empty team without NaN", () => {
    const result = report(readmeQuarter({ members: [], absences: [], directions: [], tasks: [] }));
    expect(rows(result, "Люди")).toEqual([["Итого", null, null, null, null, 0, "0"]]);
    expect(rows(result, "Источники")).toEqual([["Не распределено", null, null, "100%", "0", null, null, null, null, null, null, "Никому не выделено."]]);
    for (const item of result.sheets) {
      for (const row of item.rows) {
        for (const cell of row.cells) {
          if (cell.kind === "count") expect(Number.isFinite(cell.value)).toBe(true);
          if (cell.kind === "hours" || cell.kind === "percent" || cell.kind === "rate") {
            expect(Number.isFinite(Number(cell.value))).toBe(true);
          }
        }
      }
    }
  });

  it("describes manual and unknown calendars", () => {
    const manual = createQuarterCalendar(2026, 4, "manual");
    if (!manual.ok) throw new Error(manual.message);
    const values = summary(report(readmeQuarter({ calendar: manual.calendar, calendarSource: manual.calendarSource })));
    expect(values.get("Календарь")).toBe("Ручной: основа — пятидневка без праздников и переносов");
    expect(values.get("Ручных поправок календаря")).toBe(0);
    const unknown = readmeQuarter();
    const legacy = summary(report({ ...unknown, calendarSource: undefined }));
    expect(legacy.get("Календарь")).toBe("Источник не указан");
    expect(legacy.get("Ручных поправок календаря")).toBe("Не выделены");
  });

  it("rejects a result of another quarter or with other rows", () => {
    const snapshot = readmeQuarter();
    const result = calculate(snapshot);
    expect(() => buildQuarterReport({ teamName: "А", snapshot: { ...snapshot, quarter: 3 }, result, exportedAt }))
      .toThrow("другому кварталу");
    expect(() => buildQuarterReport({ teamName: "А", snapshot: { ...snapshot, year: 2027 }, result, exportedAt }))
      .toThrow("другому кварталу");
    expect(() => buildQuarterReport({ teamName: "А", snapshot: { ...snapshot, members: [], absences: [] }, result, exportedAt }))
      .toThrow("не соответствует");
    expect(() => buildQuarterReport({ teamName: "А", snapshot, result, exportedAt: new Date(Number.NaN) }))
      .toThrow("дата выгрузки");
  });
});

describe("report file name and timestamp", () => {
  const forbidden = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/;
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it.each([
    ["Команда А", "Capacity Команда А 2026 Q4"],
    ['Команда: "A/B" <x>?*|\\', "Capacity Команда A B x 2026 Q4"],
    ["  Платформа\tи\nданные  ", "Capacity Платформа и данные 2026 Q4"],
    ["Команда...", "Capacity Команда 2026 Q4"],
    ["   ", "Capacity 2026 Q4"],
    ["\u0000\u0085...", "Capacity 2026 Q4"]
  ])("cleans %j", (team, expected) => {
    expect(reportFileBaseName(team, 2026, 4)).toBe(expected);
  });

  it("limits long names in UTF-16 units without splitting emoji", () => {
    const cyrillic = reportFileBaseName("Я".repeat(150), 2026, 4);
    expect(cyrillic).toBe(`Capacity ${"Я".repeat(100)} 2026 Q4`);
    const emoji = reportFileBaseName("😀".repeat(60), 2026, 4);
    expect(emoji).toBe(`Capacity ${"😀".repeat(50)} 2026 Q4`);
    for (const name of [cyrillic, emoji, reportFileBaseName("a" + "😀".repeat(60), 9999, 1)]) {
      expect(name.length).toBeLessThanOrEqual(200);
      expect(name).not.toMatch(forbidden);
      expect(name).not.toMatch(loneSurrogate);
      expect(name).not.toMatch(/[. ]$/);
    }
  });

  it("formats the export time in local time independent of the time zone", () => {
    expect(formatTimestamp(new Date(2026, 9, 5, 9, 7))).toBe("05.10.2026 09:07");
    expect(formatTimestamp(new Date(2026, 11, 31, 23, 59))).toBe("31.12.2026 23:59");
  });
});
