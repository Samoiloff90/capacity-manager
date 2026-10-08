import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatDeficitHours } from "../domain/capacity/input-format";
import type { QuarterCapacityResult, QuarterDirectionCapacity, QuarterSnapshot, TaskMark } from "../domain/capacity/quarter-capacity.types";
import { isWebLink, QUARTER_INPUT_LIMITS } from "../domain/capacity/quarter-snapshot.validation";
import { pluralRu } from "../domain/capacity/quarter-totals";
import {
  describeAllocation, describeEstimateChange, describeInclusion, describePlanned, describeRest,
  describeRestAfterInclusion, effectivePercent, fillPercent, formatPercent, parseEstimateInput, sameOnScreen, sourceState, ZERO_ESTIMATE_NOTE,
  type SourceState
} from "../domain/capacity/source-plan";
import { changedSinceImport, importDraftKey, pendingRowCount, removeImported, type ImportBatch, type ImportDraft } from "../import/work-import";
import { ImportDialog, onNamePaste } from "./ImportDialog";
import { isBlankWorkInput, workInputKey, type WorkInput } from "./project-workspace-controller";
import { InfoHint } from "./project-ui";
import { BackIcon, ChevronIcon, CloseIcon, DotsIcon, FillBar, hours, Kbd, Sign, TriangleIcon } from "./plan-ui";

type Snapshot = QuarterSnapshot;
type Work = Snapshot["tasks"][number];
type Direction = Snapshot["directions"][number];
type Update = (updater: (current: Snapshot) => Snapshot) => void;
type Mark = WorkInput["mark"];

const works = (count: number) => `${count} ${pluralRu(count, "работа", "работы", "работ")}`;
const estimateText = (work: Pick<Work, "estimateHours">) => work.estimateHours === null ? "без оценки" : hours(work.estimateHours);
const MARK_PLACE: Record<TaskMark, string> = { candidate: "на рассмотрении", plan: "в плане квартала", out: "в «Не в этом квартале»" };

export type PlanTabProps = {
  planId: string;
  quarter: string;
  snapshot: Snapshot;
  result: QuarterCapacityResult | null;
  update: Update;
  workInputs: Readonly<Record<string, WorkInput>>;
  lastMarks: Readonly<Record<string, Mark>>;
  setWorkInput: (key: string, input: WorkInput | null) => void;
  rememberMark: (key: string, mark: Mark) => void;
  sourceId: string | null;
  onSourceChange: (sourceId: string | null) => void;
  onGoToTab: (tab: "team" | "absences" | "sources") => void;
  importDrafts: Readonly<Record<string, ImportDraft>>;
  importBatches: readonly ImportBatch[];
  setImportDraft: (key: string, draft: ImportDraft | null) => void;
  recordImportBatch: (batch: ImportBatch) => void;
  forgetImportBatch: (id: string) => void;
  /** Counts Ctrl+S pressed while a window of this tab is open: the window asks to finish first. */
  saveHint: number;
  onDialog: (open: boolean) => void;
};

/** One step of undo and the numbers before it (DEC-037: «было» — the last action). */
type Undo = { tasks: Snapshot["tasks"]; sourceId: string };
type Ghost = { sourceId: string; text: string; undo: boolean; at?: { mark: TaskMark; index: number } };
/** The import window: opened from a source or from the table of sources (sourceId null). */
type Importing = { sourceId: string | null; text: string | null };
/** «Отменить вставку» waits for an answer when works of the import were changed since. */
type ImportUndo = { batch: ImportBatch; changed: string[]; present: number };

