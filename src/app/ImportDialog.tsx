import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import type { QuarterCapacityResult, QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";
import { QUARTER_INPUT_LIMITS } from "../domain/capacity/quarter-snapshot.validation";
import { pluralRu } from "../domain/capacity/quarter-totals";
import { describeBatchInclusion } from "../domain/capacity/source-plan";
import {
  applyImport, COLUMN_ROLES, createImportDraft, describeGroup, IMPORT_LIMITS, previewImport, ROLE_LABELS, setColumnRole,
  setHasHeader, setRowChecked, setRowSource, setRowText, skippedTableText, sourceLabels, withoutEstimate,
  type ColumnRole, type ImportDraft, type ImportOutcome, type PreviewRow, type RowIssue, type TextField
} from "../import/work-import";
import { DialogPortal, useDialogFocus } from "./project-ui";
import { hours, Kbd, Sign } from "./plan-ui";

type Snapshot = QuarterSnapshot;
type Work = Snapshot["tasks"][number];
type Source = Snapshot["directions"][number];
type Change = (draft: ImportDraft) => ImportDraft;

const works = (count: number) => `${count} ${pluralRu(count, "работа", "работы", "работ")}`;
const worksAcc = (count: number) => `${count} ${pluralRu(count, "работу", "работы", "работ")}`;
const lines = (count: number) => `${count} ${pluralRu(count, "строка", "строки", "строк")}`;
/** Focus after the next render, when the element replacing the pressed one exists. */
const focusLater = (id: string) => window.setTimeout(() => document.getElementById(id)?.focus(), 0);

/** True when copied text holds more than one cell: Enter-separated rows or tab-separated cells. */
export function isTablePaste(text: string): boolean {
  return /[\t\r\n]/.test(text.replace(/[\r\n]+$/, ""));
}

export type ImportDialogProps = {
  planId: string;
  /** The open source; null when the window is opened from the table of sources. */
  sourceId: string | null;
  quarter: string;
  snapshot: Snapshot;
  result: QuarterCapacityResult | null;
  draft: ImportDraft | null;
  /** Rows pasted into «Название» of the work form. */
  initialText: string | null;
  saveHint: number;
  onDraft: (draft: ImportDraft | null) => void;
  onAdd: (works: Work[], rest: ImportDraft | null, outcome: ImportOutcome) => void;
  onClose: () => void;
};

/**
 * «Вставка работ из таблицы» (QUARTER_PLANNING_UX.md; DEC-039, DEC-043, DEC-050). Nothing is
 * added before the button; the rows, fixes and the result stay while the project is open.
 */
export function ImportDialog(props: ImportDialogProps) {
  const { planId, sourceId, snapshot, draft, onDraft } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLElement>(null);
  const [hint, setHint] = useState(false);
  const firstHint = useRef(props.saveHint);
  useEffect(() => { if (props.saveHint !== firstHint.current) setHint(true); }, [props.saveHint]);
  useDialogFocus(dialog, first, props.onClose);

  // Rows pasted into the work form start the import, unless one is already waiting here.
  const started = useRef(false);
  const [blockedPaste, setBlockedPaste] = useState(false);
  useEffect(() => {
    if (started.current || props.initialText === null) return;
    started.current = true;
    if (draft?.cells.length) setBlockedPaste(true);
    else onDraft(createImportDraft({ planId, sourceId, text: props.initialText, snapshot }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const source = sourceId ? snapshot.directions.find((direction) => direction.id === sourceId && direction.kind === "work") : undefined;
  const stage = !draft?.cells.length ? "paste" : draft.outcome ? "outcome" : "rows";

  return <DialogPortal><div className="project-modal-backdrop">
    <div ref={dialog} className="project-modal pp-mid pp-import" role="dialog" aria-modal="true" aria-labelledby="import-title"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && stage === "rows") {
          event.preventDefault();
          document.getElementById("import-submit")?.click();
        }
      }}>
      <div className="pp-modal-head"><h2 id="import-title">Вставка работ из таблицы</h2>
        <p>{source ? `В источник «${source.name.trim() || "Без названия"}»` : "В источники квартала"} · {props.quarter}. Ничего не добавляется до подтверждения; существующие работы не меняются.</p>
        {blockedPaste && <p className="project-message warning" role="status">Новые строки не вставлены: в этом окне уже есть строки. Добавьте или уберите их («Вставить другие строки»), затем вставьте снова.</p>}
        {hint && <p className="pp-hintline" role="status">Сначала закончите со строками или закройте это окно, затем сохраните квартал.</p>}</div>
      {stage === "paste" && <PasteStage {...props} focusRef={first} />}
      {stage === "rows" && draft && <RowsStage {...props} draft={draft} />}
      {stage === "outcome" && draft?.outcome && <OutcomeStage {...props} draft={draft} outcome={draft.outcome} focusRef={first} />}
    </div>
  </div></DialogPortal>;
}

function PasteStage({ planId, sourceId, snapshot, onDraft, onClose, focusRef }: ImportDialogProps & { focusRef: RefObject<HTMLElement> }) {
  const [text, setText] = useState("");
  const [empty, setEmpty] = useState(false);
  const read = (value: string) => {
    const draft = createImportDraft({ planId, sourceId, text: value, snapshot });
    if (draft.cells.length) onDraft(draft); else setEmpty(true);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const value = event.clipboardData.getData("text/plain");
    event.preventDefault();
    read(value);
  };
  return <>
    <div className="pp-modal-body">
      <p>Выделите строки в Excel или другой таблице, скопируйте их и вставьте в поле ниже. Подойдут столбцы: название, полная оценка в часах, ссылка, комментарий{sourceId ? "" : " и источник"}. Первая строка может быть строкой заголовков.</p>
      <label className="pp-import-paste">Строки из таблицы
        <textarea ref={focusRef as RefObject<HTMLTextAreaElement>} id="import-text" rows={8} value={text} autoFocus
          maxLength={IMPORT_LIMITS.characters} placeholder="Нажмите Ctrl+V или ⌘V" aria-describedby={empty ? "import-empty" : undefined}
          onPaste={onPaste} onChange={(event) => { setText(event.target.value); setEmpty(false); }} /></label>
      {empty && <p className="project-field-error" id="import-empty" role="alert">В скопированном нет строк с данными: только пустые ячейки. Скопируйте строки ещё раз.</p>}
      <p className="project-muted pp-dialog-note">Строки разбираются на этом компьютере. Формулы, ссылки и другие действия из таблицы не выполняются: попадает только текст ячеек.</p>
    </div>
    <div className="pp-modal-foot"><span />
      <span className="project-actions"><button type="button" className="secondary" onClick={onClose}>Закрыть</button>
        <button type="button" id="import-read" disabled={!text.trim()} onClick={() => read(text)}>Показать строки</button></span></div>
  </>;
}

const ISSUE_TONE: Record<RowIssue["level"], "over" | "unknown" | "plain"> = { error: "over", repeat: "unknown", warning: "unknown", note: "plain" };
const TONE_ORDER = { over: 0, unknown: 1, fits: 2 } as const;

function RowsStage(props: ImportDialogProps & { draft: ImportDraft }) {
  const { draft, snapshot, result, sourceId } = props;
  const [error, setError] = useState("");
  const [restart, setRestart] = useState(false);
  // Every keystroke in a cell changes the draft: the preview is built once per change, and only
  // the rows whose content changed render again.
  const preview = useMemo(() => previewImport(draft, snapshot), [draft, snapshot]);
  const workSources = useMemo(() => snapshot.directions.filter((direction) => direction.kind === "work"), [snapshot.directions]);
  const labels = useMemo(() => sourceLabels(snapshot.directions), [snapshot.directions]);
  const latest = useRef({ draft, onDraft: props.onDraft });
  latest.current = { draft, onDraft: props.onDraft };
  const update = useCallback((change: Change) => { setError(""); latest.current.onDraft(change(latest.current.draft)); }, []);

  const sourceColumn = draft.roles.includes("source");
  // Without a source column the rows go to the open source; if it was deleted since, one is chosen here.
  const openSource = sourceId ? snapshot.directions.find((direction) => direction.id === sourceId && direction.kind === "work") : undefined;
  const showSource = sourceColumn || !openSource;
  const counts = {
    errors: preview.rows.filter((row) => row.blocked).length,
    repeats: preview.rows.filter((row) => !row.blocked && row.repeat).length,
    noHours: preview.rows.filter((row) => row.issues.some((issue) => issue.withoutEstimate)).length
  };
  const toPlan = draft.mark === "plan";
  const total = preview.checked.length;
  const header = preview.header;

  function submit() {
    if (!total || preview.noNameColumn || preview.overLimit) return;
    try {
      const { works, rest, outcome } = applyImport(draft, snapshot, () => crypto.randomUUID());
      props.onAdd(works, rest, outcome);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Не удалось добавить работы.");
    }
  }

  // On arrival: the add button; without rows to add, the first row with an error.
  useEffect(() => {
    const submit = document.getElementById("import-submit") as HTMLButtonElement | null;
    if (submit && !submit.disabled) { submit.focus(); return; }
    const row = preview.rows.find((item) => item.blocked);
    const field = row?.issues.find((issue) => issue.level === "error")?.field;
    (document.getElementById(row && field ? `import-${field}-${row.index}` : "import-close") as HTMLElement | null)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An overrun comes first: it must not hide below the other sources.
  const effects = preview.groups.map((group) => {
    const capacity = result?.directions.find((row) => row.directionId === group.sourceId);
    const name = labels.get(group.sourceId) ?? "Без названия";
    const batch = capacity ? describeBatchInclusion(capacity, group.estimates, hours) : null;
    return { tone: batch?.tone ?? "unknown", node: <li key={group.sourceId}><b>«{name}»</b>: {describeGroup(group, hours)}.{" "}
      {!batch ? <span className="project-muted">Последствие появится после заполнения данных квартала.</span>
        : toPlan ? <Sign tone={batch.tone}>{batch.text}</Sign>
        : <span><span className="project-muted">Если включить их в план квартала:</span> {batch.text}</span>}</li> };
  }).sort((left, right) => TONE_ORDER[left.tone] - TONE_ORDER[right.tone]);
  const overruns = effects.filter((item) => item.tone === "over").length;

  return <>
    <div className="pp-modal-body">
      {draft.cut && <p className="project-message warning" role="status">Показаны первые {IMPORT_LIMITS.rows.toLocaleString("ru-RU")} строк и {IMPORT_LIMITS.columns} столбцов. Остальные строки вставьте отдельно.</p>}
      <div className="pp-import-bar">
        <span><b>{lines(preview.rows.length)}</b> · отмечено {total}{counts.errors ? ` · с ошибками ${counts.errors}` : ""}{counts.repeats ? ` · повторов ${counts.repeats}` : ""}{preview.emptyLines.length ? ` · пустых ${preview.emptyLines.length}` : ""}</span>
        <label className="pp-check"><input type="checkbox" checked={draft.hasHeader} onChange={(event) => update((current) => setHasHeader(current, event.target.checked, snapshot))} />Первая строка — заголовки</label>
        {counts.noHours > 1 && <button type="button" className="project-link-button" id="import-all-without-estimate"
          title="Исходная оценка сохранится в комментарии"
          onClick={() => { update((current) => preview.rows.filter((row) => row.issues.some((issue) => issue.withoutEstimate)).reduce((next, row) => withoutEstimate(next, row), current)); focusLater("import-submit"); }}>
          Без оценки — все строки, где оценка не в часах ({counts.noHours})</button>}
        {restart ? <span className="pp-import-restart" role="alert">Убрать эти строки и исправления?
          <button type="button" className="danger" id="import-restart-yes" onClick={() => { setRestart(false); props.onDraft(null); }}>Убрать</button>
          <button type="button" className="secondary" id="import-restart-no" autoFocus onClick={() => { setRestart(false); focusLater("import-restart"); }}>Оставить</button></span>
          : <button type="button" className="project-link-button" id="import-restart" onClick={() => setRestart(true)}>Вставить другие строки</button>}
      </div>
      <div className="pp-import-columns" role="group" aria-labelledby="import-columns-label"><span id="import-columns-label" className="pp-legend">Столбцы:</span>
        {draft.roles.map((role, column) => {
          const title = header?.[column]?.trim() ? `«${header[column].trim()}»` : `Столбец ${column + 1}`;
          return <label key={column}>{title}
            <select value={role} aria-label={`${title}: что в столбце`} onChange={(event) => update((current) => setColumnRole(current, column, event.target.value as ColumnRole))}>
              {COLUMN_ROLES.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}
            </select></label>;
        })}
        {showSource && <label className="pp-import-default">{sourceColumn ? "Строки без источника — в" : "Все строки — в источник"}
          <select id="import-default-source" value={draft.sourceId ?? ""} onChange={(event) => update((current) => ({ ...current, sourceId: event.target.value || null }))}>
            <option value="">{sourceColumn ? "— не добавлять —" : "— выберите источник —"}</option>
            {workSources.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id)}</option>)}
          </select></label>}
      </div>
      {preview.noNameColumn && <p className="project-field-error" role="alert">Выберите столбец с названием работы.</p>}
      {!preview.noNameColumn && preview.noEstimateColumn && <p className="pp-hintline">Столбец с оценкой в часах не выбран: работы добавятся без оценки. Если оценка в часах есть, выберите её столбец выше. Размеры и баллы в часы не переводятся.</p>}
      <div className="data-table-wrap pp-import-table"><table className="project-table" aria-label="Строки для добавления">
        <thead><tr><th className="pp-col-tick">Стр.</th>
          <th className="pp-col-name">Название</th><th className="pp-col-est">Оценка, ч</th><th>Ссылка</th><th>Комментарий</th>
          {showSource && <th className="pp-col-source">Источник</th>}<th className="pp-col-check-text">Проверка</th></tr></thead>
        <tbody>{preview.rows.map((row) => <ImportRow key={row.index} row={row} showSource={showSource} sources={workSources} labels={labels} update={update} />)}
          {!preview.rows.length && <tr><td colSpan={showSource ? 7 : 6} className="project-table-empty">В строках нет данных: только пустые строки.</td></tr>}
        </tbody></table></div>
    </div>
    <div className="pp-modal-foot pp-import-foot">
      <div className="pp-import-foot-row">
        <div className="pp-import-mark" role="radiogroup" aria-labelledby="import-mark-label"><span id="import-mark-label" className="pp-legend">Куда добавить</span>
          <div className="pp-seg">
            <label><input type="radio" name="import-mark" checked={!toPlan} onChange={() => update((current) => ({ ...current, mark: "candidate" }))} />На рассмотрение</label>
            <label><input type="radio" name="import-mark" checked={toPlan} onChange={() => update((current) => ({ ...current, mark: "plan" }))} />В план квартала</label>
          </div>
          <span className="pp-hint">{toPlan ? "Сразу займут бюджет источников" : "Бюджет не займут"}</span></div>
        <span className="project-actions"><button type="button" className="secondary" id="import-close" onClick={props.onClose}>Закрыть</button>
          <button type="button" id="import-submit" disabled={!total || preview.noNameColumn || preview.overLimit} onClick={submit}>
            Добавить {worksAcc(total)} {toPlan ? "в план квартала" : "на рассмотрение"}</button><Kbd name="submit" /></span>
      </div>
      <div className="pp-effect-line">{!total ? <span className="project-muted">Отметьте строки, которые нужно добавить.</span>
        : preview.overLimit ? <span className="project-field-error">В квартале будет больше {QUARTER_INPUT_LIMITS.entitiesPerCollection.toLocaleString("ru-RU")} работ. Добавьте часть строк.</span>
        : <>{toPlan && overruns > 0 && <Sign tone="over">Перебор квоты в {overruns} {pluralRu(overruns, "источнике", "источниках", "источниках")}</Sign>}
          <ul className="pp-import-effects">{effects.map((item) => item.node)}</ul></>}
        {error && <span className="project-field-error" role="alert">{error}</span>}</div>
    </div>
  </>;
}

const FIELD_LABEL: Record<TextField, string> = { name: "Название", estimate: "Оценка, ч", link: "Ссылка", comment: "Комментарий" };

/** A row renders again only when its own content changes (1 000 rows, a keystroke at a time). */
const ImportRow = memo(function ImportRow({ row, showSource, sources, labels, update }: {
  row: PreviewRow; showSource: boolean; sources: readonly Source[]; labels: ReadonlyMap<string, string>; update: (change: Change) => void;
}) {
  const id = (field: string) => `import-${field}-${row.index}`;
  const issueId = (index: number) => `import-issue-${row.index}-${index}`;
  const about = (field: string) => row.issues.map((issue, index) => issue.field === field ? issueId(index) : "").filter(Boolean).join(" ") || undefined;
  const invalid = (field: string) => row.issues.some((issue) => issue.level === "error" && issue.field === field);
  const cell = (field: TextField) => <td>
    <input type="text" id={id(field)} className="pp-import-input" value={row.values[field]}
      aria-label={`${FIELD_LABEL[field]}, строка ${row.line}`} aria-invalid={invalid(field)} aria-describedby={about(field)}
      autoComplete="off" spellCheck={false} title={row.values[field] || undefined}
      placeholder={field === "estimate" ? "Без оценки" : undefined}
      onChange={(event) => { const value = event.target.value; update((draft) => setRowText(draft, row.index, field, value)); }} /></td>;
  return <tr className={row.blocked ? "pp-import-error" : !row.checked ? "pp-import-off" : ""} data-line={row.line}>
    <td className="pp-col-tick"><label className="pp-import-tick"><input type="checkbox" checked={row.checked} disabled={row.blocked}
      aria-label={`Добавить строку ${row.line}`} aria-describedby={row.issues.length ? row.issues.map((_, index) => issueId(index)).join(" ") : undefined}
      onChange={(event) => { const checked = event.target.checked; update((draft) => setRowChecked(draft, row.index, checked)); }} />
      <span aria-hidden="true">{row.line}</span></label></td>
    {cell("name")}{cell("estimate")}{cell("link")}{cell("comment")}
    {showSource && <td><select id={id("source")} aria-label={`Источник, строка ${row.line}`} aria-invalid={invalid("source")} aria-describedby={about("source")}
      value={row.sourceId ?? ""} onChange={(event) => { const value = event.target.value; update((draft) => setRowSource(draft, row.index, value)); }}>
      {!row.sourceId && <option value="" disabled>{row.sourceHint}</option>}
      {sources.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id)}</option>)}
    </select></td>}
    <td className="pp-import-issues">{row.issues.length
      ? <ul>{row.issues.map((issue, index) => <li key={index}><span id={issueId(index)}><Sign tone={ISSUE_TONE[issue.level]}>{issue.level === "repeat" ? `Повтор. ${issue.text}` : issue.text}</Sign></span>
        {issue.withoutEstimate && <button type="button" className="project-link-button"
          onClick={() => { update((draft) => withoutEstimate(draft, row)); focusLater(id("estimate")); }}>Добавить без оценки</button>}</li>)}</ul>
      : <Sign tone="fits">Готово к добавлению</Sign>}</td>
  </tr>;
}, (before, after) => before.showSource === after.showSource && before.sources === after.sources && before.labels === after.labels && before.update === after.update
  && JSON.stringify(before.row) === JSON.stringify(after.row));

