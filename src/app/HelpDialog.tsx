import { useRef } from "react";
import { INFO_TEXTS, type InfoKey } from "./info-texts";
import { useDialogFocus } from "./project-ui";
import { saveShortcut } from "./plan-ui";

export type HelpTab = "team" | "calendar" | "absences" | "sources" | "plan";

const STEPS: ReadonlyArray<{ title: string; text: string; tab: HelpTab; action: string }> = [
  { title: "Проверить ёмкость", tab: "team", action: "Открыть «Команду»",
    text: "Сотрудники и ставки во вкладке «Команда», рабочие дни — в «Календаре», отпуска — в «Отсутствиях». Вверху окна — сколько часов доступно команде за квартал." },
  { title: "Распределить доли", tab: "sources", action: "Открыть «Источники и доли»",
    text: "Во вкладке «Источники и доли» задайте резерв на встречи и ритуалы и доли источников работ в процентах. Доли считаются от всей доступной ёмкости. Сумма меньше 100% допустима: остаток — «Не распределено»." },
  { title: "Добавить работы", tab: "plan", action: "Открыть «План квартала»",
    text: "В «Плане квартала» откройте источник и нажмите «Добавить работу». Укажите название и полную оценку в часах; без оценки работу тоже можно добавить. Новая работа по умолчанию — «На рассмотрении»: бюджет она не занимает." },
  { title: "Выбрать состав плана", tab: "plan", action: "Открыть «План квартала»",
    text: "«Включить в план квартала» — работа займёт бюджет источника; рядом видно, сколько останется. Работы, которые решили не брать, перенесите в «Не в этом квартале». Последнее действие можно отменить." },
  { title: "Проверить остатки и превышения", tab: "plan", action: "Открыть «План квартала»",
    text: `В таблице источников видны квота, занято работами и остаток или перебор. «Не менее» и «не более» значат, что в плане есть работы без оценки. Сохраните квартал кнопкой «Сохранить квартал» (${saveShortcut}); перебор и сумма долей больше 100% при этом остаются видны.` }
];

const TERMS: readonly InfoKey[] = ["source", "quota", "planned", "rest", "unallocated", "reserve", "estimate", "bounds", "candidate", "plan", "out"];

/** «Как составить план квартала»: a short local page, no tour and no internet (DEC-042). */
export function HelpDialog({ onClose, onGoToTab }: { onClose: () => void; onGoToTab: (tab: HelpTab) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialog, close, onClose);
  return <div className="project-modal-backdrop">
    <div ref={dialog} className="project-modal pp-mid pp-help" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div className="pp-modal-head"><h2 id="help-title">Как составить план квартала</h2>
        <p>Пять шагов. Подсказка работает без интернета; подробности терминов — по значку (i) рядом с ними.</p></div>
      <div className="pp-modal-body">
        <ol className="pp-steps pp-help-steps">{STEPS.map((step) => <li key={step.title}>
          <div><b>{step.title}</b><p>{step.text}</p></div>
          <button type="button" className="project-link-button" onClick={() => onGoToTab(step.tab)}>{step.action}</button>
        </li>)}</ol>
        <h3 className="pp-section-title">Термины</h3>
        <dl className="pp-terms">{TERMS.map((key) => <div key={key}>
          <dt>{INFO_TEXTS[key].title}</dt>
          <dd>{INFO_TEXTS[key].lines[0]}</dd>
        </div>)}</dl>
        <p className="project-muted">ч — человеко-часы команды. Оценки — плановые трудозатраты, а не сроки и не факт.</p>
      </div>
      <div className="pp-modal-foot"><span className="project-muted">Esc — закрыть</span>
        <span className="project-actions"><button ref={close} type="button" onClick={onClose}>Закрыть</button></span></div>
    </div>
  </div>;
}