export function PlanTab(props: PlanTabProps) {
  const { snapshot, result, update, planId, sourceId } = props;
  const [undo, setUndo] = useState<Undo | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [before, setBefore] = useState<{ sourceId: string; state: SourceState } | null>(null);
  const [fresh, setFresh] = useState<{ ids: string[]; label: string } | null>(null);
  const [added, setAdded] = useState<{ sourceId: string; text: string } | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [importing, setImporting] = useState<Importing | null>(null);
  const [importUndo, setImportUndo] = useState<ImportUndo | null>(null);
  const { onDialog } = props;
  // Said at once, not in an effect: Ctrl+S right after the window closes must save (ProjectApp).
  const openImport = (sourceId: string | null, text: string | null = null) => { setImporting({ sourceId, text }); onDialog(true); };
  const closeImport = () => { setImporting(null); onDialog(false); };
  useEffect(() => () => onDialog(false), [onDialog]);

  // Focus after the next render: a work row, a form field or a heading.
  useLayoutEffect(() => {
    if (!focusTarget) return;
    const element = document.querySelector<HTMLElement>(focusTarget);
    element?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const source = sourceId ? snapshot.directions.find((direction) => direction.id === sourceId && direction.kind === "work") : undefined;
  useEffect(() => { if (sourceId && !source) props.onSourceChange(null); }, [sourceId, source]); // eslint-disable-line react-hooks/exhaustive-deps

  function clearTransient() {
    setUndo(null); setGhost(null); setBefore(null); setFresh(null); setAdded(null); setImportUndo(null);
  }

  /** Works added from a spreadsheet; the single-step undo would bring them back, so it is dropped. */
  function addImported(at: Importing, list: Work[], rest: ImportDraft | null) {
    const key = importDraftKey(planId, at.sourceId);
    const previous = source ? result?.directions.find((row) => row.directionId === source.id) : undefined;
    clearTransient();
    if (source && previous) setBefore({ sourceId: source.id, state: sourceState(previous) });
    update((current) => ({ ...current, tasks: [...current.tasks, ...list] }));
    if (list.length) props.recordImportBatch({ id: crypto.randomUUID(), planId, works: list, mark: list[0].mark === "plan" ? "plan" : "candidate", openedFrom: at.sourceId });
    props.setImportDraft(key, rest);
    setFresh({ ids: list.map((work) => work.id), label: "из таблицы" });
    if (!rest) {
      closeImport();
      setFocusTarget(source ? "#btn-import" : "#overview-import");
    }
  }

  /** «Отменить вставку»: only the works of that import, after other actions too (DEC-039). */
  function undoImport(batch: ImportBatch, confirmed = false) {
    const { present, changed } = changedSinceImport(batch, snapshot.tasks);
    if (!present) { props.forgetImportBatch(batch.id); setImportUndo(null); return; }
    if (changed.length && !confirmed) { setImportUndo({ batch, changed, present }); return; }
    clearTransient();
    update((current) => ({ ...current, tasks: removeImported(current.tasks, batch) }));
    props.forgetImportBatch(batch.id);
    setGhost({ sourceId: source?.id ?? "", text: `Вставка отменена: удалено ${present} ${pluralRu(present, "работа", "работы", "работ")}.`, undo: false });
    // «Добавить работу» may be disabled while the form is open; this button never is.
    setFocusTarget(source ? "#btn-import" : "#overview-import");
  }

  const importKey = importing ? importDraftKey(planId, importing.sourceId) : null;
  const dialog = importing && importKey && <ImportDialog planId={planId} sourceId={importing.sourceId} quarter={props.quarter}
    snapshot={snapshot} result={result} draft={props.importDrafts[importKey] ?? null} initialText={importing.text}
    saveHint={props.saveHint} onDraft={(draft) => props.setImportDraft(importKey, draft)}
    onAdd={(list, rest) => addImported(importing, list, rest)}
    onClose={closeImport} />;
  const importLine = <ImportLine planId={planId} sourceId={source?.id ?? null} snapshot={snapshot} batches={props.importBatches}
    drafts={props.importDrafts} pending={importUndo} ghost={!source && ghost && !ghost.undo && ghost.sourceId === "" ? ghost.text : null}
    onUndo={(batch, confirmed) => undoImport(batch, confirmed)} onKeep={() => { setImportUndo(null); setFocusTarget("#import-undo"); }}
    onContinue={(sourceId) => openImport(sourceId)} />;

  /** Every change of works keeps one step of undo and the source's numbers before it. */
  function act(source: Direction, mutate: (tasks: Snapshot["tasks"]) => Snapshot["tasks"]) {
    const capacity = result?.directions.find((row) => row.directionId === source.id);
    setUndo({ tasks: snapshot.tasks, sourceId: source.id });
    setBefore(capacity ? { sourceId: source.id, state: sourceState(capacity) } : null);
    setAdded(null);
    update((current) => ({ ...current, tasks: mutate(current.tasks) }));
  }

  function undoLast() {
    if (!undo) return;
    const tasks = undo.tasks;
    update((current) => ({ ...current, tasks }));
    clearTransient();
  }

  function openSource(id: string | null) {
    clearTransient();
    props.onSourceChange(id);
    if (id) {
      const input = props.workInputs[workInputKey(planId, id)];
      setFocusTarget(input?.open ? "#add-name" : "#source-title");
    } else if (source) {
      setFocusTarget(`[data-open-source="${source.id}"]`);
    }
  }

  if (!snapshot.directions.length) return <Setup snapshot={snapshot} result={result} onGoToTab={props.onGoToTab} />;
  if (!source) return <><Overview {...props} onOpen={openSource} onImport={() => openImport(null)} importLine={importLine} />{dialog}</>;
  const capacity = result?.directions.find((row) => row.directionId === source.id);
  return <><SourceWorkspace {...props} source={source} capacity={capacity} undo={undo} ghost={ghost} before={before} fresh={fresh}
    added={added} act={act} onUndo={undoLast} onOpen={openSource} setGhost={setGhost} setFresh={setFresh} setAdded={setAdded}
    setFocusTarget={setFocusTarget} onImport={(text) => openImport(source.id, text)} importLine={importLine} />{dialog}</>;
}

/**
 * Under the source's numbers: the last import with «Отменить вставку», rows of an import still
 * waiting, and the answer asked for when works of the import were changed since.
 */
function ImportLine({ planId, sourceId, snapshot, batches, drafts, pending, ghost, onUndo, onKeep, onContinue }: {
  planId: string; sourceId: string | null; snapshot: Snapshot; batches: readonly ImportBatch[];
  drafts: Readonly<Record<string, ImportDraft>>; pending: ImportUndo | null; ghost: string | null;
  onUndo: (batch: ImportBatch, confirmed?: boolean) => void; onKeep: () => void; onContinue: (sourceId: string | null) => void;
}) {
  const ids = new Set(snapshot.tasks.map((task) => task.id));
  // The import shows where it was started and in every source that got its works.
  const batch = [...batches].reverse().find((item) => item.planId === planId && item.works.some((work) => ids.has(work.id))
    && (sourceId === null || item.openedFrom === sourceId || item.works.some((work) => ids.has(work.id) && work.directionId === sourceId)));
  // In a source the button says «Продолжить вставку (N)»; the table of sources lists them here.
  const waiting = sourceId !== null ? [] : Object.entries(drafts).filter(([, draft]) => draft.planId === planId && pendingRowCount(draft) > 0);
  if (!batch && !waiting.length && !pending && !ghost) return null;
  const kept = batch ? batch.works.filter((work) => ids.has(work.id)) : [];
  const present = kept.length;
  const order = snapshot.directions.map((direction) => direction.id);
  const targets = [...new Set(kept.map((work) => work.directionId))].sort((left, right) => order.indexOf(left) - order.indexOf(right));
  const elsewhere = sourceId !== null && targets.some((id) => id !== sourceId)
    ? ` — в ${targets.map((id) => `«${snapshot.directions.find((direction) => direction.id === id)?.name.trim() || "Без названия"}»`).join(", ")}` : "";
  return <div className="pp-import-line">
    {ghost && <div className="pp-ghost" role="status"><Sign tone="plain">{ghost}</Sign></div>}
    {pending ? <div className="project-message warning" role="alert">
      <p>Работы этой вставки уже меняли: {pending.changed.join("; ")}. Отменить вставку всё равно? Будут удалены все {pending.present} {pluralRu(pending.present, "работа", "работы", "работ")} этой вставки.</p>
      <div className="project-actions"><button type="button" className="secondary" id="import-undo-keep" autoFocus onClick={onKeep}>Не отменять</button>
        <button type="button" className="danger" id="import-undo-confirm" onClick={() => onUndo(pending.batch, true)}>Удалить работы вставки</button></div>
    </div> : batch && <div className="pp-ghost" role="status"><Sign tone="plain">Вставлено из таблицы: {present} {pluralRu(present, "работа", "работы", "работ")} {batch.mark === "plan" ? "в план квартала" : "на рассмотрение"}{elsewhere}.</Sign>
      <button type="button" className="project-link-button" id="import-undo" onClick={() => onUndo(batch)}>Отменить вставку</button></div>}
    {waiting.map(([key, draft]) => {
      // The window the import was started from, not the default source chosen inside it.
      const source = draft.openedFrom ? snapshot.directions.find((direction) => direction.id === draft.openedFrom) : undefined;
      const count = pendingRowCount(draft);
      return <div key={key} className="pp-ghost"><Sign tone="unknown">{count} {pluralRu(count, "строка", "строки", "строк")} из таблицы ещё не {pluralRu(count, "добавлена", "добавлены", "добавлены")}{sourceId === null && source ? ` в «${source.name.trim()}»` : ""}.</Sign>
        <button type="button" className="project-link-button" onClick={() => onContinue(draft.openedFrom)}>Продолжить вставку</button></div>;
    })}
  </div>;
}

function Setup({ snapshot, result, onGoToTab }: Pick<PlanTabProps, "snapshot" | "result" | "onGoToTab">) {
  const people = snapshot.members.length;
  const available = result ? hours(result.totals.availableHours) : "—";
  return <section className="pp-setup" aria-labelledby="setup-title">
    <h2 id="setup-title">Квартал пока не настроен для планирования</h2>
    <p>Работы планируются внутри квот источников. Сейчас все {available} не распределены.</p>
    <div className="pp-setup-cta"><p>Следующий шаг — источники и доли. Можно начать с одного источника и без доли: сумма меньше 100% допустима, работы на рассмотрение можно добавлять сразу.</p>
      <button type="button" id="setup-sources" onClick={() => onGoToTab("sources")}>Настроить источники и доли</button></div>
    <ol className="pp-steps">
      <li className={people ? "done" : "current"}><div><b>Команда</b><p>{people
        ? `${people} ${pluralRu(people, "сотрудник", "сотрудника", "сотрудников")}, ${available} доступно.`
        : "Добавьте сотрудников, их компетенции и ставки."}</p></div>
        <button type="button" className="project-link-button" onClick={() => onGoToTab("team")}>Открыть «Команду»</button></li>
      <li className={people ? "done" : ""}><div><b>Отсутствия</b><p>{snapshot.absences.length
        ? `${snapshot.absences.length} ${pluralRu(snapshot.absences.length, "отсутствие учтено", "отсутствия учтены", "отсутствий учтено")}.`
        : "Отпуска и другие отсутствия уменьшают доступные часы."}</p></div>
        <button type="button" className="project-link-button" onClick={() => onGoToTab("absences")}>Открыть «Отсутствия»</button></li>
      <li className={people ? "current" : ""}><div><b>Источники и доли</b><p>Кому и какую часть квартала вы выделяете, включая резерв на встречи и ритуалы.</p></div>
        <span className="pp-step-state">Следующий шаг</span></li>
      <li><div><b>Работы</b><p>Работы на рассмотрение можно добавлять, как только появится хотя бы один источник. Доли и оценки можно уточнить позже.</p></div>
        <span className="pp-step-state">Когда будет источник</span></li>
    </ol>
  </section>;
}

function Overview({ planId, snapshot, result, workInputs, onOpen, onImport, importLine }: PlanTabProps & {
  onOpen: (id: string) => void; onImport: () => void; importLine: ReactNode;
}) {
  const allocation = result ? describeAllocation(result) : null;
  const workSources = snapshot.directions.filter((direction) => direction.kind === "work");
  const noWorks = workSources.length > 0 && !snapshot.tasks.length;
  const hasInput = (id: string) => {
    const input = workInputs[workInputKey(planId, id)];
    return Boolean(input && !isBlankWorkInput(input));
  };
  return <>
    <div className="project-section-heading"><div><h2>Источники работ <InfoHint info="source" /></h2>
      <p>Откройте источник, чтобы добавить работы или включить их в план квартала.</p></div>
      {workSources.length > 0 && <button type="button" className="secondary" id="overview-import" onClick={onImport}>Вставить из таблицы</button>}</div>
    {importLine}
    {noWorks && <div className="project-message" role="status">Источники и доли заданы, работ пока нет. Откройте источник и добавьте его работы.</div>}
    {!workSources.length && <div className="project-message" role="status">Пока заданы только резервы. Добавьте источник работ во вкладке «Источники и доли».</div>}
    <div className="data-table-wrap"><table className="project-table pp-overview" aria-label="Источники работ">
      <thead><tr><th>Источник</th><th className="project-number">Квота <InfoHint info="quota" /></th>
        <th>Занято работами <InfoHint info="planned" /></th><th>Остаток квоты <InfoHint info="rest" /></th>
        <th>На рассмотрении <InfoHint info="candidate" /></th><th><span className="visually-hidden">Открыть</span></th></tr></thead>
      <tbody>
        {snapshot.directions.map((direction) => {
          const capacity = result?.directions.find((row) => row.directionId === direction.id);
          const effective = capacity && result ? effectivePercent(capacity, result.totals.availableHours) : null;
          if (direction.kind === "reserve") {
            return <tr key={direction.id} className="pp-muted-row">
              <td><b>{direction.name}</b><span className="pp-sub">резерв, без работ{capacity?.ownPercentCount ? " · с долями сотрудников" : ""} <InfoHint info="reserve" /></span></td>
              <td className="project-number">{capacity?.quotaSet ? `${effective === null ? "" : `${formatPercent(effective)} · `}${hours(capacity.budgetHours)}` : "доля не задана"}</td>
              <td>зарезервировано целиком</td><td>—</td><td>—</td><td />
            </tr>;
          }
          const state = capacity ? sourceState(capacity) : null;
          const fill = capacity ? fillPercent(capacity) : null;
          const over = Boolean(capacity?.quotaSet && state && state.overrunHours !== "0");
          const candidates = capacity?.candidateCount
            ? <>{works(capacity.candidateCount)}<span className="pp-sub">{[capacity.candidateKnownHours !== "0" ? hours(capacity.candidateKnownHours) : "",
              capacity.candidateMissingEstimateCount ? `${capacity.candidateMissingEstimateCount} без оценки` : ""].filter(Boolean).join(" и ")}</span></>
            : <span className="project-muted">—</span>;
          return <tr key={direction.id} className="pp-clickable" onClick={() => onOpen(direction.id)}>
            <td><button type="button" className="pp-name" data-open-source={direction.id}
              onClick={(event) => { event.stopPropagation(); onOpen(direction.id); }}>{direction.name}</button>
              {hasInput(direction.id) && <span className="pp-sub pp-draft-mark">✎ незаконченный ввод работы</span>}</td>
            <td className="project-number">{!capacity ? "—" : capacity.quotaSet
              ? `${effective === null ? "" : `${formatPercent(effective)} · `}${hours(capacity.budgetHours)}`
              : <span className="project-muted">доля не задана</span>}</td>
            <td>{!capacity || !state ? "—" : capacity.planCount
              ? <div className="pp-fill"><span>{describePlanned(state, hours)}{fill !== null ? ` · ${state.missingEstimateCount ? "от " : ""}${fill}%` : ""}</span>
                {capacity.quotaSet && <FillBar percent={fill} over={over} />}</div>
              : <span className="project-muted">—</span>}</td>
            <td>{!capacity || !state ? "—" : !capacity.quotaSet
              ? (capacity.planCount ? <Sign tone="unknown">квота не задана</Sign> : <span className="project-muted">появится вместе с долей</span>)
              : over ? <Sign tone="over">Перебор {state.missingEstimateCount ? "не менее " : ""}{formatDeficitHours(state.overrunHours, hours)}</Sign>
              : <><b>{state.missingEstimateCount ? <span className="pp-q">не более </span> : null}{hours(state.remainingHours)}</b>
                {!capacity.planCount && !capacity.candidateCount && !capacity.outCount && <span className="pp-sub">работ пока нет</span>}</>}
              {capacity && capacity.missingEstimateCount > 0 && <span className="pp-sub"><Sign tone="unknown">{capacity.missingEstimateCount} в плане без оценки</Sign></span>}</td>
            <td>{candidates}</td>
            <td className="pp-chev"><ChevronIcon /></td>
          </tr>;
        })}
        {allocation && <tr className="pp-muted-row"><td><b>Не распределено</b> <InfoHint info="unallocated" /><span className="pp-sub">никому не выделено</span></td>
          <td className="project-number">{formatPercent(allocation.unallocatedPercent)} · {hours(allocation.unallocatedHours)}</td><td>—</td>
          <td>{allocation.overallocated ? <Sign tone="over">Сумма долей больше 100%</Sign> : "—"}</td><td>—</td><td /></tr>}
      </tbody>
    </table></div>
  </>;
}

type WorkspaceProps = PlanTabProps & {
  source: Direction;
  capacity: QuarterDirectionCapacity | undefined;
  undo: Undo | null;
  ghost: Ghost | null;
  before: { sourceId: string; state: SourceState } | null;
  fresh: { ids: string[]; label: string } | null;
  added: { sourceId: string; text: string } | null;
  act: (source: Direction, mutate: (tasks: Snapshot["tasks"]) => Snapshot["tasks"]) => void;
  onUndo: () => void;
  onOpen: (id: string | null) => void;
  setGhost: (ghost: Ghost | null) => void;
  setFresh: (fresh: { ids: string[]; label: string } | null) => void;
  setAdded: (added: { sourceId: string; text: string } | null) => void;
  setFocusTarget: (selector: string) => void;
  onImport: (text: string | null) => void;
  importLine: ReactNode;
};

type EditState = { id: string; name: string; estimate: string; link: string; comment: string; tried: boolean };

function SourceWorkspace(props: WorkspaceProps) {
  const { planId, quarter, snapshot, result, source, capacity, undo, ghost, before, fresh, act, setGhost, setFresh, setFocusTarget } = props;
  const key = workInputKey(planId, source.id);
  const input = props.workInputs[key];
  const [edit, setEdit] = useState<EditState | null>(null);
  const [showOut, setShowOut] = useState(false);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const [stuck, setStuck] = useState(false);
  const head = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = head.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [source.id]);

  const list = snapshot.tasks.filter((task) => task.directionId === source.id);
  const candidates = list.filter((task) => task.mark === "candidate");
  const planned = list.filter((task) => task.mark === "plan");
  const out = list.filter((task) => task.mark === "out");
  const state = capacity ? sourceState(capacity) : null;
  const was = before && before.sourceId === source.id && state ? before.state : null;
  const over = Boolean(capacity?.quotaSet && state && state.overrunHours !== "0");
  const fill = capacity ? fillPercent(capacity) : null;
  const effective = capacity && result ? effectivePercent(capacity, result.totals.availableHours) : null;

  function openForm() {
    const remembered = props.lastMarks[key];
    props.setWorkInput(key, input ? { ...input, open: true } : {
      planId, sourceId: source.id, sourceName: source.name, quarter,
      name: "", estimate: "", link: "", comment: "",
      mark: remembered ?? "candidate", remembered: Boolean(remembered), open: true
    });
    setEdit(null);
    setFocusTarget("#add-name");
    window.setTimeout(() => document.querySelector('[data-form="add"]')?.scrollIntoView({ block: "nearest" }), 0);
  }

  function closeForm() {
    if (!input) return;
    props.setWorkInput(key, isBlankWorkInput(input) ? null : { ...input, open: false });
    props.setAdded(null);
    setFocusTarget("#btn-add");
  }

  function addWork(work: Work, text: string) {
    act(source, (tasks) => [...tasks, work]);
    props.rememberMark(key, work.mark === "plan" ? "plan" : "candidate");
    setFresh({ ids: [work.id], label: "только что добавлена" });
    setGhost(null);
    props.setAdded({ sourceId: source.id, text });
  }

  function setMark(work: Work, mark: TaskMark, text: string) {
    const group = work.mark === "candidate" ? candidates : work.mark === "plan" ? planned : out;
    act(source, (tasks) => tasks.map((task) => task.id === work.id ? { ...task, mark } : task));
    setGhost({ sourceId: source.id, text, undo: true, at: { mark: work.mark, index: group.indexOf(work) } });
    setFresh({ ids: [work.id], label: mark === "plan" ? "в плане квартала" : mark === "out" ? "не в этом квартале" : "на рассмотрении" });
    if (mark === "out") setShowOut(true);
    setFocusTarget(`[data-menu-for="${work.id}"]`);
  }

  function include(work: Work) {
    const after = capacity ? describeAfter(capacity, work.estimateHours) : "";
    setMark(work, "plan", `Включено в план квартала: «${work.name}», ${estimateText(work)}.${after}`);
  }

  function remove(work: Work) {
    act(source, (tasks) => tasks.filter((task) => task.id !== work.id));
    setGhost({ sourceId: source.id, text: `Работа «${work.name}» удалена.`, undo: true });
    setFocusTarget("#btn-add");
  }

  function startEdit(work: Work, field: "name" | "link" = "name") {
    setEdit({ id: work.id, name: work.name, estimate: work.estimateHours?.replace(".", ",") ?? "", link: work.link ?? "", comment: work.comment ?? "", tried: false });
    if (work.mark === "out") setShowOut(true);
    setFocusTarget(field === "link" ? "#edit-link" : "#edit-name");
    window.setTimeout(() => document.querySelector('[data-form="edit"]')?.scrollIntoView({ block: "nearest" }), 0);
  }

  function saveEdit(work: Work, patch: Pick<Work, "name" | "estimateHours" | "link" | "comment">) {
    act(source, (tasks) => tasks.map((task) => task.id === work.id ? { ...task, ...patch } : task));
    setEdit(null);
    setFresh({ ids: [work.id], label: "изменена" });
    setGhost({ sourceId: source.id, text: `Работа изменена: «${patch.name}».`, undo: true });
    setFocusTarget(`[data-menu-for="${work.id}"]`);
  }

  async function copyLink(work: Work) {
    if (!work.link) return;
    try {
      await navigator.clipboard.writeText(work.link);
      setCopied({ id: work.id, ok: true });
      setFocusTarget(`[data-menu-for="${work.id}"]`);
    } catch {
      setCopied({ id: work.id, ok: false });
    }
  }

  const switcher = <label className="pp-switch">Другой источник
    <select value={source.id} onChange={(event) => props.onOpen(event.target.value)}>
      {snapshot.directions.filter((item) => item.kind === "work").map((item) => {
        const row = result?.directions.find((capacityRow) => capacityRow.directionId === item.id);
        const other = props.workInputs[workInputKey(planId, item.id)];
        return <option key={item.id} value={item.id}>{item.name} · {row ? describeRest(sourceState(row), hours) : "нет расчёта"}{item.id !== source.id && other && !isBlankWorkInput(other) ? " · ✎ ввод не закончен" : ""}</option>;
      })}
    </select></label>;

  const restStrong = !capacity || !state ? "—" : !capacity.quotaSet ? "—" : over
    ? <><span className="pp-q">перебор{state.missingEstimateCount ? " не менее" : ""}</span> {formatDeficitHours(state.overrunHours, hours)}</>
    : <>{state.missingEstimateCount ? <span className="pp-q">не более </span> : null}{hours(state.remainingHours)}</>;
  const plannedStrong = state ? <>{state.missingEstimateCount ? <span className="pp-q">не менее </span> : null}{hours(state.plannedKnownHours)}</> : "—";
  const plannedChanged = was && state && (!sameOnScreen(was.plannedKnownHours, state.plannedKnownHours) || was.missingEstimateCount !== state.missingEstimateCount);
  const restChanged = was && state && capacity?.quotaSet && (was.overrunHours !== state.overrunHours || !sameOnScreen(was.remainingHours, state.remainingHours));
  const formOpen = Boolean(input?.open);
  const draftClosed = input && !input.open && !isBlankWorkInput(input);
  const waitingDraft = props.importDrafts[importDraftKey(planId, source.id)];
  const waitingRows = waitingDraft ? pendingRowCount(waitingDraft) : 0;

  const undoLast = () => { props.onUndo(); setFocusTarget(input?.open ? "#add-name" : "#btn-add"); };
  const ghostAt = (mark: TaskMark) => ghost && ghost.sourceId === source.id && ghost.at?.mark === mark ? ghost : null;
  const ghostLine = (item: Ghost) => <div className="pp-ghost" role="status"><Sign tone="plain">{item.text}</Sign>
    {item.undo && undo && <button type="button" className="project-link-button" onClick={undoLast}>Отменить</button>}</div>;
  const withGhost = (rows: ReactNode[], mark: TaskMark) => {
    const item = ghostAt(mark);
    if (item?.at) rows.splice(Math.min(item.at.index, rows.length), 0, <div key="ghost">{ghostLine(item)}</div>);
    return rows;
  };

  const row = (work: Work) => {
    if (edit?.id === work.id) {
      return <EditWorkForm key={work.id} work={work} capacity={capacity} edit={edit} setEdit={setEdit}
        onCancel={() => { setEdit(null); setFocusTarget(`[data-menu-for="${work.id}"]`); }} onSave={(patch) => saveEdit(work, patch)} />;
    }
    const isFresh = fresh?.ids.includes(work.id);
    return <div key={work.id} className={`pp-row ${work.mark === "candidate" ? "cand" : "plan"}${isFresh ? " pp-fresh" : ""}`} data-work={work.id}>
      <div className="pp-wname">{work.name}
        {work.link && <span className="pp-link-chip" title={work.link}>Kaiten</span>}
        {copied?.id === work.id && copied.ok && <span className="pp-copied" role="status">Ссылка скопирована</span>}
        {isFresh && fresh && <> <span className="project-chip fresh">{fresh.label}</span></>}
        {work.comment && <span className="pp-comment">{work.comment}</span>}
        {copied?.id === work.id && !copied.ok && work.link && <span className="pp-copy-manual">
          <span className="project-muted">Скопируйте ссылку вручную:</span>
          <input type="text" readOnly value={work.link} autoFocus onFocus={(event) => event.currentTarget.select()} aria-label="Ссылка на Kaiten" /></span>}
      </div>
      <div className="pp-est">{work.estimateHours === null ? <Sign tone="unknown">Без оценки</Sign> : hours(work.estimateHours)}</div>
      {work.mark === "candidate" && capacity
        ? <div className="pp-effect">{describeInclusion(capacity, work.estimateHours, hours)}</div>
        : <div className="pp-effect pp-cell-empty" />}
      {work.mark === "candidate"
        ? <button type="button" className="secondary pp-action" onClick={() => include(work)}>Включить в план квартала</button>
        : <div className="pp-action pp-cell-empty" />}
      <WorkMenu work={work} onEdit={() => startEdit(work)} onAddLink={() => startEdit(work, "link")} onCopy={() => { void copyLink(work); }}
        onMark={(mark) => setMark(work, mark, mark === "candidate" ? `Возвращено на рассмотрение: «${work.name}».`
          : mark === "out" ? `Перенесено в «Не в этом квартале»: «${work.name}».`
            : `Включено в план квартала: «${work.name}», ${estimateText(work)}.${capacity ? describeAfter(capacity, work.estimateHours) : ""}`)}
        onDelete={() => remove(work)} />
    </div>;
  };

  const top = ghost && ghost.sourceId === source.id && !ghost.at ? ghostLine(ghost) : null;
  const stick = <div className={`pp-stick${stuck ? " show" : ""}`} aria-hidden="true"><div className="pp-stick-inner"><b>{source.name}</b>
    <span className="pp-stick-item">Квота<strong>{capacity?.quotaSet ? hours(capacity.budgetHours) : "—"}</strong></span>
    <span className="pp-stick-item">Занято работами<strong>{plannedStrong}</strong></span>
    <span className="pp-stick-item">{over ? <Sign tone="over">Перебор квоты</Sign> : "Остаток квоты"}<strong className={over ? "over" : ""}>{restStrong}</strong></span>
    <FillBar percent={fill} over={over} /></div></div>;

  return <>
    {stick}
    <div className="pp-crumbs">
      <button type="button" className="project-link-button" id="crumb-back" onClick={() => props.onOpen(null)}><BackIcon />Все источники</button>
      <span className="project-muted">/ {source.name}</span>
      {switcher}
    </div>
    <section ref={head} className="pp-head" aria-labelledby="source-title">
      <div className="pp-head-top"><div className="pp-head-title"><h2 id="source-title" tabIndex={-1}>{source.name}</h2></div>
        <div className="pp-actions"><button type="button" id="btn-add" onClick={openForm} disabled={formOpen}>{draftClosed ? "Продолжить ввод работы" : "Добавить работу"}</button>
          <button type="button" className="secondary" id="btn-import" onClick={() => props.onImport(null)}>{waitingRows ? `Продолжить вставку (${waitingRows})` : "Вставить из таблицы"}</button></div></div>
      <div className="pp-nums">
        <div className="pp-num"><span>Квота <InfoHint info="quota" /></span><strong>{capacity?.quotaSet ? hours(capacity.budgetHours) : "—"}</strong>
          <span className="pp-note">{!capacity?.quotaSet ? "доля не задана" : effective !== null ? `${formatPercent(effective)} доступной ёмкости` : ""}</span></div>
        <div className="pp-num"><span>Занято работами в плане <InfoHint info="planned" /></span><strong>{plannedStrong}</strong>
          <span className="pp-note">{capacity?.quotaSet && fill !== null ? `${state?.missingEstimateCount ? "от " : ""}${fill}% квоты · ` : ""}{works(planned.length)}{state?.missingEstimateCount ? `, ${state.missingEstimateCount} без оценки` : ""}
            {state?.missingEstimateCount ? <InfoHint info="bounds" /> : null}
            {plannedChanged && was && <span className="pp-was"> · было {was.missingEstimateCount ? "не менее " : ""}{hours(was.plannedKnownHours)}</span>}</span></div>
        <div className="pp-num"><span>Остаток квоты <InfoHint info="rest" /></span><strong className={over ? "over" : ""}>{restStrong}</strong>
          <span className="pp-note">{!capacity?.quotaSet ? <Sign tone="unknown">доля не задана</Sign> : over ? <Sign tone="over">работ в плане больше квоты</Sign> : null}
            {restChanged && was && <span className="pp-was">было: {was.overrunHours !== "0" ? `перебор ${formatDeficitHours(was.overrunHours, hours)}` : `${was.missingEstimateCount ? "не более " : ""}${hours(was.remainingHours)}`}</span>}</span></div>
      </div>
      <FillBar percent={fill} over={over} />
    </section>
    {formOpen && input && <AddWorkForm key={key} source={source} capacity={capacity} input={input} works={list} onPasteRows={(text) => props.onImport(text)}
      added={props.added?.sourceId === source.id ? props.added.text : null} canUndo={Boolean(undo)} onUndo={undoLast}
      onChange={(patch) => props.setWorkInput(key, { ...input, ...patch })}
      onClose={closeForm}
      onClear={() => { props.setWorkInput(key, { ...input, name: "", estimate: "", link: "", comment: "" }); props.setAdded(null); setFocusTarget("#add-name"); }}
      onAdd={(work, text) => {
        addWork(work, text);
        props.setWorkInput(key, { ...input, name: "", estimate: "", link: "", comment: "", mark: work.mark === "plan" ? "plan" : "candidate" });
        setFocusTarget("#add-name");
      }} />}
    {props.importLine}
    <section className="pp-works" aria-label="Работы источника">
      {top}
      {!list.length ? <div className="pp-empty-source">
        <p>В источнике пока нет работ. {capacity?.quotaSet ? `Квота ${hours(capacity.budgetHours)} закреплена за ним и другим источникам не достаётся.` : "Долю источника можно задать позже во вкладке «Источники и доли»."}</p>
        {!formOpen && <div className="project-actions"><button type="button" onClick={openForm}>Добавить работу</button>
          <button type="button" className="secondary" onClick={() => props.onImport(null)}>Вставить строки из таблицы</button></div>}
      </div> : <>
        <div className="pp-group-head cand-head"><h3>На рассмотрении <InfoHint info="candidate" /></h3><span>{works(candidates.length)}</span></div>
        {candidates.length ? withGhost(candidates.map(row), "candidate") : <>{ghostAt("candidate") && ghostLine(ghostAt("candidate")!)}<p className="pp-empty-works">На рассмотрении работ нет. Новые работы источника по умолчанию попадают сюда.</p></>}
        <div className="pp-group-head plan-head"><h3>В плане квартала <InfoHint info="plan" /></h3>
          <span>{works(planned.length)} · {state ? describePlanned(state, hours) : "—"}</span>
          {state?.missingEstimateCount ? <Sign tone="unknown">{state.missingEstimateCount} без оценки</Sign> : null}</div>
        {planned.length ? withGhost(planned.map(row), "plan") : <>{ghostAt("plan") && ghostLine(ghostAt("plan")!)}<p className="pp-empty-works">В план квартала пока ничего не включено.</p></>}
        {(out.length > 0 || ghostAt("out")) && <>
          <div className="pp-toggle-row"><button type="button" className="pp-toggle" aria-expanded={showOut} onClick={() => setShowOut(!showOut)}>
            <b><TriangleIcon open={showOut} /> Не в этом квартале</b>&nbsp;<span>{works(out.length)}</span></button><InfoHint info="out" /></div>
          {showOut && withGhost(out.map(row), "out")}
          {!showOut && ghostAt("out") && ghostLine(ghostAt("out")!)}
        </>}
      </>}
    </section>
  </>;
}

/** « Остаток квоты: 34 ч.» appended to a confirmation; empty when the share is not set. */
function describeAfter(capacity: QuarterDirectionCapacity, estimate: string | null): string {
  const text = describeRestAfterInclusion(capacity, estimate, hours);
  return text ? ` ${text}` : "";
}

/** Enter in a text field submits the form; on a button it keeps its own meaning. */
const isTextField = (target: EventTarget) => target instanceof HTMLInputElement && target.type === "text";

function WorkMenu({ work, onEdit, onAddLink, onCopy, onMark, onDelete }: {
  work: Work; onEdit: () => void; onAddLink: () => void; onCopy: () => void; onMark: (mark: TaskMark) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);
  const choose = (action: () => void) => () => { setOpen(false); action(); };
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === "Tab") setOpen(false);
  }
  return <div className="pp-menu-anchor">
    <button ref={button} type="button" className="project-icon-button" data-menu-for={work.id} aria-label={`Действия: ${work.name}`}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><DotsIcon /></button>
    {open && <div ref={menu} className="pp-menu" role="menu" aria-label={`Действия: ${work.name}`} onKeyDown={onKey}>
      <button type="button" role="menuitem" onClick={choose(onEdit)}>Изменить…</button>
      {work.link
        ? <button type="button" role="menuitem" onClick={choose(onCopy)}>Скопировать ссылку</button>
        : <button type="button" role="menuitem" onClick={choose(onAddLink)}>Добавить ссылку на Kaiten…</button>}
      <hr aria-hidden="true" />
      {work.mark !== "plan" && <button type="button" role="menuitem" onClick={choose(() => onMark("plan"))}>Включить в план квартала</button>}
      {work.mark !== "candidate" && <button type="button" role="menuitem" onClick={choose(() => onMark("candidate"))}>Вернуть на рассмотрение</button>}
      {work.mark !== "out" && <button type="button" role="menuitem" onClick={choose(() => onMark("out"))}>Перенести в «Не в этом квартале»</button>}
      <hr aria-hidden="true" />
      <button type="button" role="menuitem" className="pp-danger-item" onClick={choose(onDelete)}>Удалить работу</button>
    </div>}
  </div>;
}

