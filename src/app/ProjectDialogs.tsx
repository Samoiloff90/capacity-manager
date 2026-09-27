import { useMemo, useRef, useState, type FormEvent } from "react";
import type { StoredQuarterPlan } from "../db/project-snapshots";
import type { Quarter } from "../domain/capacity/calendar-quarter";
import type { CalendarMode } from "../domain/capacity/project-calendar";
import { BUNDLED_CALENDAR_YEARS } from "../domain/capacity/project-calendar";
import { defaultCopySource, nextQuarterAfter } from "../domain/capacity/quarter-copy";
import { quarterTitle, type DiscardAnswer } from "./project-workspace-controller";
import { useDialogFocus } from "./project-ui";

const periodOf = (plan: StoredQuarterPlan) => ({ year: plan.snapshot.year, quarter: plan.snapshot.quarter });

export function NewQuarterDialog({ plans, onCancel, onCreate }: {
  plans: readonly StoredQuarterPlan[];
  onCancel: () => void;
  onCreate: (year: number, quarter: Quarter, mode: CalendarMode, copyFromPlanId: string | null) => void;
}) {
  const initial = useMemo(() => {
    const today = new Date();
    return nextQuarterAfter(plans.map(periodOf), { year: today.getFullYear(), month: today.getMonth() + 1 });
  }, [plans]);
  const [yearText, setYearText] = useState(String(initial.year));
  const [quarter, setQuarter] = useState<Quarter>(initial.quarter);
  const [manualConfirmed, setManualConfirmed] = useState(false);
  // Until the user picks a source, it follows the chosen period.
  const [chosenSource, setChosenSource] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const yearInput = useRef<HTMLInputElement>(null);
  useDialogFocus(dialog, yearInput, onCancel);

  const year = Number(yearText);
  const validYear = /^\d{1,4}$/.test(yearText) && year >= 1 && year <= 9999;
  const existing = validYear ? plans.find((plan) => plan.snapshot.year === year && plan.snapshot.quarter === quarter) : undefined;
  const officialCalendar = BUNDLED_CALENDAR_YEARS.includes(year);
  const needsManual = validYear && !existing && !officialCalendar;
  const sources = [...plans].sort((a, b) => b.snapshot.year - a.snapshot.year || b.snapshot.quarter - a.snapshot.quarter);
  const source = chosenSource ?? (validYear ? defaultCopySource(sources.map((plan) => ({ ...periodOf(plan), planId: plan.planId })), { year, quarter })?.planId ?? "" : "");
  const canSubmit = validYear && (!needsManual || manualConfirmed);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onCreate(year, quarter, officialCalendar ? "ru-official" : "manual", existing || !source ? null : source);
  }

  return <div className="project-modal-backdrop">
    <div ref={dialog} className="project-modal project-new-quarter" role="dialog" aria-modal="true" aria-labelledby="new-quarter-title">
      <form className="project-stack" onSubmit={submit}>
        <h2 id="new-quarter-title">Новый квартал</h2>
        <div className="project-inline-form">
          <label className="project-year">Год<input ref={yearInput} inputMode="numeric" value={yearText} maxLength={4}
            aria-invalid={!validYear} onChange={(event) => { setYearText(event.target.value.trim()); setManualConfirmed(false); }} /></label>
          <label>Квартал<select value={quarter} onChange={(event) => setQuarter(Number(event.target.value) as Quarter)}>
            {[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value} квартал</option>)}
          </select></label>
        </div>
        {!validYear && <p className="project-field-error" role="alert">Укажите год от 1 до 9999.</p>}
        {existing ? <div className="project-message" role="status">
          <p>«{quarterTitle(existing.snapshot)}» уже создан. Он откроется без изменений.</p>
        </div> : <div className="project-copy-field">
          <label>Скопировать из
            <select className="project-copy-source" value={source} disabled={!sources.length} aria-describedby="copy-source-note"
              onChange={(event) => setChosenSource(event.target.value)}>
              {sources.map((plan) => <option key={plan.planId} value={plan.planId}>{quarterTitle(plan.snapshot)}</option>)}
              <option value="">Не копировать</option>
            </select></label>
          <span id="copy-source-note" className="project-muted">{source
            ? "Сотрудники, ставки, компетенции, направления и доли. Отсутствия и задачи не копируются, календарь — новый для выбранного периода."
            : "Новый квартал начнётся с пустого состава и стандартного списка компетенций."}</span>
        </div>}
        {needsManual && <div className="project-message warning">
          <p>Встроенного календаря РФ на {year} год нет. План начнётся с пятидневки без праздников и переносов.</p>
          <label className="project-checkbox project-confirmation"><input type="checkbox" checked={manualConfirmed}
            onChange={(event) => setManualConfirmed(event.target.checked)} />Я проверю праздники и переносы вручную во вкладке «Календарь»</label>
        </div>}
        <div className="project-actions project-dialog-actions">
          <button type="button" className="secondary" onClick={onCancel}>Отмена</button>
          <button type="submit" disabled={!canSubmit}
            title={needsManual && !manualConfirmed ? "Подтвердите ручную проверку календаря" : undefined}>{existing ? "Открыть квартал" : "Создать квартал"}</button>
        </div>
      </form>
    </div>
  </div>;
}

export function DiscardDialog({ message, canSave, onAnswer }: {
  message: string; canSave: boolean; onAnswer: (answer: DiscardAnswer) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialog, canSave ? save : cancel, () => onAnswer(false));
  return <div className="project-modal-backdrop">
    <div ref={dialog} className="project-modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-message">
      <h2 id="discard-title">Несохранённые изменения</h2><p id="discard-message">{message}</p>
      <div className="project-actions project-dialog-actions">
        <button ref={cancel} className="secondary" type="button" onClick={() => onAnswer(false)}>Отмена</button>
        <button className="danger" type="button" onClick={() => onAnswer(true)}>Не сохранять</button>
        {canSave && <button ref={save} type="button" onClick={() => onAnswer("save")}>Сохранить и продолжить</button>}
      </div>
    </div>
  </div>;
}