function OutcomeStage(props: ImportDialogProps & { draft: ImportDraft; outcome: ImportOutcome; focusRef: RefObject<HTMLElement> }) {
  const { draft, outcome, snapshot, onDraft, onClose, focusRef } = props;
  const [copied, setCopied] = useState<"ok" | "manual" | null>(null);
  const [drop, setDrop] = useState(false);
  const text = skippedTableText(draft, snapshot);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied("ok"); }
    catch { setCopied("manual"); }
  }
  const place = outcome.mark === "plan" ? "в план квартала" : "на рассмотрение";
  return <>
    <div className="pp-modal-body">
      <p role="status"><b>Добавлено {place}: {works(outcome.added.length)}.</b> Не добавлено: {lines(outcome.skipped.length)}{outcome.emptyLines ? `; пустых строк: ${outcome.emptyLines}` : ""}. Пропущенные строки остаются в этом окне, пока открыт проект.</p>
      {outcome.added.length > 0 && <>
        <h3 className="pp-import-h">Добавлены</h3>
        <div className="data-table-wrap"><table className="project-table" aria-label="Добавленные работы"><thead><tr><th className="pp-col-line">Стр.</th><th>Работа</th><th>Источник</th><th className="project-number">Оценка</th></tr></thead>
          <tbody>{outcome.added.map((row) => <tr key={row.line}><td className="pp-col-line">{row.line}</td><td>{row.name}</td><td>{row.sourceName}</td>
            <td className="project-number">{row.estimate === null ? <Sign tone="unknown">Без оценки</Sign> : hours(row.estimate)}</td></tr>)}</tbody></table></div></>}
      <h3 className="pp-import-h">Пропущены</h3>
      <div className="data-table-wrap"><table className="project-table" aria-label="Пропущенные строки"><thead><tr><th className="pp-col-line">Стр.</th><th>Работа</th><th>Причина</th></tr></thead>
        <tbody>{outcome.skipped.map((row) => <tr key={row.line}><td className="pp-col-line">{row.line}</td><td>{row.name || <span className="project-muted">без названия</span>}</td><td>{row.reason}</td></tr>)}</tbody></table></div>
      {copied === "ok" && <p className="pp-hintline" role="status">Пропущенные строки скопированы вместе со строкой заголовков.</p>}
      {copied === "manual" && <label className="pp-import-paste">Скопируйте строки вручную
        <textarea readOnly rows={6} value={text} autoFocus onFocus={(event) => event.currentTarget.select()} /></label>}
      {drop && <div className="project-message warning" role="alert">
        <p>Убрать пропущенные строки из окна? Они не добавлены в квартал; если они нужны, сначала скопируйте их.</p>
        <div className="project-actions"><button type="button" className="secondary" id="import-drop-no" autoFocus onClick={() => { setDrop(false); focusLater("import-drop"); }}>Оставить</button>
          <button type="button" className="danger" id="import-drop-yes" onClick={() => { onDraft(null); onClose(); }}>Убрать строки</button></div>
      </div>}
    </div>
    <div className="pp-modal-foot">
      <button type="button" className="project-link-button" id="import-drop" onClick={() => setDrop(true)}>Убрать пропущенные</button>
      <span className="project-actions">
        <button type="button" className="secondary" id="import-copy-skipped" onClick={() => { void copy(); }}>Скопировать пропущенные</button>
        <button type="button" className="secondary" id="import-fix-skipped" onClick={() => onDraft({ ...draft, outcome: null })}>Исправить пропущенные</button>
        <button ref={focusRef as RefObject<HTMLButtonElement>} type="button" id="import-done" autoFocus onClick={onClose}>Готово</button></span>
    </div>
  </>;
}

/** Keyboard of the add form: Enter-separated rows pasted into «Название» open the import. */
export function onNamePaste(event: ClipboardEvent<HTMLInputElement>, open: (text: string) => void) {
  const text = event.clipboardData.getData("text/plain");
  if (!isTablePaste(text)) return;
  event.preventDefault();
  open(text);
}
