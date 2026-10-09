import { describe, expect, it } from "vitest";
import { calculateQuarterCapacity } from "../src/domain/capacity/quarter-capacity.calculator";
import type { QuarterSnapshot } from "../src/domain/capacity/quarter-capacity.types";
import { validateQuarterSnapshot } from "../src/domain/capacity/quarter-snapshot.validation";
import { describeBatchInclusion } from "../src/domain/capacity/source-plan";
import { formatScreenHours } from "../src/domain/capacity/input-format";
import { parseTableText, toTableText } from "../src/import/table-text";
import {
  applyImport, changedSinceImport, createImportDraft, describeGroup, guessRoles, headerField, parseImportEstimate,
  pendingRowCount, previewImport, removeImported, setColumnRole, setHasHeader, setRowChecked, setRowSource, setRowText,
  skippedTableText, sourceLabels, withoutEstimate, type ImportBatch, type ImportDraft, type PreviewRow
} from "../src/import/work-import";
import { currentDemoQuarter } from "./fixtures/demo-projects";
import { IMPORT_TEMPLATE_ROWS, templateClipboardText } from "./fixtures/import-template";

const hours = formatScreenHours;
let counter = 0;
const newId = () => `new-${++counter}`;

function draftOf(text: string, sourceId: string | null = "src-requests", snapshot: QuarterSnapshot = currentDemoQuarter()): ImportDraft {
  return createImportDraft({ planId: "plan-1", sourceId, text, snapshot });
}
const rowAt = (rows: readonly PreviewRow[], line: number) => {
  const row = rows.find((item) => item.line === line);
  if (!row) throw new Error(`Нет строки ${line}`);
  return row;
};
const levels = (row: PreviewRow) => row.issues.map((issue) => issue.level);

