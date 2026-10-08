import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import appIcon from "../../src-tauri/icons/128x128.png";
import { useProjectWorkspace } from "./project-workspace";
import { PROJECT_NAME_FORM, quarterTitle } from "./project-workspace-controller";
import { DiscardDialog, FormatUpgradeDialog, NewQuarterDialog } from "./ProjectDialogs";
import { HelpDialog, type HelpTab } from "./HelpDialog";
import { PlanTab } from "./PlanTab";
import { DeleteButton, DIALOG_ROOT_ID, InfoHint, PencilIcon, restoreFocus } from "./project-ui";
import { hours, isMac, saveShortcut, Sign } from "./plan-ui";
import { SourcesTab } from "./SourcesTab";
import { describeCompetencyInUse, describeValidationIssue } from "./validation-text";
import { getQuarterDates, type Quarter } from "../domain/capacity/calendar-quarter";
import { formatDeficitHours, normalizeUserDecimal } from "../domain/capacity/input-format";
import { calculateQuarterCapacity } from "../domain/capacity/quarter-capacity.calculator";
import { getCalendarOverrides, type CalendarMode } from "../domain/capacity/project-calendar";
import { describeQuarterSprints, type QuarterSprints } from "../domain/capacity/quarter-sprints";
import { pluralRu } from "../domain/capacity/quarter-totals";
import { describeAllocation, effectivePercent, formatPercent } from "../domain/capacity/source-plan";
import type { QuarterCapacityResult, QuarterSnapshot, QuarterValidationIssue } from "../domain/capacity/quarter-capacity.types";
import "../styles/project-app.css";
import "../styles/quarter-planner.css";

type Tab = HelpTab;
type UpdateDraft = (update: (current: QuarterSnapshot) => QuarterSnapshot) => void;
type EditorProps = { snapshot: QuarterSnapshot; update: UpdateDraft; result: QuarterCapacityResult | null };
const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "team", label: "Команда" },
  { id: "calendar", label: "Календарь" },
  { id: "absences", label: "Отсутствия" },
  { id: "sources", label: "Источники и доли" },
  { id: "plan", label: "План квартала" }
];
const nameGuard = PROJECT_NAME_FORM;
const newId = () => crypto.randomUUID();
const numberText = (value: string) => value.replace(".", ",");
/** A preview build says so in the window (0.4.0-alpha.1); a release shows nothing extra. */
const PREVIEW_VERSION = __APP_VERSION__.includes("-") ? __APP_VERSION__ : null;

/** "Сохраните квартал" → "Отчёт: сохраните квартал"; a hint that already names the report stays as is. */
function reportHint(hint: string): string {
  return hint.startsWith("Отчёт") ? hint : `Отчёт: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`;
}

/** Normalize presentation only. Invalid and unfinished input stays in the draft. */
function finishDecimal(value: string): string {
  try { return normalizeUserDecimal(value) ?? value; }
  catch { return value; }
}

