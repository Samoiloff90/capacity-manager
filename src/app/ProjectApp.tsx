import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectWorkspace } from "./project-workspace";
import { TasksEditor } from "./TasksEditor";
import { getQuarterDates, type Quarter } from "../domain/capacity/calendar-quarter";
import { formatHours, normalizeUserDecimal } from "../domain/capacity/input-format";
import { describeDirectionBalance } from "../domain/capacity/direction-balance";
import { BUNDLED_CALENDAR_YEARS, getCalendarOverrides } from "../domain/capacity/project-calendar";
import type { QuarterCapacityResult, QuarterSnapshot, QuarterValidationIssue } from "../domain/capacity/quarter-capacity.types";
import "../styles/project-app.css";

type Tab = "team" | "calendar" | "absences" | "allocation" | "tasks";
type UpdateDraft = (update: (current: QuarterSnapshot) => QuarterSnapshot) => void;
type EditorProps = { snapshot: QuarterSnapshot; update: UpdateDraft; result: QuarterCapacityResult | null };
const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "team", label: "Команда" },
  { id: "calendar", label: "Календарь" },
  { id: "absences", label: "Отсутствия" },
  { id: "allocation", label: "Распределение" },
  { id: "tasks", label: "Задачи" }
];
const nameGuard = "project-name";
const newId = () => crypto.randomUUID();
const numberText = (value: string) => value.replace(".", ",");

/** Normalize presentation only. Invalid and unfinished input stays in the draft. */
function finishDecimal(value: string): string {
  try { return normalizeUserDecimal(value) ?? value; }
  catch { return value; }
}

function fieldLabel(path: string): string {
  const [collection, row, field] = path.split(".");
  const section: Record<string, string> = {
    members: "Сотрудник", competencies: "Компетенция", absences: "Отсутствие",
    directions: "Направление", tasks: "Задача", calendar: "Календарь"
  };
  const fields: Record<string, string> = {
    name: "название или имя", fte: "ставка", percent: "доля", competencyId: "компетенция",
    memberId: "сотрудник", startDate: "дата начала", endDate: "дата окончания", date: "дата",
    directionId: "направление", estimateHours: "оценка в часах"
  };
  const label = section[collection] ?? "Данные квартала";
  return `${label}${row !== undefined && /^\d+$/.test(row) ? ` ${Number(row) + 1}` : ""}${fields[field] ? `, ${fields[field]}` : ""}`;
}

function ValidationMessages({ issues }: { issues: QuarterValidationIssue[] }) {
  return <div className="project-message warning" role="status">
    <strong>Расчёт появится после заполнения данных.</strong>
    <ul>{issues.slice(0, 8).map((issue, index) => <li key={`${issue.path}-${index}`}>
      {fieldLabel(issue.path)}: {issue.message.includes("каноническое")
        ? "введите число; дробную часть можно отделить запятой или точкой."
        : issue.message}
    </li>)}</ul>
    {issues.length > 8 && <p>Есть и другие незаполненные или некорректные поля.</p>}
  </div>;
}