describe("parseTableText: rows as Excel, Google Sheets and Numbers copy them", () => {
  it("splits cells by tabs and rows by CRLF, LF or CR; the last line break adds no row", () => {
    expect(parseTableText("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseTableText("a\tb\nc\td")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseTableText("a\rb\r")).toEqual([["a"], ["b"]]);
    expect(parseTableText("a\t\tc\n\nd")).toEqual([["a", "", "c"], [""], ["d"]]);
    expect(parseTableText("")).toEqual([]);
  });

  it("reads quoted cells with line breaks, tabs and doubled quotes inside", () => {
    expect(parseTableText("\"две\nстроки\"\t\"с \"\"кавычками\"\"\"\t\"таб\tвнутри\"\r\nx")).toEqual([
      ["две\nстроки", "с \"кавычками\"", "таб\tвнутри"], ["x"]
    ]);
  });

  it("keeps quotes the user typed: Excel quotes only cells with a tab, a line break or a quote", () => {
    expect(parseTableText("\"Срочно\"\tб")).toEqual([["\"Срочно\"", "б"]]);
  });

  it("keeps text that only looks quoted as typed", () => {
    expect(parseTableText("\"Витрина\" 2.0\tб")).toEqual([["\"Витрина\" 2.0", "б"]]);
    expect(parseTableText("\"незакрытая\tб")).toEqual([["\"незакрытая", "б"]]);
    expect(parseTableText("a\"b\tc")).toEqual([["a\"b", "c"]]);
  });

  it("writes the same text back for a spreadsheet", () => {
    const rows = [["две\nстроки", "с \"кавычками\""], ["таб\tвнутри", ""]];
    expect(parseTableText(toTableText(rows))).toEqual(rows);
  });
});

describe("columns: by the header row, otherwise by the content", () => {
  it("names fields by the header's first word, then by any word", () => {
    expect(headerField("Название работы")).toBe("name");
    expect(headerField("Оценка, ч")).toBe("estimate");
    expect(headerField("Полная оценка, ч")).toBe("estimate");
    expect(headerField("Трудоёмкость")).toBe("estimate");
    expect(headerField("Ссылка на Kaiten")).toBe("link");
    expect(headerField("Kaiten")).toBe("link");
    expect(headerField("Прим.")).toBe("comment");
    expect(headerField("Заказчик")).toBe("source");
    expect(headerField("Приоритет")).toBeNull();
    expect(headerField("Размер")).toBeNull();
  });

  it("finds the header row and the columns of the template", () => {
    const draft = draftOf(templateClipboardText());
    expect(draft.hasHeader).toBe(true);
    expect(draft.roles).toEqual(["name", "estimate", "link", "comment", "source"]);
    expect(draft.lines[1]).toBe(2);
  });

  it("without a header reads links, hours or sizes, source names and text", () => {
    const text = "Отчёт\t28\thttps://kaiten.example.com/c/1\tЗапросы УИ\tсрочно\nСправочник\tM\t\tТехдолг\tпосле релиза\n";
    const draft = draftOf(text);
    expect(draft.hasHeader).toBe(false);
    expect(draft.roles).toEqual(["name", "estimate", "link", "source", "comment"]);
  });

  it("a header the app does not know is not loaded, and the user can change any column", () => {
    const draft = draftOf("Задача\tПриоритет\tЧасы\nОтчёт\tвысокий\t28\n");
    expect(draft.roles).toEqual(["name", "skip", "estimate"]);
    const swapped = setColumnRole(draft, 1, "name");
    expect(swapped.roles).toEqual(["skip", "name", "estimate"]);
    expect(previewImport(swapped, currentDemoQuarter()).rows[0].values.name).toBe("высокий");
    const noHeader = setHasHeader(draft, false, currentDemoQuarter());
    expect(previewImport(noHeader, currentDemoQuarter()).rows.map((row) => row.line)).toEqual([1, 2]);
  });

  it("never reads sizes, points or card numbers as hours (DEC-041)", () => {
    const sized = draftOf("Название\tРазмер\nОтчёт\t5\nСправочник\t8\n");
    expect([sized.hasHeader, sized.roles]).toEqual([true, ["name", "skip"]]);
    expect(previewImport(sized, currentDemoQuarter()).noEstimateColumn).toBe(true);
    expect(draftOf("Задача\tStory points\nОтчёт\t5\n").roles).toEqual(["name", "skip"]);
    const kaiten = draftOf("ID\tНазвание\tРазмер\n101\tОтчёт\t5\n102\tСправочник\t8\n");
    expect([kaiten.hasHeader, kaiten.roles]).toEqual([true, ["skip", "name", "skip"]]);
    // Without a header: two number columns — none is guessed; ascending numbers are identifiers.
    expect(draftOf("101\tОтчёт\t5\n102\tСправочник\t8\n103\tКаталог\t13\n").roles).toEqual(["skip", "name", "skip"]);
    expect(draftOf("Отчёт\t101\nСправочник\t102\nКаталог\t103\n").roles).toEqual(["name", "skip"]);
    expect(draftOf("Отчёт\t28\nСправочник\t12\nКаталог\t40\n").roles).toEqual(["name", "estimate"]);
  });

  it("does not take a work that starts with a field word for a header row", () => {
    for (const text of ["Работа с обращениями\t\tсрочно\nОтчёт\t28\t\n", "Карточка товара: новые фото\nОтчёт\n",
      "Оценка рисков\tM\nОтчёт\t28\n", "Описание API\t\nОтчёт\t\n"]) {
      const draft = draftOf(text);
      expect(draft.hasHeader, text).toBe(false);
      expect(previewImport(draft, currentDemoQuarter()).rows.length, text).toBe(2);
    }
    expect(draftOf("Название работы\nОтчёт\n").hasHeader).toBe(true);
  });

  it("guesses for an empty table without failing", () => {
    expect(guessRoles([], false, 0, currentDemoQuarter())).toEqual([]);
    const draft = draftOf("\n\n");
    expect(draft.cells).toEqual([]);
    expect(previewImport(draft, currentDemoQuarter()).rows).toEqual([]);
  });
});

describe("estimates: hours only (DEC-041, DEC-043)", () => {
  it("reads hours as the work form does, and thousands as Excel shows them", () => {
    expect(parseImportEstimate("28")).toEqual({ kind: "hours", hours: "28" });
    expect(parseImportEstimate("12,5 ч")).toEqual({ kind: "hours", hours: "12.5" });
    expect(parseImportEstimate("1 200")).toEqual({ kind: "hours", hours: "1200" });
    expect(parseImportEstimate("1 200,5")).toEqual({ kind: "hours", hours: "1200.5" });
    expect(parseImportEstimate("")).toEqual({ kind: "empty" });
    expect(parseImportEstimate("0")).toEqual({ kind: "hours", hours: "0" });
  });

  it("does not guess whether «1,200» is thousands or a fraction", () => {
    for (const text of ["1,200", "1.200", "12,500", "1.200.000", "1,200 ч"]) {
      expect(parseImportEstimate(text)).toMatchObject({ kind: "invalid", message: expect.stringContaining("тысячи это или дробная часть") });
    }
    expect(parseImportEstimate("0,125")).toEqual({ kind: "hours", hours: "0.125" });
    expect(parseImportEstimate("1,25")).toEqual({ kind: "hours", hours: "1.25" });
    expect(parseImportEstimate("1200")).toEqual({ kind: "hours", hours: "1200" });
  });

  it("never turns a size or a duration into hours, and never into 0", () => {
    for (const text of ["M", "XL", "М", "2-3 дня", "-5", "12 345 678 9"]) expect(parseImportEstimate(text).kind).toBe("invalid");
  });
});

describe("preview of the template (the rules of DEC-039, DEC-043 and DEC-050)", () => {
  const snapshot = currentDemoQuarter();
  const preview = previewImport(draftOf(templateClipboardText()), snapshot);

  it("says about every row what the template expects", () => {
    expect(preview.rows).toHaveLength(IMPORT_TEMPLATE_ROWS.length);
    IMPORT_TEMPLATE_ROWS.forEach((template, index) => {
      const row = rowAt(preview.rows, index + 2);
      const worst = row.blocked ? "error" : row.repeat ? "repeat" : levels(row).includes("warning") ? "warning" : levels(row).includes("note") ? "note" : "ok";
      expect(worst, `строка ${index + 2}: ${template.rule}`).toBe(template.expect);
      expect(row.checked).toBe(template.expect !== "error" && template.expect !== "repeat");
    });
  });

  it("explains each problem next to its field", () => {
    expect(rowAt(preview.rows, 4).issues[0]).toEqual({ level: "error", field: "estimate", text: "«M» — размер, а нужны часы. Размеры в часы не переводятся.", withoutEstimate: true });
    expect(rowAt(preview.rows, 5).issues[0]).toMatchObject({ field: "estimate", withoutEstimate: true });
    expect(rowAt(preview.rows, 6).issues[0].text).toBe("Указана нулевая трудоёмкость. Если оценка неизвестна, очистите поле.");
    expect(rowAt(preview.rows, 7).issues[0]).toEqual({ level: "warning", field: "estimate", text: "Без оценки." });
    expect(rowAt(preview.rows, 8).issues.at(-1)!.text).toBe("Ссылка уже есть у работы «Корзина: промокоды» («Продукт «Витрина»», в плане квартала).");
    expect(rowAt(preview.rows, 9).issues.at(-1)!.text).toBe("Та же ссылка, что в строке 2.");
    expect(rowAt(preview.rows, 10).issues[0].text).toBe("Источника «Маркетинг» нет в этом квартале. Источники при загрузке не создаются: выберите существующий.");
    expect(rowAt(preview.rows, 11).issues[0]).toEqual({ level: "error", field: "name", text: "Нет названия." });
    expect(rowAt(preview.rows, 12).issues.at(-1)!.text).toBe("Такая работа уже есть: «Тёмная тема» («Мобильное приложение», в плане квартала).");
    expect(rowAt(preview.rows, 13).issues.at(-1)!.text).toBe("Работа с таким названием уже есть: «Права доступа для отдела кадров» («Запросы УИ», в плане квартала).");
    expect(rowAt(preview.rows, 14).issues[0].field).toBe("link");
    expect(rowAt(preview.rows, 14).estimate).toBe("1200");
    expect(rowAt(preview.rows, 14).values.comment).toBe("Две строки в одной ячейке");
    expect(rowAt(preview.rows, 15).issues[0].text).toBe("«Встречи и ритуалы» — резерв: работы в него не добавляются. Выберите источник работ.");
  });

  it("sums the ticked rows by source, keeping missing estimates apart from 0", () => {
    expect(preview.groups.map((group) => [group.sourceId, describeGroup(group, hours)])).toEqual([
      ["src-requests", "3 работы: 140,50 ч"],
      ["src-mobile", "1 работа: 1 без оценки"],
      ["src-debt", "1 работа: 0 ч"]
    ]);
  });
});

describe("the control example of DEC-041 through an import", () => {
  it("one work of 28 h into the plan of «Запросы УИ»: 228 h planned, 22 h left; then 34 h: 234 and 16", () => {
    const snapshot = currentDemoQuarter();
    const draft = { ...draftOf("Отчёт по возвратам\t28\n"), mark: "plan" as const };
    const preview = previewImport(draft, snapshot);
    const source = calculateQuarterCapacity(snapshot);
    if (!source.ok) throw new Error("расчёт");
    const requests = source.result.directions.find((row) => row.directionId === "src-requests")!;
    expect(describeBatchInclusion(requests, preview.groups[0].estimates, hours)).toEqual({ text: "Остаток квоты станет 22 ч (сейчас остаток 50 ч).", tone: "fits" });

    const { works, rest } = applyImport(draft, snapshot, newId);
    expect(rest).toBeNull();
    expect(works).toEqual([{ id: expect.any(String), name: "Отчёт по возвратам", directionId: "src-requests", estimateHours: "28", mark: "plan", link: null, comment: null }]);
    const after = { ...snapshot, tasks: [...snapshot.tasks, ...works] };
    const calculated = calculateQuarterCapacity(after);
    if (!calculated.ok) throw new Error("расчёт");
    const row = calculated.result.directions.find((item) => item.directionId === "src-requests")!;
    expect([row.knownDemandHours, row.remainingKnownHours]).toEqual(["228", "22"]);

    const edited = { ...after, tasks: after.tasks.map((task) => task.id === works[0].id ? { ...task, estimateHours: "34" } : task) };
    const again = calculateQuarterCapacity(edited);
    if (!again.ok) throw new Error("расчёт");
    const changed = again.result.directions.find((item) => item.directionId === "src-requests")!;
    expect([changed.knownDemandHours, changed.remainingKnownHours]).toEqual(["234", "16"]);
  });

  it("names the consequence of several works with and without estimates", () => {
    const snapshot = currentDemoQuarter();
    const calculated = calculateQuarterCapacity(snapshot);
    if (!calculated.ok) throw new Error("расчёт");
    const mobile = calculated.result.directions.find((row) => row.directionId === "src-mobile")!;
    expect(describeBatchInclusion(mobile, ["12", null], hours)).toEqual({ text: "Перебор квоты вырастет с 20 ч до не менее 32 ч.", tone: "over" });
    expect(describeBatchInclusion(mobile, [null], hours).text).toBe("Перебор квоты останется не менее 20 ч.");
    const requests = calculated.result.directions.find((row) => row.directionId === "src-requests")!;
    expect(describeBatchInclusion(requests, ["40", null], hours)).toEqual({ text: "Остаток квоты станет не более 10 ч (сейчас остаток 50 ч).", tone: "unknown" });
    expect(describeBatchInclusion(requests, ["60"], hours).text).toBe("Квота будет превышена: перебор 10 ч (сейчас остаток 50 ч).");
  });
});

describe("fixing rows in the preview", () => {
  const snapshot = currentDemoQuarter();

  it("«Добавить без оценки» keeps the size in the comment and never makes it 0", () => {
    const draft = draftOf(templateClipboardText());
    const row = rowAt(previewImport(draft, snapshot).rows, 4);
    const fixed = withoutEstimate(draft, row);
    const after = rowAt(previewImport(fixed, snapshot).rows, 4);
    expect(after.blocked).toBe(false);
    expect(after.checked).toBe(true);
    expect(after.estimate).toBeNull();
    expect(after.values.comment).toBe("исходная оценка: M");
    const withComment = rowAt(previewImport(withoutEstimate(fixed, rowAt(previewImport(fixed, snapshot).rows, 5)), snapshot).rows, 5);
    expect(withComment.values.comment).toBe("исходная оценка: 2-3 дня");
  });

  it("a fixed name, link or source makes the row ready; a source is chosen from the existing ones", () => {
    let draft = draftOf(templateClipboardText());
    draft = setRowText(draft, 10, "name", "Профилирование сборки");
    draft = setRowText(draft, 13, "link", "https://kaiten.example.com/space/12/card/207");
    draft = setRowSource(draft, 9, "src-product");
    draft = setRowSource(draft, 14, "src-debt");
    const rows = previewImport(draft, snapshot).rows;
    for (const line of [10, 11, 14, 15]) expect(rowAt(rows, line).checked, `строка ${line}`).toBe(true);
    expect(rowAt(rows, 10).sourceId).toBe("src-product");
  });

  it("a repeat can be ticked on purpose, and any row can be unticked", () => {
    let draft = draftOf(templateClipboardText());
    draft = setRowChecked(draft, 7, true);
    draft = setRowChecked(draft, 1, false);
    const rows = previewImport(draft, snapshot).rows;
    expect(rowAt(rows, 8).checked).toBe(true);
    expect(rowAt(rows, 2).checked).toBe(false);
    // An error cannot be ticked.
    expect(rowAt(previewImport(setRowChecked(draft, 10, true), snapshot).rows, 11).checked).toBe(false);
  });

  it("rows without a source column go to the open source; from the table of sources one must be chosen", () => {
    expect(previewImport(draftOf("Отчёт\t28\n"), snapshot).rows[0].sourceId).toBe("src-requests");
    const overview = previewImport(draftOf("Отчёт\t28\n", null), snapshot).rows[0];
    expect(overview.issues[0]).toEqual({ level: "error", field: "source", text: "Не указан источник." });
    expect(previewImport({ ...draftOf("Отчёт\t28\n", null), sourceId: "src-debt" }, snapshot).rows[0].sourceId).toBe("src-debt");
    // A reserve is not a place for works, even as the default.
    expect(previewImport(draftOf("Отчёт\t28\n", "src-meetings"), snapshot).rows[0].blocked).toBe(true);
  });

  it("a similar name in the same source warns, in another source does not", () => {
    const rows = previewImport(draftOf("Задача\tЧасы\tИсточник\nРевизия\t4\tТехдолг\nревизия \t6\tТехдолг\nРевизия\t4\tЗапросы УИ\nРевизия\t4\tТехдолг\n"), snapshot).rows;
    expect(rowAt(rows, 3).issues).toEqual([{ level: "warning", field: "name", text: "Такое же название в строке 2." }]);
    expect(rowAt(rows, 4).issues).toEqual([]);
    // The same name, hours and link once more is a repeat: unticked.
    expect(rowAt(rows, 5).issues).toEqual([{ level: "repeat", field: "name", text: "Повтор строки 2." }]);
  });
});

describe("the chosen source is never replaced (R-004, R-005)", () => {
  type Source = QuarterSnapshot["directions"][number];
  const without = (snapshot: QuarterSnapshot, id: string): QuarterSnapshot => ({
    ...snapshot, directions: snapshot.directions.filter((item) => item.id !== id), tasks: snapshot.tasks.filter((task) => task.directionId !== id)
  });
  const asReserve = (snapshot: QuarterSnapshot, id: string): QuarterSnapshot => ({
    ...snapshot, directions: snapshot.directions.map((item) => item.id === id ? { ...item, kind: "reserve" } : item),
    tasks: snapshot.tasks.filter((task) => task.directionId !== id)
  });
  const withSource = (snapshot: QuarterSnapshot, source: Source): QuarterSnapshot => ({ ...snapshot, directions: [...snapshot.directions, source] });
  const debtPlanned = (snapshot: QuarterSnapshot) => {
    const result = calculateQuarterCapacity(snapshot);
    if (!result.ok) throw new Error("расчёт");
    return result.result.directions.find((row) => row.directionId === "src-debt")!.knownDemandHours;
  };

  it("QA-I04: a chosen source deleted or made a reserve stops the row; it does not fall back to the column", () => {
    const snapshot = currentDemoQuarter();
    // The column says «Техдолг»; the user chose «Продукт «Витрина»» on purpose, for the plan.
    const draft = { ...setRowSource(draftOf("Название\tОценка, ч\tИсточник\nПеренос\t28\tТехдолг\n"), 1, "src-product"), mark: "plan" as const };
    expect(rowAt(previewImport(draft, snapshot).rows, 2).sourceId).toBe("src-product");

    for (const [after, text, hint] of [
      [without(snapshot, "src-product"), "Выбранный источник удалён из квартала. Выберите источник.", "— выбранный удалён —"],
      [asReserve(snapshot, "src-product"), "Выбранный источник «Продукт «Витрина»» стал резервом: работы в него не добавляются. Выберите источник работ.", "«Продукт «Витрина»» — резерв"]
    ] as const) {
      expect(validateQuarterSnapshot(after).ok).toBe(true);
      const row = rowAt(previewImport(draft, after).rows, 2);
      expect(row).toMatchObject({ sourceId: null, sourceHint: hint, blocked: true, checked: false });
      expect(row.issues).toEqual([{ level: "error", field: "source", text }]);
      const applied = applyImport(draft, after, newId);
      expect(applied.works).toEqual([]);
      // The budget of the source in the column is not taken.
      expect(debtPlanned({ ...after, tasks: [...after.tasks, ...applied.works] })).toBe(debtPlanned(after));
      // A new explicit choice is what gets added, in the preview and in the quarter alike.
      const chosen = setRowSource(draft, 1, "src-requests");
      expect(rowAt(previewImport(chosen, after).rows, 2).sourceId).toBe("src-requests");
      expect(applyImport(chosen, after, newId).works.map((work) => [work.directionId, work.estimateHours, work.mark])).toEqual([["src-requests", "28", "plan"]]);
    }
  });

  it("rows going to the open source stop when that source is deleted or made a reserve", () => {
    const draft = draftOf("Отчёт\t28\n", "src-product");
    for (const after of [without(currentDemoQuarter(), "src-product"), asReserve(currentDemoQuarter(), "src-product")]) {
      const row = previewImport(draft, after).rows[0];
      expect(row.sourceId).toBeNull();
      expect(row.issues).toEqual([{ level: "error", field: "source", text: "Источник для строк без своего удалён или стал резервом. Выберите источник." }]);
    }
  });

  it("a name of several sources of works is not guessed, even from the window of one of them", () => {
    const twin: Source = { id: "src-twin", name: "запросы  уи", percent: "5", kind: "work", memberPercents: [] };
    const snapshot = withSource(currentDemoQuarter(), twin);
    expect(validateQuarterSnapshot(snapshot).ok).toBe(true);
    const draft = draftOf("Название\tОценка, ч\tИсточник\nСверка\t6\tЗапросы УИ\n", "src-twin");
    const row = rowAt(previewImport(draft, snapshot).rows, 2);
    expect(row).toMatchObject({ sourceId: null, sourceHint: "«Запросы УИ» — несколько", blocked: true, checked: false });
    expect(row.issues).toEqual([{ level: "error", field: "source",
      text: "Источников с названием «Запросы УИ» в квартале 2. Выберите нужный — выбор подойдёт и для других строк с этим названием." }]);
    expect(applyImport(draft, snapshot, newId).works).toEqual([]);
    // The explicit choice decides; the old sources keep their names.
    const chosen = setRowSource(draft, 1, "src-twin");
    expect(applyImport(chosen, snapshot, newId).works.map((work) => work.directionId)).toEqual(["src-twin"]);
    expect(snapshot.directions.map((item) => item.name)).toContain("запросы  уи");
  });

  it("«е» and «ё», case and spaces make the same name; a reserve of that name takes no works", () => {
    const snapshot = withSource(withSource(currentDemoQuarter(),
      { id: "src-tree", name: "Ёлка", percent: "1", kind: "work", memberPercents: [] }),
      { id: "src-tree2", name: "елка", percent: "1", kind: "work", memberPercents: [] });
    expect(rowAt(previewImport(draftOf("Название\tИсточник\nИгрушки\tЕЛКА\n"), snapshot).rows, 2).sourceHint).toBe("«ЕЛКА» — несколько");
  });

  describe("a name of a source of works and of a reserve (R-005, PO decision of 2026-10-09)", () => {
    const sameAsReserve = () => withSource(currentDemoQuarter(),
      { id: "src-meet-works", name: "встречи и ритуалы", percent: "1", kind: "work", memberPercents: [] });
    const text = "Название\tОценка, ч\tИсточник\nДемо\t6\tВстречи и ритуалы\nРазбор\t4\tВстречи и ритуалы\nПрочее\t2\tТехдолг\n";

    it("is explained and waits for a source of works; the reserve never receives works", () => {
      const snapshot = sameAsReserve();
      const draft = draftOf(text);
      const row = rowAt(previewImport(draft, snapshot).rows, 2);
      expect(row).toMatchObject({ sourceId: null, sourceHint: "«Встречи и ритуалы» — выберите источник работ", blocked: true, checked: false });
      expect(row.issues).toEqual([{ level: "error", field: "source",
        text: "«Встречи и ритуалы» — так называются источник работ и резерв. Резерв работы не принимает: выберите источник работ — выбор подойдёт и для других строк с этим названием." }]);
      // Only the row of «Техдолг» goes; nothing is added to the reserve.
      expect(applyImport(draft, snapshot, newId).works.map((work) => work.directionId)).toEqual(["src-debt"]);
    });

    it("one choice serves every row with that name in this paste; the preview and the add agree", () => {
      const snapshot = sameAsReserve();
      const chosen = setRowSource(draftOf(text), 1, "src-meet-works");
      const rows = previewImport(chosen, snapshot).rows;
      expect(rowAt(rows, 2)).toMatchObject({ sourceId: "src-meet-works", checked: true, issues: [] });
      expect(rowAt(rows, 3)).toMatchObject({ sourceId: "src-meet-works", checked: true });
      expect(rowAt(rows, 3).issues).toEqual([{ level: "note", field: "source",
        text: "Источник выбран для «Встречи и ритуалы» в строке 2: встречи и ритуалы." }]);
      expect(applyImport(chosen, snapshot, newId).works.map((work) => [work.name, work.directionId])).toEqual([
        ["Демо", "src-meet-works"], ["Разбор", "src-meet-works"], ["Прочее", "src-debt"]
      ]);
    });

    it("different choices for the same name do not decide the other rows", () => {
      const snapshot = withSource(sameAsReserve(), { id: "src-meet-2", name: "Встречи и Ритуалы", percent: "1", kind: "work", memberPercents: [] });
      const draft = draftOf("Название\tИсточник\nА\tВстречи и ритуалы\nБ\tВстречи и ритуалы\nВ\tВстречи и ритуалы\n");
      const split = setRowSource(setRowSource(draft, 1, "src-meet-works"), 2, "src-meet-2");
      const rows = previewImport(split, snapshot).rows;
      expect([rowAt(rows, 2).sourceId, rowAt(rows, 3).sourceId, rowAt(rows, 4).sourceId]).toEqual(["src-meet-works", "src-meet-2", null]);
      expect(rowAt(rows, 4).blocked).toBe(true);
    });

    it("a source the user chose for the row itself is used without asking again", () => {
      const snapshot = sameAsReserve();
      const rows = previewImport(setRowSource(draftOf(text), 2, "src-requests"), snapshot).rows;
      expect(rowAt(rows, 3)).toMatchObject({ sourceId: "src-requests", checked: true, issues: [] });
      // The window opened from a source does not decide a name of several sources.
      expect(rowAt(rows, 2).blocked).toBe(true);
    });
  });

  it("sources with the same name are listed with their place and share", () => {
    const snapshot = withSource(currentDemoQuarter(), { id: "src-twin", name: "Запросы УИ ", percent: null, kind: "work", memberPercents: [] });
    const labels = sourceLabels(snapshot.directions);
    expect(labels.get("src-requests")).toBe("Запросы УИ (3-й в списке, 12,5%)");
    expect(labels.get("src-twin")).toBe("Запросы УИ (6-й в списке, доля не задана)");
    expect(labels.get("src-debt")).toBe("Техдолг");
  });
});

describe("adding: nothing is lost, nothing is overwritten", () => {
  it("adds the ticked rows in order as candidates and keeps the rest with their lines and fixes", () => {
    const snapshot = currentDemoQuarter();
    let draft = draftOf(templateClipboardText());
    draft = setRowText(draft, 10, "name", "Профилирование сборки");
    const { works, outcome, rest } = applyImport(draft, snapshot, newId);
    expect(works.map((work) => [work.name, work.directionId, work.estimateHours, work.mark])).toEqual([
      ["Отчёт по возвратам", "src-requests", "28", "candidate"],
      ["Справочник складов", "src-requests", "12.5", "candidate"],
      ["Проверка журналов ошибок", "src-debt", "0", "candidate"],
      ["Офлайн-режим", "src-mobile", null, "candidate"],
      ["Профилирование сборки", "src-debt", "16", "candidate"],
      ["Права доступа для отдела кадров", "src-requests", "100", "candidate"]
    ]);
    expect(works[1].comment).toBe("Нужна выгрузка из учётной системы");
    expect(works[0].link).toBe("https://kaiten.example.com/space/12/card/201");
    expect(outcome.skipped.map((row) => row.line)).toEqual([4, 5, 8, 9, 10, 12, 14, 15]);
    expect(outcome.skipped[0].reason).toBe("«M» — размер, а нужны часы. Размеры в часы не переводятся.");
    expect(rest!.lines).toEqual([1, 4, 5, 8, 9, 10, 12, 14, 15]);
    expect(pendingRowCount(rest!)).toBe(8);

    // The existing works are untouched; the snapshot stays valid.
    const after = { ...snapshot, tasks: [...snapshot.tasks, ...works] };
    expect(after.tasks.slice(0, snapshot.tasks.length)).toEqual(snapshot.tasks);
    expect(validateQuarterSnapshot(after).ok).toBe(true);

    // The rest now repeats what was added: «Отчёт по возвратам» of line 9 points to the new work.
    const again = previewImport(rest!, after);
    expect(rowAt(again.rows, 9).issues.at(-1)!.text).toBe("Ссылка уже есть у работы «Отчёт по возвратам» («Запросы УИ», на рассмотрении).");
  });

  it("the same list loaded again adds nothing by default", () => {
    const snapshot = currentDemoQuarter();
    const text = "Название\tОценка\tСсылка\tИсточник\nОтчёт\t28\thttps://kaiten.example.com/c/1\tЗапросы УИ\nСправочник\t12\t\tТехдолг\n";
    const first = applyImport(draftOf(text), snapshot, newId);
    const after = { ...snapshot, tasks: [...snapshot.tasks, ...first.works] };
    const second = previewImport(draftOf(text), after);
    expect(second.rows.every((row) => row.repeat && !row.checked)).toBe(true);
    expect(applyImport(draftOf(text), after, newId).works).toEqual([]);
  });

  it("«Скопировать пропущенные»: the header row, the rows with fixes and the reason", () => {
    const snapshot = currentDemoQuarter();
    const draft = setRowText(draftOf(templateClipboardText()), 3, "estimate", "XL");
    const { rest } = applyImport(draft, snapshot, newId);
    const text = skippedTableText(rest!, { ...snapshot, tasks: snapshot.tasks });
    const rows = parseTableText(text);
    expect(rows[0]).toEqual(["Название", "Оценка, ч", "Ссылка на Kaiten", "Комментарий", "Источник", "Причина пропуска"]);
    expect(rows[1]).toEqual(["Интеграция с CRM", "XL", "https://kaiten.example.com/space/12/card/203", "", "Продукт «Витрина»", "«XL» — размер, а нужны часы. Размеры в часы не переводятся."]);
    expect(rows.find((row) => row[0] === "Мониторинг ошибок")![3]).toBe("Две строки\nв одной ячейке");
  });

  it("a row the user unticked stays unticked among the rest and is copied with «Строка снята.»", () => {
    const snapshot = currentDemoQuarter();
    const draft = setRowChecked(draftOf(templateClipboardText()), 12, false);
    const { outcome, rest } = applyImport(draft, snapshot, newId);
    expect(outcome.skipped.find((row) => row.line === 13)!.reason).toBe("Строка снята.");
    expect(rowAt(previewImport(rest!, snapshot).rows, 13).checked).toBe(false);
    const copied = parseTableText(skippedTableText(rest!, snapshot));
    expect(copied.find((row) => row[0] === "Права доступа для отдела кадров")!.at(-1)).toBe("Строка снята.");
    expect(copied).toHaveLength(1 + outcome.skipped.length);
  });

  it("copies a fix that has no column of its own: the original size stays", () => {
    const snapshot = currentDemoQuarter();
    let draft = draftOf("Отчёт А\tM\tЗапросы УИ\nОтчёт Б\t4\tЗапросы УИ\n");
    expect(draft.roles).toEqual(["name", "estimate", "source"]);
    draft = withoutEstimate(draft, previewImport(draft, snapshot).rows[0]);
    draft = setRowChecked(draft, 0, false);
    const { rest } = applyImport(draft, snapshot, newId);
    expect(parseTableText(skippedTableText(rest!, snapshot))).toEqual([
      ["Название", "Оценка, ч", "Источник", "Комментарий", "Причина пропуска"],
      ["Отчёт А", "", "Запросы УИ", "исходная оценка: M", "Строка снята."]
    ]);
  });

  it("remembers the window that started the import when the default source changes", () => {
    const draft = { ...draftOf("Отчёт\t28\n"), sourceId: "src-debt" };
    expect(draft.openedFrom).toBe("src-requests");
    expect(applyImport({ ...draft, checked: { 0: false } }, currentDemoQuarter(), newId).rest!.openedFrom).toBe("src-requests");
  });

  it("refuses more works than one quarter holds", () => {
    const snapshot = currentDemoQuarter();
    const many = { ...snapshot, tasks: Array.from({ length: 10000 }, (_, index) => ({ ...snapshot.tasks[0], id: `t-${index}`, link: null })) };
    const draft = draftOf("Отчёт\t28\n");
    expect(previewImport(draft, many).overLimit).toBe(true);
    expect(() => applyImport(draft, many, newId)).toThrow();
  });

  it("cuts a paste of more than 1 000 rows and says so", () => {
    const text = Array.from({ length: 1205 }, (_, index) => `Работа ${index}\t1`).join("\n");
    const draft = draftOf(text);
    expect(draft.cut).toBe(true);
    expect(draft.cells.length).toBe(1000);
    // With a header row the header is kept on top of 1 000 rows.
    expect(draftOf(`Название\tОценка\n${text}`).cells.length).toBe(1001);
  });
});

describe("«Отменить вставку»", () => {
  const batch: ImportBatch = {
    id: "b1", planId: "plan-1", mark: "candidate",
    works: [
      { id: "n1", name: "А", directionId: "src-debt", estimateHours: "10", mark: "candidate", link: null, comment: null },
      { id: "n2", name: "Б", directionId: "src-debt", estimateHours: null, mark: "candidate", link: null, comment: null },
      { id: "n3", name: "В", directionId: "src-debt", estimateHours: "5", mark: "candidate", link: null, comment: null }
    ]
  };

  it("removes exactly the works of the import, after other changes too", () => {
    const tasks = [...currentDemoQuarter().tasks, ...batch.works, { ...batch.works[0], id: "other" }];
    expect(removeImported(tasks, batch).map((task) => task.id)).toEqual([...currentDemoQuarter().tasks.map((task) => task.id), "other"]);
  });

  it("names the works changed since the import before removing them", () => {
    const tasks = [{ ...batch.works[0], mark: "plan" as const }, { ...batch.works[1], estimateHours: "8" }];
    expect(changedSinceImport(batch, tasks)).toEqual({ present: 2, changed: ["«А» — включена в план квартала", "«Б» — изменена"] });
    expect(changedSinceImport(batch, batch.works)).toEqual({ present: 3, changed: [] });
  });
});

describe("the preview never runs or fetches anything", () => {
  it("formula-like and markup text stays plain text of a work", () => {
    const snapshot = currentDemoQuarter();
    const text = "=HYPERLINK(\"https://evil.example\")\t1\n<img src=x onerror=alert(1)>\t2\n";
    const { works } = applyImport(draftOf(text), snapshot, newId);
    expect(works.map((work) => work.name)).toEqual(["=HYPERLINK(\"https://evil.example\")", "<img src=x onerror=alert(1)>"]);
    expect(works.every((work) => work.link === null)).toBe(true);
  });
});