const dateObject = (date: string) => new Date(`${date}T12:00:00Z`);
const monthName = (month: string) => dateObject(`${month}-01`).toLocaleDateString("ru-RU", { month: "long", timeZone: "UTC" });
const dayMonth = (date: string) => dateObject(date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
function dateRange(start: string, end: string): string {
  if (start === end) return dayMonth(start);
  return start.slice(0, 7) === end.slice(0, 7) ? `${Number(start.slice(8))}–${dayMonth(end)}` : `${dayMonth(start)} – ${dayMonth(end)}`;
}

function ValidationMessages({ issues }: { issues: QuarterValidationIssue[] }) {
  return <div className="project-message warning" role="status">
    <strong>Расчёт появится после заполнения данных.</strong>
    <ul>{issues.slice(0, 8).map((issue, index) => <li key={`${issue.path}-${index}`}>{describeValidationIssue(issue)}</li>)}</ul>
    {issues.length > 8 && <p>Есть и другие незаполненные или некорректные поля.</p>}
  </div>;
}

export default function ProjectApp() {
  const { state, actions } = useProjectWorkspace();
  const [newProjectName, setNewProjectName] = useState("");
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [creatingQuarter, setCreatingQuarter] = useState(false);
  const [uiError, setUiError] = useState("");
  const [tab, setTab] = useState<Tab>("plan");
  const [planSource, setPlanSource] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tabDialog, setTabDialog] = useState(false);
  const [saveHint, setSaveHint] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const projectId = state.project?.projectId;
  const projectName = state.project?.name;
  const disabled = state.busy || !state.closeProtectionReady || choosingFolder;
  const result = state.calculation?.ok ? state.calculation.result : null;
  const nameChanged = renaming && projectNameDraft !== state.project?.name;
  const unsaved = state.dirty || nameChanged;

  useEffect(() => {
    setProjectNameDraft(projectName ?? "");
    setRenaming(false);
    setCreatingQuarter(false);
    actions.setPendingFormDirty(nameGuard, false);
    setUiError("");
  }, [projectId, projectName, state.activePlanId]);
  useEffect(() => { setPlanSource(null); }, [projectId, state.activePlanId]);

  // The saved version of the active quarter: «сохранено: 10%» markers and quota changes.
  const savedPlan = state.plans.find((plan) => plan.planId === state.activePlanId);
  const savedResult = useMemo(() => {
    if (!savedPlan) return null;
    const calculation = calculateQuarterCapacity(savedPlan.snapshot);
    return calculation.ok ? calculation.result : null;
  }, [savedPlan]);
  const setPending = useCallback((key: string, dirty: boolean, message?: string) => actions.setPendingFormDirty(key, dirty, message), [actions]);
  const onTabDialog = useCallback((open: boolean) => setTabDialog(open), []);

  // Ctrl+S / ⌘S. Leaving the focused field first applies its decimal normalization to the draft;
  // the cursor returns there after saving. The team-name form is saved by its own button.
  const saveFromKeyboard = useRef<() => void>(() => undefined);
  saveFromKeyboard.current = () => {
    // Inside the reserve window Ctrl+S does not save: the window asks to finish with it first.
    if (tabDialog || (creatingQuarter && state.project)) { setSaveHint((count) => count + 1); return; }
    if (disabled || state.confirmation || state.formatUpgrade || creatingQuarter || renaming || !state.draft || !state.dirty) return;
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    focused?.blur();
    void actions.save().finally(() => restoreFocus(focused));
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.code !== "KeyS" && event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      saveFromKeyboard.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const modalOpen = Boolean(state.confirmation) || Boolean(state.formatUpgrade) || (creatingQuarter && Boolean(state.project))
    || (helpOpen && Boolean(state.project)) || tabDialog;
  useEffect(() => { page.current?.toggleAttribute("inert", modalOpen); }, [modalOpen]);

  async function chooseProject(create: boolean) {
    setUiError("");
    if (create && !newProjectName.trim()) {
      setUiError("Укажите название команды.");
      return;
    }
    setChoosingFolder(true);
    try {
      const done = create ? await actions.chooseAndCreateProject(newProjectName) : await actions.chooseAndOpenProject();
      if (done) { setTab(create ? "team" : "plan"); setNewProjectName(""); }
    } finally { setChoosingFolder(false); }
  }

  async function createQuarter(year: number, quarter: Quarter, mode: CalendarMode, copyFrom: string | null) {
    setCreatingQuarter(false);
    setUiError("");
    if (await actions.createPlan(year, quarter, mode, copyFrom)) setTab(copyFrom ? "plan" : "team");
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
    {state.warning && <div className="project-message warning" role="status">{state.warning}</div>}
  </>;

  const status = state.confirmation || state.formatUpgrade ? "Ожидает решения" : state.busy ? "Выполняем…"
    : unsaved ? "Есть несохранённые изменения" : "Все изменения сохранены";

  return <div className="project-app"><div ref={page} className="project-page">
    {!state.project ? <main className="project-welcome">
      <header className="project-welcome-header">
        <img src={appIcon} alt="" width={64} height={64} />
        <div><h1>Capacity Planner</h1><p className="project-welcome-subtitle">Планирование ёмкости команды</p></div>
      </header>
      {PREVIEW_VERSION && <p className="project-message warning project-preview-note">Тестовая версия {PREVIEW_VERSION} с новым форматом проектов. Открывайте учебные проекты или копии своих: проект версии 0.3.0 при первом сохранении обновляется, и версия 0.3.0 его уже не откроет. Перед обновлением создаётся резервная копия.</p>}
      <p className="project-welcome-lead">Люди, рабочие дни и распределение часов на квартал. Каждая команда хранится в отдельной папке на вашем компьютере.</p>
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
      <p className="project-welcome-note project-muted">Для переноса на другой компьютер закройте проект и скопируйте всю его папку. Не выбирайте папку внутри OneDrive или iCloud.</p>
      {disabled && <p role="status">{choosingFolder ? "Выбор папки…" : "Открываем проект…"}</p>}
    </main> : <>
      <header className="project-topbar">
        <div className="project-title">
          {renaming ? <form className="project-inline-form project-rename" onSubmit={(event) => { void rename(event); }}>
            <label>Название команды<input autoFocus required maxLength={1000} value={projectNameDraft} disabled={disabled}
              onChange={(event) => {
                setProjectNameDraft(event.target.value);
                actions.setPendingFormDirty(nameGuard, event.target.value !== state.project?.name);
              }}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} /></label>
            <button type="submit" disabled={disabled || !projectNameDraft.trim() || projectNameDraft === state.project.name}>Сохранить название</button>
            <button type="button" className="secondary" disabled={disabled} onClick={cancelRename}>Отмена</button>
          </form> : <div className="project-title-row"><h1>{state.project.name}</h1>
            <button className="project-icon-button" type="button" disabled={disabled} aria-label="Изменить название команды"
              title="Изменить название команды" onClick={() => setRenaming(true)}><PencilIcon /><span className="visually-hidden">Изменить название команды</span></button>
          </div>}
          {PREVIEW_VERSION && <span className="project-chip preview" title="Новый формат проектов: версия 0.3.0 обновлённый проект не откроет">Тестовая версия {PREVIEW_VERSION}</span>}
          <div className="project-path" title="Папка проекта">{state.project.folderPath.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "")}</div>
        </div>
        <span className={`project-status ${state.confirmation || state.formatUpgrade || unsaved ? "dirty" : "saved"}`} role="status">{status}</span>
        <button type="button" className="project-save-button" data-shortcut={saveShortcut} disabled={disabled || !state.draft || !state.dirty}
          aria-label="Сохранить квартал" aria-keyshortcuts={isMac ? "Meta+S" : "Control+S"}
          title={`Сохранить квартал (${saveShortcut})`} onClick={() => { void actions.save(); }}>Сохранить квартал</button>
        <button className="secondary" type="button" disabled={disabled || !state.report.available}
          title={state.report.hint || "Сохранить отчёт по сохранённому кварталу в файл Excel"}
          onClick={() => { void actions.exportReport(); }}>Выгрузить отчёт</button>
        <button className="secondary" type="button" disabled={disabled} onClick={() => { void actions.closeProject(); }}>Закрыть проект</button>
      </header>
      <main className="project-content">
        {messages}
        <div className="project-period-bar">
          <label className="project-plan-select"><span className="visually-hidden">Квартал</span>
            <select value={state.activePlanId ?? ""} disabled={disabled || !state.plans.length} aria-label="Квартал"
              onChange={(event) => { void actions.selectPlan(event.target.value); }}>
              <option value="" disabled>{state.plans.length ? "Выберите квартал" : "Кварталов пока нет"}</option>
              {[...state.plans].sort((a, b) => b.snapshot.year - a.snapshot.year || b.snapshot.quarter - a.snapshot.quarter)
                .map((plan) => <option key={plan.planId} value={plan.planId}>{plan.snapshot.quarter} квартал {plan.snapshot.year} года</option>)}
            </select></label>
          <button className="secondary" type="button" disabled={disabled} onClick={() => setCreatingQuarter(true)}>Новый квартал…</button>
          <button className="project-link-button project-help-link" type="button" disabled={disabled} onClick={() => setHelpOpen(true)}>Как составить план квартала</button>
          {state.draft && <div className="project-period-side">
            {!state.report.available && state.report.hint && <span className="project-muted project-report-hint" role="status">{reportHint(state.report.hint)}</span>}
            <PeriodFacts snapshot={state.draft} result={result} />
          </div>}
        </div>

        {!state.draft ? <div className="empty-state">Создайте квартал кнопкой «Новый квартал…» или выберите сохранённый, чтобы добавить сотрудников и настроить рабочие дни.</div> : <>
          <PlanTotals result={result} />
          {state.calculation && !state.calculation.ok && <ValidationMessages issues={state.calculation.errors} />}
          <nav className="project-tabs" role="tablist" aria-label="Разделы квартала">{tabs.map((item) => {
            // Shares above 100% are an error of the plan; an unfinished allocation is not (DEC-029–035).
            const marked = item.id === "sources" && result !== null && result.plan.overallocated;
            return <button key={item.id} type="button" role="tab" id={`project-tab-${item.id}`} aria-selected={tab === item.id}
              aria-controls="project-panel" aria-describedby={marked ? "allocation-over" : undefined}
              title={marked ? "Сумма долей больше 100%" : undefined}
              onClick={() => setTab(item.id)}>{item.label}{marked && <span className="project-tab-marker" aria-hidden="true" />}</button>;
          })}</nav>
          <span id="allocation-over" className="visually-hidden">Сумма долей больше 100%</span>
          <fieldset disabled={disabled} aria-busy={disabled}>
            <section id="project-panel" role="tabpanel" aria-labelledby={`project-tab-${tab}`} key={`${state.activePlanId}-${tab}`}>
              {tab === "team" && <TeamEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "calendar" && <CalendarEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "absences" && <AbsenceEditor snapshot={state.draft} update={actions.updateDraft} result={result} />}
              {tab === "sources" && state.activePlanId && <SourcesTab planId={state.activePlanId} quarter={quarterTitle(state.draft)}
                snapshot={state.draft} saved={savedPlan?.snapshot ?? null} result={result} savedResult={savedResult}
                update={actions.updateDraft} setPending={setPending} saveHint={saveHint} onDialog={onTabDialog} />}
              {tab === "plan" && state.activePlanId && <PlanTab planId={state.activePlanId} quarter={quarterTitle(state.draft)}
                snapshot={state.draft} result={result} update={actions.updateDraft}
                workInputs={state.workInputs} lastMarks={state.lastMarks}
                setWorkInput={actions.setWorkInput} rememberMark={actions.rememberMark}
                sourceId={planSource} onSourceChange={setPlanSource} onGoToTab={setTab} />}
            </section>
          </fieldset>
        </>}
      </main>
    </>}
    </div>
    <div id={DIALOG_ROOT_ID} />
    {helpOpen && state.project && <HelpDialog onClose={() => setHelpOpen(false)} onGoToTab={(next) => { setHelpOpen(false); setTab(next); }} />}
    {creatingQuarter && state.project && <NewQuarterDialog plans={state.plans} saveHint={saveHint} onCancel={() => setCreatingQuarter(false)}
      onCreate={(year, quarter, mode, copyFrom) => { void createQuarter(year, quarter, mode, copyFrom); }} />}
    {state.confirmation && <DiscardDialog message={state.confirmation.message} details={state.confirmation.details}
      canSave={state.confirmation.canSave} onAnswer={actions.answerDiscard} />}
    {state.formatUpgrade && <FormatUpgradeDialog message={state.formatUpgrade.message} folderPath={state.formatUpgrade.folderPath}
      onAnswer={actions.answerFormatUpgrade} />}
  </div>;
}