export default function ProjectApp() {
  const { state, actions } = useProjectWorkspace();
  const [newProjectName, setNewProjectName] = useState("");
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [uiError, setUiError] = useState("");
  const [tab, setTab] = useState<Tab>("team");
  const [yearText, setYearText] = useState(String(new Date().getFullYear()));
  const [quarter, setQuarter] = useState<Quarter>((Math.floor(new Date().getMonth() / 3) + 1) as Quarter);
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const projectId = state.project?.projectId;
  const projectName = state.project?.name;
  const disabled = state.busy || !state.closeProtectionReady || choosingFolder;
  const result = state.calculation?.ok ? state.calculation.result : null;
  const year = Number(yearText);
  const validYear = /^\d{1,4}$/.test(yearText) && year >= 1 && year <= 9999;
  const officialCalendar = (BUNDLED_CALENDAR_YEARS as readonly number[]).includes(year);

  useEffect(() => {
    setProjectNameDraft(projectName ?? "");
    setRenaming(false);
    actions.setPendingFormDirty(nameGuard, false);
    setUiError("");
  }, [projectId, projectName, state.activePlanId]);

  async function chooseProject(create: boolean) {
    setUiError("");
    if (create && !newProjectName.trim()) {
      setUiError("Укажите название команды.");
      return;
    }
    setChoosingFolder(true);
    try {
      const folder = await open({ directory: true, multiple: false,
        title: create ? "Выберите пустую папку для команды" : "Выберите папку проекта" });
      if (typeof folder !== "string") return;
      const done = create
        ? await actions.createProject(folder, newProjectName.trim())
        : await actions.openProject(folder);
      if (done) { setTab("team"); setNewProjectName(""); }
    } catch {
      setUiError("Не удалось выбрать папку. Попробуйте ещё раз.");
    } finally { setChoosingFolder(false); }
  }

  async function createQuarter(event: FormEvent) {
    event.preventDefault();
    setUiError("");
    if (!validYear) { setUiError("Укажите год от 1 до 9999."); return; }
    if (!officialCalendar && !manualConfirmed) {
      setUiError("Подтвердите ручную проверку календаря для этого года.");
      return;
    }
    if (await actions.createPlan(year, quarter, officialCalendar ? "ru-official" : "manual")) setTab("team");
  }

  function cancelRename() {
    setProjectNameDraft(state.project?.name ?? "");
    actions.setPendingFormDirty(nameGuard, false);
    setRenaming(false);
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    const requestedName = projectNameDraft;
    if (await actions.renameProject(requestedName)) {
      setProjectNameDraft(requestedName.trim());
      actions.setPendingFormDirty(nameGuard, false);
      setRenaming(false);
    }
  }

  const messages = <>
    {(uiError || state.error) && <div className="project-message error" role="alert">
      <p>{uiError || state.error}</p>
      <div className="project-actions"><button className="secondary" type="button" onClick={() => {
        setUiError(""); actions.clearMessage();
      }}>Скрыть сообщение</button></div>
    </div>}
    {state.notice && <div className="project-message" role="status">{state.notice}</div>}
  </>;

  return <div className="project-app">
    {!state.project ? <main className="project-welcome">
      <header><span className="eyebrow">Планирование команды</span><h1>Ёмкость команды</h1>
        <p>Люди, рабочие дни и распределение часов на квартал. Каждая команда хранится в отдельной папке на вашем компьютере.</p>
      </header>
      {messages}
      <div className="project-welcome-grid">
        <section className="project-card">
          <h2>Новый проект команды</h2>
          <p>Выберите существующую пустую папку. В ней будут сохраняться данные этой команды.</p>
          <form className="project-stack" onSubmit={(event) => { event.preventDefault(); void chooseProject(true); }}>
            <label>Название команды<input required value={newProjectName} maxLength={1000}
              placeholder="Например, Команда продукта" disabled={disabled}
              onChange={(event) => setNewProjectName(event.target.value)} /></label>
            <div className="project-actions"><button disabled={disabled || !newProjectName.trim()} type="submit">Выбрать папку и создать</button></div>
          </form>
        </section>
        <section className="project-card project-stack">
          <div><h2>Открыть проект</h2><p>Выберите папку ранее созданной команды, чтобы продолжить работу с её кварталами.</p></div>
          <div className="project-actions"><button className="secondary" type="button" disabled={disabled} onClick={() => { void chooseProject(false); }}>Открыть папку проекта</button></div>
        </section>
      </div>
      <p className="project-welcome-note project-muted">Для переноса на другой компьютер закройте проект и скопируйте всю его папку.</p>
      {disabled && <p role="status">{choosingFolder ? "Выбор папки…" : "Открываем проект…"}</p>}
    </main> : <>
      <header className="project-topbar">
        <div className="project-title"><span className="eyebrow">Проект команды</span><h1>{state.project.name}</h1>
          <div className="project-path">{state.project.folderPath.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "")}</div>
        </div>
        <div className="project-actions">
          <span className={`project-status ${state.dirty || projectNameDraft !== state.project.name ? "dirty" : "saved"}`} role="status">
            {state.busy ? "Выполняем…" : state.dirty || projectNameDraft !== state.project.name ? "Есть несохранённые изменения" : "Все изменения сохранены"}
          </span>
          <button type="button" disabled={disabled || !state.draft || !state.dirty} onClick={() => { void actions.save(); }}>Сохранить квартал</button>
          <button className="secondary" type="button" disabled={disabled} onClick={() => { void actions.closeProject(); }}>Закрыть проект</button>
        </div>
      </header>
      <main className="project-content">
        {messages}
        {renaming ? <form className="project-inline-form project-rename" onSubmit={(event) => { void rename(event); }}>
          <label>Название команды<input autoFocus required maxLength={1000} value={projectNameDraft} disabled={disabled}
            onChange={(event) => {
              setProjectNameDraft(event.target.value);
              actions.setPendingFormDirty(nameGuard, event.target.value !== state.project?.name);
            }} /></label>
          <button type="submit" disabled={disabled || !projectNameDraft.trim() || projectNameDraft === state.project.name}>Сохранить название</button>
          <button type="button" className="secondary" disabled={disabled} onClick={cancelRename}>Отмена</button>
        </form> : <div className="project-actions project-rename"><button className="secondary" type="button" disabled={disabled} onClick={() => setRenaming(true)}>Изменить название команды</button></div>}

        <div className="project-period-bar">
          <label className="project-plan-select">Сохранённый квартал<select value={state.activePlanId ?? ""} disabled={disabled || !state.plans.length}
            onChange={(event) => { void actions.selectPlan(event.target.value); }}>
            <option value="" disabled>Выберите квартал</option>
            {state.plans.map((plan) => <option key={plan.planId} value={plan.planId}>{plan.snapshot.quarter} квартал {plan.snapshot.year} года</option>)}
          </select></label>
          <form className="project-inline-form project-spacer" onSubmit={(event) => { void createQuarter(event); }}>
            <label className="project-year">Год нового плана<input inputMode="numeric" value={yearText} disabled={disabled}
              onChange={(event) => { setYearText(event.target.value); setManualConfirmed(false); }} /></label>
            <label>Квартал<select value={quarter} disabled={disabled} onChange={(event) => setQuarter(Number(event.target.value) as Quarter)}>
              {[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value} квартал</option>)}
            </select></label>
            <button className="secondary" type="submit" disabled={disabled || !validYear || (!officialCalendar && !manualConfirmed)}>Создать квартал</button>
          </form>
        </div>
        {validYear && !officialCalendar && <div className="project-message warning">
          <p>Встроенного календаря РФ на {year} год нет. Новый план начнётся с пятидневки без учёта праздников и переносов.</p>
          <label className="project-checkbox project-confirmation"><input type="checkbox" checked={manualConfirmed} disabled={disabled}
            onChange={(event) => setManualConfirmed(event.target.checked)} />Я проверю праздники и переносы вручную во вкладке «Календарь»</label>
        </div>}

        {!state.draft ? <div className="empty-state">Создайте квартал или выберите сохранённый план, чтобы добавить сотрудников и настроить рабочие дни.</div> : <>
          <div className="project-section-heading"><div><h2>{state.draft.quarter} квартал {state.draft.year} года</h2>
            <p>Общий календарь команды, 8 часов в рабочем дне. Ставка уменьшает часы пропорционально.</p></div></div>
          <div className="project-summary">
            <div className="project-summary-card"><span>Доступно команде за квартал</span><strong>{result ? formatHours(result.totals.availableHours) : "—"}</strong><span>После отсутствий и с учётом ставок</span></div>
            <div className="project-summary-card"><span>Рабочих дней в календаре</span><strong>{result?.totals.workingDays ?? "—"}</strong><span>Общие для команды; отсутствия указаны отдельно</span></div>
            <div className="project-summary-card"><span>Сотрудников в квартале</span><strong>{state.draft.members.length}</strong><span>Состав этого квартала сохраняется отдельно</span></div>
          </div>
          {result && <div className="project-demand-summary" role="status">
            <span>{result.totals.demandComplete ? "Потребность по задачам" : "Известная потребность по задачам"}: <strong>{formatHours(result.totals.knownDemandHours)}</strong></span>
            <span>Задач без оценки: <strong>{result.totals.missingEstimateCount}</strong></span>
            {!result.totals.demandComplete && <span className="project-estimate-missing">Потребность неполная; остатки затронутых направлений предварительные.</span>}
          </div>}
          {state.calculation && !state.calculation.ok && <ValidationMessages issues={state.calculation.errors} />}
          {result && result.allocation.status !== "complete" && <div className="project-message warning" role="status">
            Сумма долей — {numberText(result.allocation.totalPercent)}%, требуется 100%. Распределение можно сохранить как черновик; бюджеты направлений пока предварительные.
          </div>}
          <nav className="project-tabs" role="tablist" aria-label="План квартала">{tabs.map((item) => <button key={item.id}
            type="button" role="tab" id={`project-tab-${item.id}`} aria-selected={tab === item.id}
            aria-controls="project-panel" onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
          <fieldset disabled={disabled} aria-busy={disabled}>
            <section id="project-panel" role="tabpanel" aria-labelledby={`project-tab-${tab}`} key={`${state.activePlanId}-${tab}`}>
              {tab === "team" && <TeamEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "calendar" && <CalendarEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "absences" && <AbsenceEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "allocation" && <AllocationEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "tasks" && <>
                <TasksEditor snapshot={state.draft} update={actions.updateDraft} onGoToAllocation={() => setTab("allocation")} />
                <BalanceSummary snapshot={state.draft} result={result} />
              </>}
            </section>
          </fieldset>
        </>}
      </main>
    </>}
    {state.confirmation && <DiscardDialog message={state.confirmation.message} onAnswer={actions.answerDiscard} />}
  </div>;
}

