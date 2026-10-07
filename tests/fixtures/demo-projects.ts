import { createQuarterCalendar } from "../../src/domain/capacity/project-calendar";
import type { QuarterSnapshot, QuarterSnapshotV1 } from "../../src/domain/capacity/quarter-capacity.types";

/**
 * Fictional demo projects shipped with a preview build for the PO's first check. Names,
 * works and links are made up; links point to example.com. The JSON files next to this
 * module are written from these builders (tests/demo-projects.test.ts) and turned into
 * project folders by the Rust store (project_store/tests.rs, write_demo_projects).
 */
export const DEMO_TEAM_NAMES = {
  current: "Учебная команда «Альфа»",
  legacy: "Учебная команда «Бета» (формат 0.3.0)"
} as const;

const link = (card: number) => `https://kaiten.example.com/space/12/card/${card}`;
type Work = QuarterSnapshot["tasks"][number];
const work = (id: string, directionId: string, name: string, estimateHours: string | null,
  mark: Work["mark"], extra: Partial<Pick<Work, "link" | "comment">> = {}): Work =>
  ({ id, name, directionId, estimateHours, mark, link: extra.link ?? null, comment: extra.comment ?? null });

/**
 * Q1 2027, 56 working days. 4 people at FTE 1 and one at 0.5, one with a 2-day absence:
 * 448 + 432 + 448 + 448 + 224 = 2 000 h. «Запросы УИ» gets 12,5% = 250 h with 200 h in
 * the plan: the PO's control example of DEC-041 starts from here.
 */
export function currentDemoQuarter(): QuarterSnapshot {
  const calendar = createQuarterCalendar(2027, 1);
  if (!calendar.ok) throw new Error(calendar.message);
  return {
    year: 2027,
    quarter: 1,
    calendar: calendar.calendar,
    calendarSource: calendar.calendarSource,
    competencies: [
      { id: "comp-analysis", name: "Аналитика" },
      { id: "comp-dev", name: "Разработка" },
      { id: "comp-qa", name: "Тестирование" }
    ],
    members: [
      { id: "m-anna", name: "Анна Иванова", competencyId: "comp-analysis", fte: "1" },
      { id: "m-boris", name: "Борис Петров", competencyId: "comp-dev", fte: "1" },
      { id: "m-vera", name: "Вера Соколова", competencyId: "comp-dev", fte: "1" },
      { id: "m-gleb", name: "Глеб Орлов", competencyId: "comp-dev", fte: "1" },
      { id: "m-dina", name: "Дина Морозова", competencyId: "comp-qa", fte: "0.5" }
    ],
    absences: [{ id: "abs-boris", memberId: "m-boris", startDate: "2027-02-15", endDate: "2027-02-16" }],
    directions: [
      // DEC-038: the analyst spends more time in team meetings, her own share replaces 15%.
      { id: "src-meetings", name: "Встречи и ритуалы", percent: "15", kind: "reserve", memberPercents: [{ memberId: "m-anna", percent: "25" }] },
      { id: "src-product", name: "Продукт «Витрина»", percent: "40", kind: "work", memberPercents: [] },
      { id: "src-requests", name: "Запросы УИ", percent: "12.5", kind: "work", memberPercents: [] },
      { id: "src-mobile", name: "Мобильное приложение", percent: "5", kind: "work", memberPercents: [] },
      { id: "src-debt", name: "Техдолг", percent: "10", kind: "work", memberPercents: [] }
    ],
    tasks: [
      work("w-filters", "src-product", "Каталог: фильтры по цене и наличию", "320", "plan", { link: link(101) }),
      work("w-promo", "src-product", "Корзина: промокоды", "280", "plan", { link: link(102) }),
      work("w-suggest", "src-product", "Поиск: подсказки при вводе", null, "plan"),
      work("w-reviews", "src-product", "Отзывы покупателей", "160", "candidate", { link: link(104) }),
      work("w-compare", "src-product", "Сравнение товаров", null, "candidate"),
      work("w-home", "src-product", "Новая главная страница", "400", "out", { comment: "Заказчик перенёс на II квартал" }),
      work("w-export", "src-requests", "Выгрузка для бухгалтерии", "120", "plan"),
      work("w-access", "src-requests", "Права доступа для отдела кадров", "80", "plan"),
      work("w-push", "src-mobile", "Push-уведомления", "90", "plan"),
      work("w-dark", "src-mobile", "Тёмная тема", "30", "plan"),
      work("w-libs", "src-debt", "Обновление библиотек", "60", "plan"),
      work("w-build", "src-debt", "Ускорение сборки", "40", "candidate")
    ]
  };
}

/**
 * The same kind of quarter as 0.1.0–0.3.0 saved it (format 1), for trying the format
 * upgrade without a real project: Q4 2026, 64 working days, 512 + 512 + 384 = 1 408 h.
 */
export function legacyDemoQuarter(): QuarterSnapshotV1 {
  const calendar = createQuarterCalendar(2026, 4);
  if (!calendar.ok) throw new Error(calendar.message);
  return {
    year: 2026,
    quarter: 4,
    calendar: calendar.calendar,
    calendarSource: calendar.calendarSource,
    competencies: [
      { id: "comp-analysis", name: "Аналитика" },
      { id: "comp-dev", name: "Разработка" }
    ],
    members: [
      { id: "m-irina", name: "Ирина Кузнецова", competencyId: "comp-analysis", fte: "1" },
      { id: "m-kirill", name: "Кирилл Лебедев", competencyId: "comp-dev", fte: "1" },
      { id: "m-lev", name: "Лев Новиков", competencyId: "comp-dev", fte: "0.75" }
    ],
    absences: [],
    directions: [
      { id: "dir-meetings", name: "Встречи и резерв", percent: "20" },
      { id: "dir-product", name: "Продукт", percent: "50" },
      { id: "dir-support", name: "Поддержка", percent: "30" }
    ],
    tasks: [
      { id: "t-history", name: "Личный кабинет: история заказов", directionId: "dir-product", estimateHours: "160" },
      { id: "t-mail", name: "Интеграция с почтой", directionId: "dir-product", estimateHours: null },
      { id: "t-tickets", name: "Разбор обращений", directionId: "dir-support", estimateHours: "120" }
    ]
  };
}