function workingDayCount(snapshot: QuarterSnapshot, result: QuarterCapacityResult | null): number {
  return result?.totals.workingDays ?? snapshot.calendar.filter((day) => day.isWorking).length;
}

function PeriodFacts({ snapshot, result }: { snapshot: QuarterSnapshot; result: QuarterCapacityResult | null }) {
  const days = workingDayCount(snapshot, result);
  const sprints = describeQuarterSprints(snapshot.year, snapshot.quarter, snapshot.calendar).sprints.length;
  const calendar = snapshot.calendarSource?.kind === "ru-official" ? `Календарь РФ ${snapshot.year}`
    : snapshot.calendarSource?.kind === "manual" ? "Ручной календарь" : "Календарь плана";
  return <span className="project-period-facts">
    {calendar} · {days} {pluralRu(days, "рабочий день", "рабочих дня", "рабочих дней")} · {sprints} {pluralRu(sprints, "спринт", "спринта", "спринтов")}
    <InfoHint info="sprints" />
  </span>;
}

/**
 * The team balance in the manager's order (QUARTER_PLANNING.md): available → reserve → works
 * in the plan → rests of quotas → not allocated. Reserve and works are never summed up.
 */
function PlanTotals({ result }: { result: QuarterCapacityResult | null }) {
  const plan = result?.plan;
  const allocation = result ? describeAllocation(result) : null;
  const members = result?.totals.memberCount ?? 0;
  const reserves = result?.directions.filter((direction) => direction.kind === "reserve") ?? [];
  const reservePercent = reserves.length === 1 && result ? effectivePercent(reserves[0], result.totals.availableHours) : null;
  return <section className="project-totals project-totals-plan" aria-label="Итоги квартала">
    <div className="project-total">
      <span className="project-total-label">Доступно команде <InfoHint info="available" /></span>
      <strong>{result ? hours(result.totals.availableHours) : "—"}</strong>
      <span className="project-total-note">{members} {pluralRu(members, "сотрудник", "сотрудника", "сотрудников")} · после отсутствий и ставок</span>
    </div>
    <div className="project-total">
      <span className="project-total-label">Резерв на встречи <InfoHint info="reserve" /></span>
      <strong>{plan && plan.reserveCount ? hours(plan.reserveHours) : "—"}</strong>
      <span className="project-total-note">{!plan ? "" : !plan.reserveCount ? "не задан"
        : `${reservePercent !== null ? `${formatPercent(reservePercent)} · ` : ""}${reserves.length === 1 ? reserves[0].name : `${reserves.length} резерва`}${reserves.some((row) => row.ownPercentCount) ? ", с долями сотрудников" : ""}`}</span>
    </div>
    <div className="project-total">
      <span className="project-total-label">Занято работами <InfoHint info="planned" /></span>
      <strong>{plan ? <>{plan.plannedMissingEstimateCount ? <span className="pp-q">не менее </span> : null}{hours(plan.plannedKnownHours)}</> : "—"}</strong>
      <span className="project-total-note">{!plan ? "" : plan.plannedMissingEstimateCount
        ? <Sign tone="unknown">{plan.plannedMissingEstimateCount} {pluralRu(plan.plannedMissingEstimateCount, "работа", "работы", "работ")} без оценки</Sign>
        : plan.planCount ? "по оценкам работ в плане квартала" : "работ в плане нет"}</span>
    </div>
    <div className="project-total">
      <span className="project-total-label">Остатки квот <InfoHint info="rest" /></span>
      <strong>{plan ? <>{plan.plannedMissingEstimateCount && plan.remainingHours !== "0" ? <span className="pp-q">не более </span> : null}{hours(plan.remainingHours)}</> : "—"}</strong>
      <span className="project-total-note">{!plan ? "" : plan.overrunSourceCount
        ? <Sign tone="over">перебор {formatDeficitHours(plan.overrunHours, hours)} в {plan.overrunSourceCount} {pluralRu(plan.overrunSourceCount, "источнике", "источниках", "источниках")}</Sign>
        : "закреплены за источниками"}</span>
    </div>
    <div className="project-total">
      <span className="project-total-label">Не распределено <InfoHint info="unallocated" /></span>
      <strong className={allocation?.overallocated ? "project-negative" : ""}>{allocation ? hours(allocation.unallocatedHours) : "—"}</strong>
      <span className="project-total-note">{!allocation ? "" : allocation.overallocated
        ? <Sign tone="over">сумма долей {formatPercent(allocation.allocatedPercent)}</Sign>
        : `${formatPercent(allocation.unallocatedPercent)} ёмкости`}</span>
    </div>
  </section>;
}