function TeamEditor({ snapshot, update, result }: EditorProps) {
  const [removeId, setRemoveId] = useState<string | null>(null);
  const removeMember = snapshot.members.find((member) => member.id === removeId);
  const setMember = (id: string, patch: Partial<QuarterSnapshot["members"][number]>) => update((current) => ({
    ...current, members: current.members.map((member) => member.id === id ? { ...member, ...patch } : member)
  }));
  return <div className="project-stack">
    <div className="project-section-heading"><div><h2>Состав команды</h2><p>У каждого сотрудника одна компетенция. Ставка 0,5 означает половину рабочего дня.</p></div>
      <button type="button" disabled={!snapshot.competencies.length} onClick={() => update((current) => ({ ...current,
        members: [...current.members, { id: newId(), name: "", competencyId: current.competencies[0]?.id ?? "", fte: "1" }]
      }))}>Добавить сотрудника</button>
    </div>
    {removeMember && <div className="project-message warning" role="alert">
      <p>Удалить сотрудника «{removeMember.name || "Без имени"}» из этого квартала? Вместе с ним будут удалены связанные отсутствия ({snapshot.absences.filter((absence) => absence.memberId === removeId).length}).</p>
      <div className="project-actions"><button className="secondary" type="button" onClick={() => setRemoveId(null)}>Отмена</button>
        <button className="danger" type="button" onClick={() => {
          update((current) => ({ ...current, members: current.members.filter((member) => member.id !== removeId),
            absences: current.absences.filter((absence) => absence.memberId !== removeId) }));
          setRemoveId(null);
        }}>Удалить сотрудника и отсутствия</button></div>
    </div>}
    <div className="data-table-wrap"><table className="project-table"><thead><tr>
      <th>Имя сотрудника</th><th>Компетенция</th><th>Ставка</th><th className="project-number">Отсутствий, раб. дней</th>
      <th className="project-number">Доступных дней</th><th className="project-number">Доступно часов</th><th><span className="project-muted">Действия</span></th>
    </tr></thead><tbody>
      {snapshot.members.map((member, index) => {
        const capacity = result?.members.find((row) => row.memberId === member.id);
        return <tr key={member.id}>
          <td><input className="project-wide-input" aria-label={`Имя сотрудника ${index + 1}`} value={member.name} maxLength={1000}
            placeholder="Введите имя" onChange={(event) => setMember(member.id, { name: event.target.value })} /></td>
          <td><select aria-label={`Компетенция сотрудника ${index + 1}`} value={member.competencyId}
            onChange={(event) => setMember(member.id, { competencyId: event.target.value })}>
            <option value="" disabled>Выберите компетенцию</option>
            {snapshot.competencies.map((competency) => <option key={competency.id} value={competency.id}>{competency.name || "Без названия"}</option>)}
          </select></td>
          <td><input className="project-decimal-input" inputMode="decimal" aria-label={`Ставка сотрудника ${index + 1}`} value={numberText(member.fte)}
            onChange={(event) => setMember(member.id, { fte: event.target.value.replace(",", ".") })}
            onBlur={(event) => {
              const value = finishDecimal(event.target.value);
              if (value !== member.fte) setMember(member.id, { fte: value });
            }} /></td>
          <td className="project-number">{capacity?.absenceWorkingDays ?? "—"}</td><td className="project-number">{capacity?.availableDays ?? "—"}</td>
          <td className="project-number">{capacity ? formatHours(capacity.availableHours) : "—"}</td>
          <td className="project-row-action"><button type="button" className="danger" onClick={() => setRemoveId(member.id)} aria-label={`Удалить сотрудника ${member.name || index + 1}`}>Удалить</button></td>
        </tr>;
      })}
      {!snapshot.members.length && <tr><td colSpan={7} className="project-table-empty">Пока нет сотрудников. Добавьте первого участника команды.</td></tr>}
    </tbody></table></div>
    <div className="project-two-columns project-competencies">
      <section><h3>Компетенции команды</h3><p className="project-muted">Названия можно изменить. Удалить можно только компетенцию без сотрудников.</p>
        <div className="data-table-wrap"><table className="project-table"><thead><tr><th>Название</th><th>Действия</th></tr></thead><tbody>
          {snapshot.competencies.map((competency, index) => {
            const used = snapshot.members.some((member) => member.competencyId === competency.id);
            return <tr key={competency.id}><td><input value={competency.name} maxLength={1000} aria-label={`Название компетенции ${index + 1}`}
              onChange={(event) => update((current) => ({ ...current, competencies: current.competencies.map((item) => item.id === competency.id ? { ...item, name: event.target.value } : item) }))} /></td>
              <td className="project-row-action"><button className="secondary" type="button" disabled={used} title={used ? "Компетенция используется сотрудниками" : "Удалить компетенцию"}
                onClick={() => update((current) => ({ ...current, competencies: current.competencies.filter((item) => item.id !== competency.id) }))}>Удалить</button></td></tr>;
          })}
        </tbody></table></div>
        <div className="project-table-footer"><button className="secondary" type="button" onClick={() => update((current) => ({ ...current,
          competencies: [...current.competencies, { id: newId(), name: "" }]
        }))}>Добавить компетенцию</button></div>
      </section>
      <section><h3>Часы по компетенциям</h3><div className="data-table-wrap"><table className="project-table"><thead><tr><th>Компетенция</th><th className="project-number">Сотрудников</th><th className="project-number">Часов</th></tr></thead>
        <tbody>{result?.competencies.map((competency) => <tr key={competency.competencyId}><td>{competency.name}</td><td className="project-number">{competency.memberCount}</td><td className="project-number">{formatHours(competency.availableHours)}</td></tr>)}
          {!result && <tr><td colSpan={3} className="project-table-empty">Заполните данные для расчёта.</td></tr>}
        </tbody></table></div></section>
    </div>
  </div>;
}

