import { describe, expect, it } from "vitest";
import { createQuarterCalendar } from "../src/domain/capacity/project-calendar";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import {
  buildQuarterReport, formatTimestamp, reportFileBaseName, ROUNDING_NOTE,
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

  it("has the agreed sheets and columns", () => {
    expect(result.sheets.map((item) => item.name)).toEqual(["Сводка", "Люди", "Компетенции", "Направления", "Задачи", "Отсутствия"]);
    expect(result.sheets.map((item) => item.columns.map((column) => column.title))).toEqual([
      ["Показатель", "Значение"],
      ["Сотрудник", "Компетенция", "Ставка", "Рабочих дней", "Дней отсутствия", "Доступно дней", "Доступно часов"],
      ["Компетенция", "Сотрудников", "Доступно часов"],
      ["Направление", "Доля, %", "Бюджет, ч", "Потребность, ч", "Задач без оценки", "Остаток, ч", "Статус", "Примечание"],
      ["Задача", "Направление", "Оценка, ч"],
      ["Сотрудник", "С", "По"]
    ]);
    for (const item of result.sheets) {
      for (const row of item.rows) expect(row.cells).toHaveLength(item.columns.length);
    }
  });

  it("summarises a ready plan with engine totals", () => {
    expect([...summary(result)]).toEqual([
      ["Команда", "Команда А"],
      ["Период", "4 квартал 2026 года"],
      ["Дата выгрузки", "05.10.2026 09:07"],
      ["Статус плана", "Готовый"],
      ["Календарь", "Производственный календарь РФ"],
      ["Ручных поправок календаря", 1],
      ["Рабочих дней", 65],
      ["Сотрудников", 1],
      ["Доступно часов команды", "252"],
      ["Сумма долей, %", "100"],
      ["Потребность задач, ч", "55"],
      ["Задач без оценки", 0],
      ["Примечание", ROUNDING_NOTE]
    ]);
    expect(sheet(result, "Сводка").every((row) => row.tone === undefined)).toBe(true);
  });

  it("lists people with a total row taken from the engine", () => {
    expect(rows(result, "Люди")).toEqual([
      ["Тестовый сотрудник", "Разработка", "0.5", 65, 2, 63, "252"],
      ["Итого", null, null, null, null, 63, "252"]
    ]);
    expect(sheet(result, "Люди")[1].emphasis).toBe("total");
    expect(rows(result, "Компетенции")).toEqual([["Разработка", 1, "252"]]);
  });

  it("shows direction balances with the same texts as the screen, in snapshot order", () => {
    expect(rows(result, "Направления")).toEqual([
      ["Продукт", "20", "50.4", "55", 0, "-4.6", "Дефицит 4,60 ч", null],
      ["Встречи и прочее", "80", "201.6", "0", 0, "201.6", "Остаток 201,60 ч", null]
    ]);
    expect(sheet(result, "Направления").map((row) => row.tone)).toEqual(["deficit", undefined]);
  });

  it("keeps tasks and absences in snapshot order", () => {
    expect(rows(result, "Задачи")).toEqual([["Задача 30", "Продукт", "30"], ["Задача 25", "Продукт", "25"]]);
    expect(rows(result, "Отсутствия")).toEqual([["Тестовый сотрудник", "2026-10-01", "2026-10-02"]]);
  });

  it("builds a safe default file name", () => {
    expect(result.fileBaseName).toBe("Capacity Команда А 2026 Q4");
  });
});

describe("quarter report model: preliminary plans and edge cases", () => {
  it("marks a missing estimate as not estimated and the plan as preliminary", () => {
    const snapshot = readmeQuarter();
    const result = report(readmeQuarter({ tasks: [
      ...snapshot.tasks, { id: "t3", name: "Без оценки", directionId: "z-product", estimateHours: null }
    ] }));
    const values = summary(result);
    expect(values.get("Статус плана")).toBe("Предварительный");
    expect(values.get("Причины")).toBe("Задач без оценки: 1.");
    expect(values.get("Известная потребность задач, ч")).toBe("55");
    expect(values.has("Потребность задач, ч")).toBe(false);
    const statusRows = sheet(result, "Сводка").filter((row) =>
      ["Статус плана", "Причины", "Известная потребность задач, ч"].includes(String(value(row.cells[0]))));
    expect(statusRows.map((row) => row.tone)).toEqual(["preliminary", "preliminary", "preliminary"]);
    expect(rows(result, "Задачи")[2]).toEqual(["Без оценки", "Продукт", "Не оценена"]);
    expect(sheet(result, "Задачи")[2].tone).toBe("preliminary");
    const [product] = rows(result, "Направления");
    expect(product.slice(4, 8)).toEqual([1, "-4.6", "Дефицит не менее 4,60 ч", "Задач без оценки: 1. Потребность неполная."]);
    expect(sheet(result, "Направления")[0].tone).toBe("deficit");
  });

  it("keeps a sub-cent deficit visible", () => {
    const result = report(readmeQuarter({ tasks: [
      { id: "t1", name: "Почти весь бюджет", directionId: "z-product", estimateHours: "50.401" }
    ] }));
    const [product] = rows(result, "Направления");
    expect(product[5]).toBe("-0.001");
    expect(product[6]).toBe("Дефицит <0,01 ч");
    expect(sheet(result, "Направления")[0].tone).toBe("deficit");
  });

  it("explains an allocation that is not 100%", () => {
    const result = report(readmeQuarter({ directions: [
      { id: "z-product", name: "Продукт", percent: "20" }, { id: "a-meetings", name: "Встречи и прочее", percent: "70" }
    ] }));
    expect(summary(result).get("Причины")).toBe("Сумма долей направлений 90% вместо 100%.");
    expect(sheet(result, "Направления").map((row) => row.tone)).toEqual(["deficit", "preliminary"]);
    expect(rows(result, "Направления")[1][6]).toBe("Предварительный остаток 176,40 ч");
  });

  it("handles an empty team without NaN", () => {
    const result = report(readmeQuarter({ members: [], absences: [], directions: [], tasks: [] }));
    expect(summary(result).get("Причины")).toBe("Направления не заданы.");
    expect(rows(result, "Люди")).toEqual([["Итого", null, null, null, null, 0, "0"]]);
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