function SectionHeading({ title, note, id, children }: { title: string; note: string; id?: string; children?: ReactNode }) {
  return <div className="project-section-heading"><div><h2 id={id}>{title}</h2><p>{note}</p></div>{children}</div>;
}

function TeamEditor({ snapshot, update, result }: EditorProps) {
  const [removeId, setRemoveId] = useState<string | null>(null);
  // A competency whose delete button was pressed while people still have it: the reason shows.
  const [kept, setKept] = useState<string | null>(null);
  const removeMember = snapshot.members.find((member) => member.id === removeId);
  const setMember = (id: string, patch: Partial<QuarterSnapshot["members"][number]>) => update((current) => ({
    ...current, members: current.members.map((member) => member.id === id ? { ...member, ...patch } : member)
  }));
  return <div className="project-stack">
    <SectionHeading title="Состав команды" note="Одна компетенция на сотрудника; ставка 0,5 — половина рабочего дня">
      <button type="button" disabled={!snapshot.competencies.length} onClick={() => update((current) => ({ ...current,
        members: [...current.members, { id: newId(), name: "", competencyId: current.competencies[0]?.id ?? "", fte: "1" }]
      }))}>Добавить сотрудника</button>
    </SectionHeading>
    {removeMember && <div className="project-message warning" role="alert">
      <p>Удалить сотрудника «{removeMember.name || "Без имени"}» из этого квартала? Вместе с ним будут удалены связанные отсутствия ({snapshot.absences.filter((absence) => absence.memberId === removeId).length}){snapshot.directions.some((direction) => direction.memberPercents.some((row) => row.memberId === removeId)) ? " и его своя доля в резерве" : ""}.</p>
      <div className="project-actions"><button className="secondary" type="button" onClick={() => setRemoveId(null)}>Отмена</button>
        <button className="danger" type="button" onClick={() => {
          // Own reserve shares refer to the person: they go with them (DEC-038).
          update((current) => ({ ...current, members: current.members.filter((member) => member.id !== removeId),
            absences: current.absences.filter((absence) => absence.memberId !== removeId),
            directions: current.directions.map((direction) => ({ ...direction,
              memberPercents: direction.memberPercents.filter((row) => row.memberId !== removeId) })) }));
          setRemoveId(null);
        }}>Удалить сотрудника и отсутствия</button></div>
    </div>}
    <div className="data-table-wrap"><table className="project-table"><thead><tr>
      <th>Имя сотрудника</th><th>Компетенция</th><th>Ставка <InfoHint info="fte" /></th><th className="project-number">Отсутствий, раб. дней</th>
      <th className="project-number">Доступных дней</th><th className="project-number">Доступно часов</th><th className="project-row-action"><span className="visually-hidden">Действия</span></th>
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
          <td className="project-number">{capacity ? hours(capacity.availableHours) : "—"}</td>
          <td className="project-row-action"><DeleteButton label={`Удалить сотрудника ${member.name || index + 1}`} onClick={() => setRemoveId(member.id)} /></td>
        </tr>;
      })}
      {!snapshot.members.length && <tr><td colSpan={7} className="project-table-empty">Пока нет сотрудников. Добавьте первого участника команды.</td></tr>}
    </tbody></table></div>
    <div className="project-two-columns project-competencies">
      <section><h3>Компетенции команды <InfoHint info="competencyList" /></h3>
        <div className="data-table-wrap"><table className="project-table"><thead><tr><th>Название</th><th className="project-row-action"><span className="visually-hidden">Действия</span></th></tr></thead><tbody>
          {snapshot.competencies.map((competency, index) => {
            const people = snapshot.members.filter((member) => member.competencyId === competency.id).length;
            const reason = people ? describeCompetencyInUse(people) : "";
            const reasonId = `competency-kept-${competency.id}`;
            return <tr key={competency.id}><td><input value={competency.name} maxLength={1000} aria-label={`Название компетенции ${index + 1}`}
              onChange={(event) => update((current) => ({ ...current, competencies: current.competencies.map((item) => item.id === competency.id ? { ...item, name: event.target.value } : item) }))} />
              {reason && <span id={reasonId} className={kept === competency.id ? "project-row-reason" : "visually-hidden"} role={kept === competency.id ? "status" : undefined}>{reason}</span>}</td>
              <td className="project-row-action"><DeleteButton label={`Удалить компетенцию ${competency.name.trim() || index + 1}`} blocked={people > 0}
                title={reason || "Удалить компетенцию"} describedBy={reason ? reasonId : undefined}
                onClick={() => people ? setKept(competency.id)
                  : update((current) => ({ ...current, competencies: current.competencies.filter((item) => item.id !== competency.id) }))} /></td></tr>;
          })}
        </tbody></table></div>
        <div className="project-table-footer"><button className="secondary" type="button" onClick={() => update((current) => ({ ...current,
          competencies: [...current.competencies, { id: newId(), name: "" }]
        }))}>Добавить компетенцию</button></div>
      </section>
      <section><h3>Часы по компетенциям <InfoHint info="competencies" /></h3><div className="data-table-wrap"><table className="project-table"><thead><tr><th>Компетенция</th><th className="project-number">Сотрудников</th><th className="project-number">Часов</th></tr></thead>
        <tbody>{result && snapshot.competencies.map((competency) => {
          // Snapshot order, as in the other tables and the exported report.
          const capacity = result.competencies.find((row) => row.competencyId === competency.id);
          return capacity && <tr key={competency.id}><td>{capacity.name}</td><td className="project-number">{capacity.memberCount}</td><td className="project-number">{hours(capacity.availableHours)}</td></tr>;
        })}
          {!result && <tr><td colSpan={3} className="project-table-empty">Заполните данные для расчёта.</td></tr>}
        </tbody></table></div></section>
    </div>
  </div>;
}