function CalendarEditor({ snapshot, update }: EditorProps) {
  const dates = getQuarterDates(snapshot.year, snapshot.quarter);
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const overrides = getCalendarOverrides(snapshot);
  const changedDates = new Set(overrides?.map((day) => day.date));
  const calendar = new Map(snapshot.calendar.map((day) => [day.date, day.isWorking]));
  const dateObject = (date: string) => new Date(`${date}T12:00:00Z`);
  const setDay = (date: string, isWorking: boolean) => update((current) => ({ ...current,
    calendar: [...current.calendar.filter((day) => day.date !== date), { date, isWorking }].sort((left, right) => left.date.localeCompare(right.date))
  }));
  return <>
    <div className="project-section-heading"><div><h2>Календарь квартала</h2><p>Отметьте рабочие дни. Поправки общие для команды и сохраняются вместе с кварталом.</p></div></div>
    <div className={`project-message ${snapshot.calendarSource?.kind === "ru-official" ? "" : "warning"}`}>
      {snapshot.calendarSource?.kind === "ru-official"
        ? <p>Основа — календарь РФ для пятидневной рабочей недели. Можно изменить любой день. Сокращённые рабочие дни учитываются как полные.</p>
        : snapshot.calendarSource?.kind === "manual"
          ? <p>Основа — пятидневка без праздников и переносов. Проверьте календарь вручную перед использованием итоговых часов.</p>
          : <p>Используются дни из сохранённого плана. Источник календаря не указан; проверьте рабочие дни.</p>}
      {snapshot.calendarSource?.sourceUrls?.length ? <details className="project-calendar-sources"><summary>Источники календаря</summary>
        {snapshot.calendarSource.sourceUrls.map((url) => <p key={url} className="project-muted">{url}</p>)}
      </details> : null}
    </div>
    <div className="project-calendar-legend"><span>Галочка — рабочий день</span><span>Без галочки — выходной</span>
      <span>{overrides === null ? "Ручные поправки не выделены для этого плана" : `Ручных поправок: ${overrides.length}`}</span></div>
    <div className="project-calendar-months">{months.map((month) => <section className="project-calendar-month" key={month}>
      <h3>{dateObject(`${month}-01`).toLocaleDateString("ru-RU", { month: "long", timeZone: "UTC" })}</h3>
      <table className="project-table"><thead><tr><th>Дата</th><th>Рабочий день</th><th>Поправка</th></tr></thead><tbody>
        {dates.filter((date) => date.startsWith(month)).map((date) => {
          const isWorking = calendar.get(date);
          const label = dateObject(date).toLocaleDateString("ru-RU", { day: "numeric", weekday: "short", timeZone: "UTC" });
          return <tr key={date} className={isWorking === false ? "non-working" : ""}><td>{label}</td><td>
            {isWorking === undefined ? <select aria-label={`Статус дня ${date}`} value="" onChange={(event) => setDay(date, event.target.value === "working")}>
              <option value="" disabled>Не задан</option><option value="working">Рабочий</option><option value="rest">Выходной</option>
            </select> : <input type="checkbox" aria-label={`Рабочий день ${date}`} checked={isWorking} onChange={(event) => setDay(date, event.target.checked)} />}
          </td><td className="project-muted">{changedDates.has(date) ? "Изменён" : "—"}</td></tr>;
        })}
      </tbody></table>
    </section>)}</div>
  </>;
}