type FieldErrors = { name?: string; estimate?: string; link?: string; comment?: string };

function checkWork(fields: { name: string; estimate: string; link: string; comment: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.name.trim()) errors.name = "Введите название работы.";
  const estimate = parseEstimateInput(fields.estimate);
  if (estimate.kind === "invalid") errors.estimate = estimate.message;
  if (fields.link.trim() && !isWebLink(fields.link.trim())) errors.link = "Ссылка должна начинаться с https:// или http:// — например, адрес карточки Kaiten.";
  if (fields.comment.trim().length > QUARTER_INPUT_LIMITS.commentCharacters) errors.comment = `Комментарий длиннее ${QUARTER_INPUT_LIMITS.commentCharacters} символов.`;
  return errors;
}

function AddWorkForm({ source, capacity, input, works: existing, added, canUndo, onUndo, onChange, onClose, onClear, onAdd, onPasteRows }: {
  source: Direction; capacity: QuarterDirectionCapacity | undefined; input: WorkInput; works: readonly Work[];
  /** Rows copied from a spreadsheet and pasted into «Название» open the import window. */
  onPasteRows: (text: string) => void;
  added: string | null; canUndo: boolean; onUndo: () => void;
  onChange: (patch: Partial<WorkInput>) => void; onClose: () => void; onClear: () => void;
  onAdd: (work: Work, text: string) => void;
}) {
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<{ estimate?: boolean; link?: boolean }>({});
  const errors = checkWork(input);
  const shown = (field: keyof FieldErrors) => tried || (field !== "name" && touched[field as "estimate" | "link"]) ? errors[field] : undefined;
  const estimate = parseEstimateInput(input.estimate);
  const toPlan = input.mark === "plan";
  const duplicate = input.name.trim() ? existing.find((work) => work.name.trim().toLowerCase() === input.name.trim().toLowerCase()) : undefined;

  let effect: ReactNode = null;
  if (!input.name.trim() && !input.estimate.trim()) {
    effect = null;
  } else if (estimate.kind === "invalid") {
    effect = <span className="project-muted">Последствие появится, когда оценка будет понятна.</span>;
  } else if (!capacity) {
    effect = <span className="project-muted">Последствие появится после заполнения данных квартала.</span>;
  } else {
    const hoursValue = estimate.kind === "hours" ? estimate.hours : null;
    const text = describeInclusion(capacity, hoursValue, hours);
    const tone = !capacity.quotaSet || hoursValue === null ? "unknown" : text.includes("перебор") ? "over" : "fits";
    effect = toPlan ? <Sign tone={tone}>{text}</Sign>
      : <span><span className="project-muted">Если включить в план квартала:</span> {text}</span>;
  }

  function submit() {
    setTried(true);
    const problems = checkWork(input);
    const first = (["name", "estimate", "link", "comment"] as const).find((field) => problems[field]);
    if (first) { document.getElementById(`add-${first}`)?.focus(); return; }
    const parsed = parseEstimateInput(input.estimate);
    const work: Work = {
      id: crypto.randomUUID(), name: input.name.trim(), directionId: source.id,
      estimateHours: parsed.kind === "hours" ? parsed.hours : null, mark: input.mark,
      link: input.link.trim() || null, comment: input.comment.trim() || null
    };
    const after = toPlan && capacity ? describeAfter(capacity, work.estimateHours) : "";
    onAdd(work, `Добавлено ${toPlan ? "в план квартала" : "на рассмотрение"}: «${work.name}», ${estimateText(work)}.${after}`);
    setTried(false);
    setTouched({});
  }

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && isTextField(event.target)) { event.preventDefault(); submit(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  return <section className={`pp-form${toPlan ? " to-plan" : ""}`} data-form="add" aria-labelledby="add-title" onKeyDown={onKey}>
    <div className="pp-form-head"><h3 id="add-title">Новая работа в «{source.name}»</h3>
      <span className="project-actions">
        {!isBlankWorkInput(input) && <button type="button" className="project-link-button" id="add-clear" onClick={() => { setTried(false); setTouched({}); onClear(); }}>Очистить форму</button>}
        <span className="project-muted"><Kbd name="esc" /> закрыть, введённое сохранится</span>
        <button type="button" className="project-icon-button" aria-label="Закрыть форму" onClick={onClose}><CloseIcon /></button></span></div>
    <div className="pp-form-row">
      <label htmlFor="add-name">Название
        <input type="text" id="add-name" value={input.name} maxLength={QUARTER_INPUT_LIMITS.nameCharacters} autoComplete="off"
          aria-invalid={Boolean(shown("name"))} aria-describedby={shown("name") ? "add-name-error" : undefined}
          onPaste={(event) => onNamePaste(event, onPasteRows)} onChange={(event) => onChange({ name: event.target.value })} />
        {shown("name") && <span className="project-field-error" id="add-name-error">{shown("name")}</span>}
        {duplicate && <Sign tone="unknown">Такая работа уже есть {MARK_PLACE[duplicate.mark]}.</Sign>}</label>
      <label htmlFor="add-estimate"><span>Полная оценка, ч <InfoHint info="estimate" /></span>
        <input type="text" id="add-estimate" value={input.estimate} inputMode="decimal" placeholder="Без оценки" autoComplete="off"
          aria-invalid={Boolean(shown("estimate"))} aria-describedby="add-estimate-hint"
          onChange={(event) => onChange({ estimate: event.target.value })} onBlur={() => setTouched((current) => ({ ...current, estimate: true }))} />
        {shown("estimate") && <span className="project-field-error">{shown("estimate")}</span>}
        {estimate.kind === "hours" && estimate.hours === "0" && <span className="pp-hint pp-zero" role="status">{ZERO_ESTIMATE_NOTE}</span>}
        <span className="pp-hint" id="add-estimate-hint">Например, 28 или 12,5. Пусто — без оценки.</span></label>
      <fieldset><legend className="pp-legend">Куда добавить</legend>
        <div className="pp-seg">
          <label><input type="radio" name="add-mark" value="candidate" checked={!toPlan} onChange={() => onChange({ mark: "candidate", remembered: false })} />На рассмотрение</label>
          <label><input type="radio" name="add-mark" value="plan" checked={toPlan} onChange={() => onChange({ mark: "plan", remembered: false })} />В план квартала</label>
        </div>
        <span className="pp-hint pp-mark-note">{toPlan ? "Сразу займёт бюджет источника" : "Бюджет не займёт"}</span>
        {toPlan && input.remembered && <span className="pp-remembered">Как в прошлый раз для «{source.name}»</span>}
      </fieldset>
    </div>
    <div className="pp-form-row second">
      <label htmlFor="add-link"><span>Ссылка на Kaiten <span className="project-muted">· необязательно</span></span>
        <input type="text" id="add-link" value={input.link} placeholder="https:// …" autoComplete="off" maxLength={QUARTER_INPUT_LIMITS.linkCharacters}
          aria-invalid={Boolean(shown("link"))} onChange={(event) => onChange({ link: event.target.value })}
          onBlur={() => setTouched((current) => ({ ...current, link: true }))} />
        {shown("link") && <span className="project-field-error">{shown("link")}</span>}</label>
      <label htmlFor="add-comment"><span>Комментарий <span className="project-muted">· необязательно</span></span>
        <input type="text" id="add-comment" value={input.comment} autoComplete="off" aria-invalid={Boolean(shown("comment"))}
          onChange={(event) => onChange({ comment: event.target.value })} />
        {shown("comment") && <span className="project-field-error">{shown("comment")}</span>}</label>
    </div>
    {added && <div className="pp-done" role="status"><Sign tone="plain">{added}</Sign>
      {canUndo && <button type="button" className="project-link-button" id="add-undo" onClick={onUndo}>Отменить</button>}</div>}
    <div className="pp-form-foot"><div className="pp-effect-line">{effect}</div>
      <span className="project-actions"><button type="button" id="add-submit" onClick={submit}>{toPlan ? "Добавить в план квартала" : "Добавить на рассмотрение"}</button><Kbd name="enter" /></span></div>
  </section>;
}

function EditWorkForm({ work, capacity, edit, setEdit, onCancel, onSave }: {
  work: Work; capacity: QuarterDirectionCapacity | undefined; edit: EditState; setEdit: (edit: EditState) => void;
  onCancel: () => void; onSave: (patch: Pick<Work, "name" | "estimateHours" | "link" | "comment">) => void;
}) {
  const errors = checkWork(edit);
  const shown = (field: keyof FieldErrors) => edit.tried || field === "estimate" || field === "link" ? errors[field] : undefined;
  const estimate = parseEstimateInput(edit.estimate);
  const next = estimate.kind === "hours" ? estimate.hours : null;
  const effect = estimate.kind === "invalid" ? <span className="project-muted">Последствие появится, когда оценка будет понятна.</span>
    : !capacity ? <span className="project-muted">Последствие появится после заполнения данных квартала.</span>
    : describeEstimateChange(capacity, work.estimateHours, next, work.mark === "plan", hours) ?? <span className="project-muted">Оценка не меняется.</span>;
  function submit() {
    const problems = checkWork(edit);
    const first = (["name", "estimate", "link", "comment"] as const).find((field) => problems[field]);
    if (first) { setEdit({ ...edit, tried: true }); document.getElementById(`edit-${first}`)?.focus(); return; }
    onSave({ name: edit.name.trim(), estimateHours: next, link: edit.link.trim() || null, comment: edit.comment.trim() || null });
  }
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && !event.shiftKey && isTextField(event.target)) { event.preventDefault(); submit(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
  };
  return <section className="pp-form inline" data-form="edit" aria-label={`Изменить работу «${work.name}»`} onKeyDown={onKey}>
    <div className="pp-form-row">
      <label htmlFor="edit-name">Название
        <input type="text" id="edit-name" value={edit.name} maxLength={QUARTER_INPUT_LIMITS.nameCharacters} autoComplete="off"
          aria-invalid={Boolean(shown("name"))} onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
        {shown("name") && <span className="project-field-error">{shown("name")}</span>}</label>
      <label htmlFor="edit-estimate"><span>Полная оценка, ч <InfoHint info="estimate" /></span>
        <input type="text" id="edit-estimate" value={edit.estimate} inputMode="decimal" placeholder="Без оценки" autoComplete="off"
          aria-invalid={Boolean(shown("estimate"))} onChange={(event) => setEdit({ ...edit, estimate: event.target.value })} />
        {shown("estimate") && <span className="project-field-error">{shown("estimate")}</span>}</label>
    </div>
    <div className="pp-form-row second">
      <label htmlFor="edit-link"><span>Ссылка на Kaiten <span className="project-muted">· необязательно</span></span>
        <input type="text" id="edit-link" value={edit.link} placeholder="https:// …" autoComplete="off" maxLength={QUARTER_INPUT_LIMITS.linkCharacters}
          aria-invalid={Boolean(shown("link"))} onChange={(event) => setEdit({ ...edit, link: event.target.value })} />
        {shown("link") && <span className="project-field-error">{shown("link")}</span>}</label>
      <label htmlFor="edit-comment"><span>Комментарий <span className="project-muted">· необязательно</span></span>
        <input type="text" id="edit-comment" value={edit.comment} autoComplete="off" aria-invalid={Boolean(shown("comment"))}
          onChange={(event) => setEdit({ ...edit, comment: event.target.value })} />
        {shown("comment") && <span className="project-field-error">{shown("comment")}</span>}</label>
    </div>
    <div className="pp-form-foot"><div className="pp-effect-line">{effect}</div>
      <span className="project-actions"><button type="button" className="secondary" id="edit-cancel" onClick={onCancel}>Отмена</button>
        <button type="button" id="edit-submit" onClick={submit}>Сохранить изменения</button><Kbd name="enter" /></span></div>
  </section>;
}