function SprintSummary({ sprints }: { sprints: QuarterSprints }) {
  return <section className="project-sprints" aria-labelledby="sprints-title">
    <div className="project-sprints-heading"><h3 id="sprints-title">Спринты квартала</h3><InfoHint info="sprints" /></div>
    <div className="data-table-wrap"><table className="project-table project-sprint-table"><thead><tr>
      <th>Спринт</th><th>Даты</th><th>Месяц</th><th className="project-number">Рабочих дней</th>
    </tr></thead><tbody>
      {sprints.sprints.map((sprint) => <tr key={sprint.number}>
        <td>{sprint.number}</td><td>{dateRange(sprint.startDate, sprint.endDate)}</td><td>{monthName(sprint.month)}</td>
        <td className="project-number">{sprint.workingDays ?? "—"}</td>
      </tr>)}
    </tbody></table></div>
    {sprints.outside.length > 0 && <p className="project-muted">Вне спринтов: {sprints.outside.map((range) => dateRange(range.startDate, range.endDate)).join(", ")}.</p>}
  </section>;
}

function CalendarEditor({ snapshot, update }: EditorProps) {
  const dates = getQuarterDates(snapshot.year, snapshot.quarter);
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const overrides = getCalendarOverrides(snapshot);
  const changedDates = new Set(overrides?.map((day) => day.date));
  const calendar = new Map(snapshot.calendar.map((day) => [day.date, day.isWorking]));
  const sprints = describeQuarterSprints(snapshot.year, snapshot.quarter, snapshot.calendar);
  const setDay = (date: string, isWorking: boolean) => update((current) => ({ ...current,
    calendar: [...current.calendar.filter((day) => day.date !== date), { date, isWorking }].sort((left, right) => left.date.localeCompare(right.date))
  }));
  return <>
    <SectionHeading title="Календарь квартала" note="Отметьте рабочие дни. Поправки общие для команды и сохраняются вместе с кварталом." />
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
    <SprintSummary sprints={sprints} />
    <div className="project-calendar-legend"><span>Галочка — рабочий день</span><span>Без галочки — выходной</span>
      <span>{overrides === null ? "Ручные поправки не выделены для этого плана" : `Ручных поправок: ${overrides.length}`}</span></div>
    <div className="project-calendar-months">{months.map((month) => {
      const sprintCount = sprints.months.find((item) => item.month === month)?.sprintCount ?? 0;
      return <section className="project-calendar-month" key={month}>
        <h3><span className="project-month-name">{monthName(month)}</span>
          <span className="project-month-sprints"> · {sprintCount} {pluralRu(sprintCount, "спринт", "спринта", "спринтов")}</span></h3>
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
      </section>;
    })}</div>
  </>;
}