function AbsenceEditor({ snapshot, update }: EditorProps) {
  const firstDate = getQuarterDates(snapshot.year, snapshot.quarter)[0];
  const setAbsence = (id: string, patch: Partial<QuarterSnapshot["absences"][number]>) => update((current) => ({ ...current,
    absences: current.absences.map((absence) => absence.id === id ? { ...absence, ...patch } : absence)
  }));
  return <>
    <div className="project-section-heading"><div><h2>Отсутствия</h2><p>Обе даты включены в период. Из доступных часов вычитаются только рабочие дни; пересечения не вычитаются повторно.</p></div>
      <button type="button" disabled={!snapshot.members.length} onClick={() => update((current) => ({ ...current,
        absences: [...current.absences, { id: newId(), memberId: current.members[0]?.id ?? "", startDate: firstDate, endDate: firstDate }]
      }))}>Добавить отсутствие</button>
    </div>
    <div className="data-table-wrap"><table className="project-table"><thead><tr><th>Сотрудник</th><th>Первый день</th><th>Последний день</th><th>Действия</th></tr></thead><tbody>
      {snapshot.absences.map((absence, index) => <tr key={absence.id}>
        <td><select value={absence.memberId} aria-label={`Сотрудник в отсутствии ${index + 1}`} onChange={(event) => setAbsence(absence.id, { memberId: event.target.value })}>
          {snapshot.members.map((member) => <option value={member.id} key={member.id}>{member.name || "Сотрудник без имени"}</option>)}
        </select></td>
        <td><input type="date" aria-label={`Первый день отсутствия ${index + 1}`} value={absence.startDate} onChange={(event) => setAbsence(absence.id, { startDate: event.target.value })} /></td>
        <td><input type="date" aria-label={`Последний день отсутствия ${index + 1}`} value={absence.endDate} onChange={(event) => setAbsence(absence.id, { endDate: event.target.value })} /></td>
        <td className="project-row-action"><button type="button" className="danger" onClick={() => update((current) => ({ ...current, absences: current.absences.filter((item) => item.id !== absence.id) }))}>Удалить</button></td>
      </tr>)}
      {!snapshot.absences.length && <tr><td colSpan={4} className="project-table-empty">{snapshot.members.length ? "Отсутствия пока не добавлены." : "Сначала добавьте сотрудников во вкладке «Команда»."}</td></tr>}
    </tbody></table></div>
  </>;
}

