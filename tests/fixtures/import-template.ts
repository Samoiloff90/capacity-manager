/**
 * The small list of works the PO tries the import with (DEC-050): made up, for the quarter of
 * the demo project «Альфа» (currentDemoQuarter). Links point to example.com. Each row shows
 * one rule; `expect` is what the preview says about it before anything is fixed.
 */
export const IMPORT_TEMPLATE_HEADER = ["Название", "Оценка, ч", "Ссылка на Kaiten", "Комментарий", "Источник"] as const;

const card = (number: number) => `https://kaiten.example.com/space/12/card/${number}`;

export type TemplateRow = {
  cells: readonly [string, string, string, string, string];
  /** error — not added until fixed; repeat — unticked; warning, note, ok — ticked. */
  expect: "ok" | "warning" | "note" | "error" | "repeat";
  rule: string;
};

export const IMPORT_TEMPLATE_ROWS: readonly TemplateRow[] = [
  { cells: ["Отчёт по возвратам", "28", card(201), "", "Запросы УИ"], expect: "ok", rule: "работа с оценкой в часах" },
  { cells: ["Справочник складов", "12,5", "", "Нужна выгрузка из учётной системы", "Запросы УИ"], expect: "ok", rule: "дробные часы через запятую" },
  { cells: ["Интеграция с CRM", "M", card(203), "", "Продукт «Витрина»"], expect: "error", rule: "размер вместо часов: «Добавить без оценки» или исправить" },
  { cells: ["Оплата частями", "2-3 дня", "", "", "Продукт «Витрина»"], expect: "error", rule: "срок вместо часов" },
  { cells: ["Проверка журналов ошибок", "0", "", "Основную часть сделала другая команда", "Техдолг"], expect: "note", rule: "0 ч — не то же, что «без оценки»" },
  { cells: ["Офлайн-режим", "", "", "Оценка после исследования", "Мобильное приложение"], expect: "warning", rule: "без оценки" },
  { cells: ["Корзина: промокоды", "280", card(102), "", "Продукт «Витрина»"], expect: "repeat", rule: "ссылка уже есть в квартале" },
  { cells: ["Отчёт по возвратам", "28", card(201), "", "Запросы УИ"], expect: "repeat", rule: "та же ссылка, что во второй строке" },
  { cells: ["Баннеры на главной", "40", "", "", "Маркетинг"], expect: "error", rule: "такого источника нет: источники не создаются" },
  { cells: ["", "16", "", "Название забыли", "Техдолг"], expect: "error", rule: "нет названия" },
  { cells: ["Тёмная тема", "30", "", "", "Мобильное приложение"], expect: "repeat", rule: "такая работа уже есть" },
  { cells: ["Права доступа для отдела кадров", "100", "", "Новая оценка заказчика", "Запросы УИ"], expect: "warning", rule: "похожее название: работа не заменяется" },
  { cells: ["Мониторинг ошибок", "1 200", "kaiten.example.com/card/207", "Две строки\nв одной ячейке", "Техдолг"], expect: "error", rule: "ссылка без https://" },
  { cells: ["Встречи с заказчиком", "20", "", "", "Встречи и ритуалы"], expect: "error", rule: "резерв: работы в него не добавляются" }
];

/** The template as Excel puts it on the clipboard: tabs, CRLF, a quoted cell with a line break. */
export function templateClipboardText(): string {
  const quote = (cell: string) => /[\t\r\n"]/.test(cell) ? `"${cell.replace(/"/g, "\"\"")}"` : cell;
  return [IMPORT_TEMPLATE_HEADER, ...IMPORT_TEMPLATE_ROWS.map((row) => row.cells)]
    .map((row) => row.map(quote).join("\t")).join("\r\n") + "\r\n";
}

/** What each row checks: the second sheet of the template, for the person trying it. */
export const IMPORT_TEMPLATE_NOTES = ["Строка", "Что проверяет", "Что покажет предпросмотр"] as const;
const EXPECT_TEXT: Record<TemplateRow["expect"], string> = {
  ok: "готово к добавлению",
  note: "пояснение, строка отмечена",
  warning: "предупреждение, строка отмечена",
  error: "ошибка: не добавится, пока не исправить",
  repeat: "повтор: строка снята, можно отметить вручную"
};
export const importTemplateNotes = () => IMPORT_TEMPLATE_ROWS.map((row, index) => [String(index + 2), row.rule, EXPECT_TEXT[row.expect]]);