function AbsenceEditor({ snapshot, update }: EditorProps) {
  const firstDate = getQuarterDates(snapshot.year, snapshot.quarter)[0];
  const setAbsence = (id: string, patch: Partial<QuarterSnapshot["absences"][number]>) => update((current) => ({ ...current,
    absences: current.absences.map((absence) => absence.id === id ? { ...absence, ...patch } : absence)
  }));
  return <>
    <SectionHeading title="Отсутствия" note="Обе даты включены. Вычитаются только рабочие дни; пересечения не вычитаются повторно.">
      <button type="button" disabled={!snapshot.members.length} onClick={() => update((current) => ({ ...current,
        absences: [...current.absences, { id: newId(), memberId: current.members[0]?.id ?? "", startDate: firstDate, endDate: firstDate }]
      }))}>Добавить отсутствие</button>
    </SectionHeading>
    <div className="data-table-wrap"><table className="project-table"><thead><tr><th>Сотрудник</th><th>Первый день</th><th>Последний день</th><th className="project-row-action"><span className="visually-hidden">Действия</span></th></tr></thead><tbody>
      {snapshot.absences.map((absence, index) => <tr key={absence.id}>
        <td><select value={absence.memberId} aria-label={`Сотрудник в отсутствии ${index + 1}`} onChange={(event) => setAbsence(absence.id, { memberId: event.target.value })}>
          {snapshot.members.map((member) => <option value={member.id} key={member.id}>{member.name || "Сотрудник без имени"}</option>)}
        </select></td>
        <td><input type="date" aria-label={`Первый день отсутствия ${index + 1}`} value={absence.startDate} onChange={(event) => setAbsence(absence.id, { startDate: event.target.value })} /></td>
        <td><input type="date" aria-label={`Последний день отсутствия ${index + 1}`} value={absence.endDate} onChange={(event) => setAbsence(absence.id, { endDate: event.target.value })} /></td>
        <td className="project-row-action"><DeleteButton label={`Удалить отсутствие ${index + 1}`}
          onClick={() => update((current) => ({ ...current, absences: current.absences.filter((item) => item.id !== absence.id) }))} /></td>
      </tr>)}
      {!snapshot.absences.length && <tr><td colSpan={4} className="project-table-empty">{snapshot.members.length ? "Отсутствия пока не добавлены." : "Сначала добавьте сотрудников во вкладке «Команда»."}</td></tr>}
    </tbody></table></div>
  </>;
}