function AllocationEditor({ snapshot, update, result }: EditorProps) {
  const hasTasks = snapshot.tasks.length > 0;
  const setDirection = (id: string, patch: Partial<QuarterSnapshot["directions"][number]>) => update((current) => ({ ...current,
    directions: current.directions.map((direction) => direction.id === id ? { ...direction, ...patch } : direction)
  }));
  return <>
    <div className="project-section-heading"><div><h2>Распределение часов</h2><p>Доли применяются ко всем доступным часам команды. Встречи можно добавить отдельным направлением.</p></div>
      <button type="button" onClick={() => update((current) => ({ ...current, directions: [...current.directions, { id: newId(), name: "", percent: "0" }] }))}>Добавить направление</button>
    </div>
    <div className="data-table-wrap"><table className="project-table"><thead><tr><th>Направление</th><th>Доля, %</th><th className="project-number">Бюджет часов</th><th>Действия</th>
    </tr></thead><tbody>
      {snapshot.directions.map((direction, index) => {
        const capacity = result?.directions.find((row) => row.directionId === direction.id);
        const used = snapshot.tasks.some((task) => task.directionId === direction.id);
        return <tr key={direction.id}>
          <td><input className="project-wide-input" aria-label={`Название направления ${index + 1}`} value={direction.name} maxLength={1000} placeholder="Продукт, встречи, техдолг…" onChange={(event) => setDirection(direction.id, { name: event.target.value })} /></td>
          <td><input className="project-decimal-input" aria-label={`Доля направления ${index + 1}`} inputMode="decimal" value={numberText(direction.percent)}
            onChange={(event) => setDirection(direction.id, { percent: event.target.value.replace(",", ".") })}
            onBlur={(event) => {
              const value = finishDecimal(event.target.value);
              if (value !== direction.percent) setDirection(direction.id, { percent: value });
            }} /></td>
          <td className="project-number">{capacity ? formatHours(capacity.budgetHours) : "—"}
            {capacity && !capacity.budgetComplete && <div className="project-muted">Предварительный</div>}</td>
          <td className="project-row-action"><button type="button" className="danger" disabled={used}
            aria-label={`Удалить направление ${direction.name.trim() || index + 1}`}
            title={used ? "Перенесите/удалите задачи во вкладке «Задачи»" : "Удалить направление"}
            onClick={() => update((current) => current.tasks.some((task) => task.directionId === direction.id) ? current
              : { ...current, directions: current.directions.filter((item) => item.id !== direction.id) })}>Удалить</button></td>
        </tr>;
      })}
      {!snapshot.directions.length && <tr><td colSpan={4} className="project-table-empty">Добавьте направления и распределите между ними 100% доступных часов.</td></tr>}
    </tbody></table></div>
    {result && <p className="project-table-footer">Сумма долей: <strong>{numberText(result.allocation.totalPercent)}%</strong>
      {result.allocation.status === "complete" ? "Распределение заполнено." : "Для полного распределения требуется 100%."}</p>}
    {hasTasks && <p className="project-muted">Направление с задачами удалить нельзя. Перенесите/удалите задачи во вкладке «Задачи».</p>}
    <BalanceSummary snapshot={snapshot} result={result} />
  </>;
}

function BalanceSummary({ snapshot, result }: Pick<EditorProps, "snapshot" | "result">) {
  const statusLabels = { surplus: "Остаток", balanced: "Баланс", deficit: "Дефицит", preliminary: "Предварительно" };
  return <section className="project-balance-summary" aria-labelledby="direction-summary-title">
    <div className="project-section-heading"><div><h2 id="direction-summary-title">Баланс направлений</h2>
      <p>Бюджет, потребность по задачам и остаток часов за выбранный квартал. Направления без задач сохраняют свой резерв.</p></div></div>
    <div className="data-table-wrap"><table className="project-table project-direction-summary" aria-label="Баланс направлений">
      <thead><tr><th>Направление</th><th className="project-number">Бюджет часов</th><th className="project-number">Потребность</th><th className="project-number">Баланс часов</th><th>Статус</th></tr></thead>
      <tbody>{snapshot.directions.map((direction) => {
        const capacity = result?.directions.find((row) => row.directionId === direction.id);
        const balance = capacity ? describeDirectionBalance(capacity) : null;
        return <tr key={direction.id} data-direction-id={direction.id} data-status={balance?.status ?? "unavailable"}>
          <td>{direction.name || "Направление без названия"}</td>
          <td className="project-number project-direction-budget">{capacity ? formatHours(capacity.budgetHours) : "—"}
            {capacity && !capacity.budgetComplete && <div className="project-muted">Предварительный</div>}</td>
          <td className="project-number project-direction-demand" aria-label={`Потребность направления ${direction.name}`}>
            <span className="project-balance-label">{balance?.demandLabel ?? "Потребность"}</span>
            <strong className="project-balance-value">{balance?.demandText ?? "—"}</strong>
          </td>
          <td className={`project-number project-direction-balance${balance?.deficit ? " project-deficit" : ""}`} aria-label={`Баланс направления ${direction.name}`}>
            <span className="project-balance-label">{balance?.balanceLabel ?? "Баланс"}</span>
            <strong className="project-balance-value">{balance?.balanceText ?? "—"}</strong>
          </td>
          <td className="project-direction-status"><span className={`project-balance-status ${balance?.status ?? "unavailable"}`}>{balance ? statusLabels[balance.status] : "Нет расчёта"}</span>
            {(balance?.note || !balance) && <p className="project-balance-note">{balance?.note || "Исправьте незаполненные или некорректные данные плана."}</p>}
          </td>
        </tr>;
      })}
      {!snapshot.directions.length && <tr><td colSpan={5} className="project-table-empty">Свод появится после добавления направлений.</td></tr>}
      </tbody>
    </table></div>
    <p className="project-muted project-balance-limitation">Остаток общих часов не подтверждает достаточность каждой компетенции: оценки задач не разбиты по специальностям.</p>
  </section>;
}

function DiscardDialog({ message, onAnswer }: { message: string; onAnswer: (discard: boolean) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const discard = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onAnswer(false); }
    if (event.key === "Tab") {
      event.preventDefault();
      if (document.activeElement === cancel.current) discard.current?.focus();
      else cancel.current?.focus();
    }
  }
  return <div className="project-modal-backdrop">
    <div className="project-modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-message" onKeyDown={handleKey}>
      <h2 id="discard-title">Несохранённые изменения</h2><p id="discard-message">{message}</p>
      <div className="project-actions"><button ref={cancel} className="secondary" type="button" onClick={() => onAnswer(false)}>Вернуться</button>
        <button ref={discard} className="danger" type="button" onClick={() => onAnswer(true)}>Не сохранять</button></div>
    </div>
  </div>;
}
