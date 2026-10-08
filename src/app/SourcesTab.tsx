import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatDeficitHours, formatSignedHours } from "../domain/capacity/input-format";
import type { QuarterCapacityResult, QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";
import { reserveByPerson } from "../domain/capacity/reserve";
import {
  describeAllocation, describePlanned, describeQuotaDrops, effectivePercent, formatPercent, parseShareInput,
  ratioPercent, sameOnScreen, sourceState, unallocatedAfter
} from "../domain/capacity/source-plan";
import { DeleteButton, DialogPortal, InfoHint, useDialogFocus } from "./project-ui";
import { hours, Kbd, Sign, useCommittedText } from "./plan-ui";

type Snapshot = QuarterSnapshot;
type Direction = Snapshot["directions"][number];
type Update = (updater: (current: Snapshot) => Snapshot, forPlanId?: string) => void;
type SetPending = (key: string, dirty: boolean, message?: string) => void;

const shareText = (percent: string | null) => percent === null ? "" : percent.replace(".", ",");

/** «Новый источник», then «Новый источник 2» … so a fresh row is valid at once. */
function newSourceName(directions: readonly Direction[]): string {
  const names = new Set(directions.map((direction) => direction.name.trim().toLowerCase()));
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? "Новый источник" : `Новый источник ${index}`;
    if (!names.has(name.toLowerCase())) return name;
  }
}

function NameCell({ direction, others, planId, update, setPending }: {
  direction: Direction; others: readonly Direction[]; planId: string; update: Update; setPending: SetPending;
}) {
  const key = `source-name:${planId}:${direction.id}`;
  const field = useCommittedText<string>({
    value: direction.name, column: "name", show: (value) => value,
    parse: (text) => text.trim() ? { ok: true, value: text } : { ok: false, message: "Введите название источника." },
    commit: (name) => update((current) => ({ ...current,
      directions: current.directions.map((item) => item.id === direction.id ? { ...item, name } : item) }), planId),
    setPending: (message) => setPending(key, message !== null, message ?? undefined)
  });
  const duplicate = field.text.trim() && others.some((item) => item.id !== direction.id
    && item.name.trim().toLowerCase() === field.text.trim().toLowerCase());
  return <td className="pp-name-cell">
    <input type="text" id={`src-name-${direction.id}`} maxLength={1000} placeholder="Название источника"
      aria-label="Название источника" aria-describedby={field.error ? `src-name-${direction.id}-error` : undefined} {...field.inputProps} />
    {field.error && <span className="project-field-error" id={`src-name-${direction.id}-error`}>{field.error}</span>}
    {!field.error && duplicate && <span className="pp-saved"><Sign tone="unknown">Такой источник уже есть.</Sign></span>}
  </td>;
}

function ShareCell({ direction, planId, update, setPending, ownNote, savedNote, onOpenReserve, reserveDisabled }: {
  direction: Direction; planId: string; update: Update; setPending: SetPending;
  ownNote: string | null; savedNote: string | null; onOpenReserve: (() => void) | null; reserveDisabled: boolean;
}) {
  const key = `source-share:${planId}:${direction.id}`;
  const name = direction.name.trim() || "без названия";
  const field = useCommittedText<string | null>({
    value: direction.percent, column: "share", show: shareText,
    parse: (text) => {
      const share = parseShareInput(text);
      return share.kind === "invalid" ? { ok: false, message: share.message }
        : { ok: true, value: share.kind === "empty" ? null : share.percent };
    },
    // An unreadable share does not count until it is fixed (QUARTER_PLANNING_UX.md).
    invalid: { value: null },
    commit: (percent) => update((current) => ({ ...current,
      directions: current.directions.map((item) => item.id === direction.id ? { ...item, percent } : item) }), planId),
    setPending: (message) => setPending(key, message !== null, message ? `Доля источника «${name}»: ${message.toLowerCase()}` : undefined)
  });
  return <td className="project-number">
    <input type="text" className="pp-share" inputMode="decimal" placeholder="—" id={`src-share-${direction.id}`}
      aria-label={`${direction.kind === "reserve" && direction.memberPercents.length ? "Общая доля резерва" : "Доля"}, %: ${name}`}
      aria-describedby={field.error ? `src-share-${direction.id}-error` : undefined} {...field.inputProps} />
    {field.error && <span className="project-field-error" id={`src-share-${direction.id}-error`}>{field.error}</span>}
    {!field.error && ownNote && <span className="pp-saved">{ownNote}</span>}
    {!field.error && !ownNote && direction.percent === null && <span className="pp-saved">не задана</span>}
    {savedNote && <span className="pp-saved changed">{savedNote}</span>}
    {onOpenReserve && <button type="button" className="project-link-button pp-reserve-link" id={`reserve-open-${direction.id}`}
      disabled={reserveDisabled} title={reserveDisabled ? "Доли сотрудников — когда данные квартала заполнены и есть расчёт" : undefined}
      onClick={onOpenReserve}>Доли сотрудников…</button>}
  </td>;
}

export function SourcesTab({ planId, quarter, snapshot, saved, result, savedResult, update, setPending, saveHint, onDialog }: {
  planId: string;
  quarter: string;
  snapshot: Snapshot;
  saved: Snapshot | null;
  result: QuarterCapacityResult | null;
  savedResult: QuarterCapacityResult | null;
  update: Update;
  setPending: SetPending;
  /** Grows when Ctrl+S is pressed while a window of this tab is open. */
  saveHint: number;
  onDialog: (open: boolean) => void;
}) {
  const [removed, setRemoved] = useState<{ direction: Direction; index: number } | null>(null);
  const [applied, setApplied] = useState("");
  const [reserveId, setReserveId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // The window needs the calculation; without it the link is disabled, so the page is never left inert.
  const reserveOpen = reserveId !== null && result !== null;
  useEffect(() => { onDialog(reserveOpen); }, [reserveOpen, onDialog]);
  useEffect(() => () => onDialog(false), [onDialog]);
  useEffect(() => {
    if (!focusId) return;
    const input = document.getElementById(`src-name-${focusId}`) as HTMLInputElement | null;
    input?.focus();
    input?.select();
    setFocusId(null);
  }, [focusId]);

  const allocation = result ? describeAllocation(result) : null;
  const drops = useMemo(() => result ? describeQuotaDrops(savedResult, result, hours) : [], [savedResult, result]);
  const available = result?.totals.availableHours ?? null;

  function addSource() {
    const id = crypto.randomUUID();
    update((current) => ({ ...current, directions: [...current.directions,
      { id, name: newSourceName(current.directions), percent: null, kind: "work", memberPercents: [] }] }));
    setRemoved(null);
    setApplied("");
    setFocusId(id);
  }

  function removeSource(direction: Direction, index: number) {
    update((current) => current.tasks.some((task) => task.directionId === direction.id) ? current
      : { ...current, directions: current.directions.filter((item) => item.id !== direction.id) });
    setRemoved({ direction, index });
    setApplied("");
  }

  function undoRemove() {
    if (!removed) return;
    update((current) => {
      if (current.directions.some((item) => item.id === removed.direction.id)) return current;
      const directions = [...current.directions];
      directions.splice(Math.min(removed.index, directions.length), 0, removed.direction);
      return { ...current, directions };
    });
    setRemoved(null);
  }

  const heading = <div className="project-section-heading">
    <div><h2>Источники и доли <InfoHint info="source" /></h2>
      <p>Доли считаются от доступной ёмкости команды{available !== null ? `: ${hours(available)}` : ""}, до выделения резервов. Если доступность изменится, доли сохранятся, а часы пересчитаются. Сумма долей меньше 100% допустима.</p></div>
    <button type="button" id="btn-source-add" onClick={addSource}>Добавить источник</button>
  </div>;
  const undoLine = removed && <div className="project-message" role="status">
    Источник «{removed.direction.name.trim() || "без названия"}» удалён. <button type="button" className="project-link-button" onClick={undoRemove}>Отменить</button>
  </div>;

  if (!snapshot.directions.length) {
    return <>{heading}{undoLine}
      <section className="pp-setup"><h2>Источников пока нет</h2>
        <p>Добавьте резерв на встречи и ритуалы и источники работ: заказчиков, продуктовые команды, вторую линию, техдолг. Для каждого укажите долю квартала в процентах. Можно начать с одного источника и без доли.</p>
      </section></>;
  }

  const reserve = reserveId ? snapshot.directions.find((direction) => direction.id === reserveId) : undefined;
  return <>
    {heading}
    {allocation?.overallocated && <div className="project-message error" role="status">
      Сумма долей {allocation.allocatedPercentText}: {allocation.excessHours === "0" ? "больше 100%" : `на ${formatDeficitHours(allocation.excessHours, hours)} больше доступной ёмкости`}. Уменьшите доли. Квартал можно сохранить, ошибка останется видна в плане.
    </div>}
    {drops.length > 0 && <div className="project-message warning" role="status">
      После изменения долей перебор: {drops.join("; ")}. Работы из плана сами не исключаются: решите, что оставить.
    </div>}
    {applied && <div className="project-message" role="status">{applied}</div>}
    {undoLine}
    <div className="data-table-wrap"><table className="project-table pp-sources" aria-label="Источники и доли">
      <thead><tr>
        <th>Источник</th><th>Вид <InfoHint info="reserve" /></th><th className="project-number">Доля, %</th>
        <th className="project-number">Квота <InfoHint info="quota" /></th>
        <th className="project-number">Занято в плане <InfoHint info="planned" /></th>
        <th>Остаток квоты <InfoHint info="rest" /></th><th><span className="visually-hidden">Удалить</span></th>
      </tr></thead>
      <tbody>{snapshot.directions.map((direction, index) => {
        const capacity = result?.directions.find((row) => row.directionId === direction.id);
        const before = savedResult?.directions.find((row) => row.directionId === direction.id);
        const savedDirection = saved?.directions.find((row) => row.id === direction.id);
        const hasWorks = snapshot.tasks.some((task) => task.directionId === direction.id);
        const ownCount = direction.kind === "reserve" ? direction.memberPercents.length : 0;
        const effective = capacity && available !== null ? effectivePercent(capacity, available) : null;
        const ownNote = ownCount ? `общая; своя у ${ownCount} · всего ${effective === null ? "—" : formatPercent(effective)}` : null;
        const savedNote = !saved ? null : !savedDirection ? "новый"
          : savedDirection.percent !== direction.percent ? `сохранено: ${savedDirection.percent === null ? "не задана" : formatPercent(savedDirection.percent)}` : null;
        const quotaChanged = capacity && before && (capacity.quotaSet !== before.quotaSet
          || (capacity.quotaSet && !sameOnScreen(capacity.budgetHours, before.budgetHours)));
        const state = capacity ? sourceState(capacity) : null;
        const savedState = before ? sourceState(before) : null;
        let planned: ReactNode = <span className="project-muted">—</span>;
        let rest: ReactNode = <span className="project-muted">—</span>;
        if (direction.kind === "reserve") {
          planned = <span className="project-muted">резерв, без работ</span>;
        } else if (capacity && state) {
          if (capacity.planCount) planned = describePlanned(state, hours);
          rest = !capacity.quotaSet ? <span className="project-muted">доля не задана</span>
            : state.overrunHours !== "0" ? <Sign tone="over">перебор {state.missingEstimateCount ? "не менее " : ""}{formatDeficitHours(state.overrunHours, hours)}</Sign>
            : <>{state.missingEstimateCount ? <span className="pp-q">не более </span> : null}{hours(state.remainingHours)}
              {!hasWorks && <span className="pp-saved">работ нет</span>}</>;
          const restChanged = savedState && before && before.quotaSet && capacity.quotaSet
            && (savedState.overrunHours !== state.overrunHours || savedState.remainingHours !== state.remainingHours);
          if (restChanged && savedState) {
            rest = <>{rest}<span className="pp-saved changed">сохранено: {savedState.overrunHours !== "0"
              ? `перебор ${formatDeficitHours(savedState.overrunHours, hours)}` : `остаток ${hours(savedState.remainingHours)}`}</span></>;
          }
        }
        return <tr key={direction.id} data-source={direction.id}>
          <NameCell direction={direction} others={snapshot.directions} planId={planId} update={update} setPending={setPending} />
          <td><select id={`src-kind-${direction.id}`} aria-label={`Вид: ${direction.name}`} value={direction.kind}
            onChange={(event) => update((current) => ({ ...current, directions: current.directions.map((item) =>
              item.id === direction.id ? { ...item, kind: event.target.value === "reserve" ? "reserve" : "work" } : item) }))}>
            <option value="work" disabled={ownCount > 0}>Работы{ownCount > 0 ? " (сначала уберите доли сотрудников)" : ""}</option>
            <option value="reserve" disabled={hasWorks}>Резерв{hasWorks ? " (есть работы)" : ""}</option>
          </select></td>
          <ShareCell direction={direction} planId={planId} update={update} setPending={setPending} ownNote={ownNote} savedNote={savedNote}
            onOpenReserve={direction.kind === "reserve" ? () => { setApplied(""); setReserveId(direction.id); } : null}
            reserveDisabled={result === null} />
          <td className="project-number"><span className="pp-cellnum">{capacity?.quotaSet ? hours(capacity.budgetHours) : "—"}</span>
            {quotaChanged && before && <span className="pp-saved changed">сохранено: {before.quotaSet ? hours(before.budgetHours) : "—"}</span>}</td>
          <td className="project-number"><span className="pp-cellnum text">{planned}</span></td>
          <td><span className="pp-cellnum text">{rest}</span></td>
          <td className="project-row-action"><DeleteButton disabled={hasWorks} label={`Удалить источник ${direction.name.trim() || index + 1}`}
            title={hasWorks ? "Источник с работами удалить нельзя: сначала удалите или перенесите его работы в «Плане квартала»" : "Удалить источник"}
            onClick={() => removeSource(direction, index)} /></td>
        </tr>;
      })}</tbody>
      {allocation && <tfoot>
        <tr><td colSpan={2}>Выделено источникам</td><td className="project-number">{allocation.allocatedPercentText}</td>
          <td className="project-number">{hours(allocation.allocatedHours)}</td><td colSpan={3} /></tr>
        <tr><td colSpan={2}>Не распределено <InfoHint info="unallocated" /></td>
          <td className="project-number">{allocation.overallocated ? <Sign tone="over">{allocation.unallocatedPercentText}</Sign> : allocation.unallocatedPercentText}</td>
          <td className="project-number">{formatSignedHours(allocation.unallocatedHours, hours)}</td>
          <td colSpan={3}>{allocation.overallocated ? <Sign tone="over">сумма долей больше 100%</Sign>
            : result && result.plan.overrunHours !== "0"
              ? <Sign tone="over">перебор в источниках: {formatDeficitHours(result.plan.overrunHours, hours)}</Sign>
              : <span className="project-muted">ни за кем не закреплено</span>}</td></tr>
      </tfoot>}
    </table></div>
    <p className="project-muted pp-table-note"><Kbd name="enter" /> — к той же колонке следующей строки, <Kbd name="esc" /> — вернуть значение поля. Источник с работами удалить нельзя, работы вместе с ним не удаляются: сначала удалите или перенесите их в «Плане квартала».</p>
    {reserve && result && <ReserveDialog source={reserve} snapshot={snapshot} result={result} saveHint={saveHint}
      onCancel={() => setReserveId(null)}
      onApply={(percent, memberPercents) => {
        const changed = percent !== reserve.percent || JSON.stringify(memberPercents) !== JSON.stringify(reserve.memberPercents);
        update((current) => ({ ...current, directions: current.directions.map((item) =>
          item.id === reserve.id ? { ...item, percent, memberPercents } : item) }));
        setReserveId(null);
        if (changed) setApplied(`Резерв «${reserve.name.trim()}» применён к кварталу «${quarter}». В файл проекта изменения попадут при сохранении квартала.`);
      }} />}
  </>;
}

/** Own shares of people in a reserve (DEC-038). Applied to the quarter; the file changes on save. */
function ReserveDialog({ source, snapshot, result, saveHint, onCancel, onApply }: {
  source: Direction; snapshot: Snapshot; result: QuarterCapacityResult; saveHint: number;
  onCancel: () => void;
  onApply: (percent: string, memberPercents: Direction["memberPercents"]) => void;
}) {
  const [common, setCommon] = useState(shareText(source.percent));
  const [own, setOwn] = useState<Record<string, string>>(() =>
    Object.fromEntries(source.memberPercents.map((row) => [row.memberId, shareText(row.percent)])));
  const [hint, setHint] = useState(false);
  const firstHint = useRef(saveHint);
  useEffect(() => { if (saveHint !== firstHint.current) setHint(true); }, [saveHint]);
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useDialogFocus(dialog, first, onCancel);

  const commonShare = parseShareInput(common);
  const commonError = commonShare.kind === "empty" ? "Укажите общую долю." : commonShare.kind === "invalid" ? commonShare.message : "";
  const ownShares = new Map<string, string>();
  const ownErrors = new Map<string, string>();
  for (const member of snapshot.members) {
    const parsed = parseShareInput(own[member.id] ?? "");
    if (parsed.kind === "percent") ownShares.set(member.id, parsed.percent);
    if (parsed.kind === "invalid") ownErrors.set(member.id, parsed.message);
  }
  const people = snapshot.members.map((member) => ({
    memberId: member.id, name: member.name,
    availableHours: result.members.find((row) => row.memberId === member.id)?.availableHours ?? "0"
  }));
  const broken = Boolean(commonError) || ownErrors.size > 0;
  const forecast = reserveByPerson(people, commonShare.kind === "percent" ? commonShare.percent : null, ownShares);
  const capacity = result.directions.find((row) => row.directionId === source.id);
  const now = capacity?.quotaSet ? capacity.budgetHours : null;
  const total = broken ? null : forecast.total;
  const after = total === null ? null : unallocatedAfter(result, source.id, total);

  function apply() {
    if (total === null || commonShare.kind !== "percent") return;
    onApply(commonShare.percent, snapshot.members.filter((member) => ownShares.has(member.id))
      .map((member) => ({ memberId: member.id, percent: ownShares.get(member.id)! })));
  }
  const onEnter = (event: KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); apply(); } };

  return <DialogPortal><div className="project-modal-backdrop">
    <div ref={dialog} className="project-modal pp-mid" role="dialog" aria-modal="true" aria-labelledby="reserve-title">
      <div className="pp-modal-head"><h2 id="reserve-title">Резерв «{source.name.trim()}»: доли сотрудников</h2>
        <p>Регулярные встречи и ритуалы команды. Часы резерва не выделяются заказчикам и не считаются свободными.</p></div>
      <div className="pp-modal-body">
        <label className="pp-inline-label">Общая доля, %
          <input ref={first} type="text" inputMode="decimal" className="pp-share" value={common} aria-invalid={Boolean(commonError)}
            aria-describedby="res-share-note" onChange={(event) => setCommon(event.target.value)} onKeyDown={onEnter} /></label>
        {commonError && <span className="project-field-error">{commonError}</span>}
        <p className="project-muted" id="res-share-note">Действует для всех, у кого своя доля не задана.</p>
        <div className="data-table-wrap pp-people"><table className="project-table" aria-label="Резерв по сотрудникам">
          <thead><tr><th>Сотрудник</th><th className="project-number">Доступно</th><th className="project-number">Своя доля, %</th>
            <th>Действует</th><th className="project-number">Резерв</th></tr></thead>
          <tbody>{people.map((person) => {
            const error = ownErrors.get(person.memberId);
            const row = forecast.members.find((item) => item.memberId === person.memberId);
            const known = !error && row?.percent != null;
            return <tr key={person.memberId}>
              <td>{person.name || "Сотрудник без имени"}</td>
              <td className="project-number">{hours(person.availableHours)}</td>
              <td className="project-number"><input type="text" inputMode="decimal" className="pp-share" value={own[person.memberId] ?? ""}
                placeholder={commonShare.kind === "percent" ? `общая ${formatPercent(commonShare.percent)}` : "—"}
                aria-label={`Своя доля, %: ${person.name}`} aria-invalid={Boolean(error)}
                onChange={(event) => setOwn((current) => ({ ...current, [person.memberId]: event.target.value }))} onKeyDown={onEnter} />
                {error && <span className="project-field-error">{error}</span>}</td>
              <td>{known && row ? <>{formatPercent(row.percent!)} <span className="project-muted">{row.own ? "своя" : "общая"}</span></> : <span className="project-muted">—</span>}</td>
              <td className="project-number">{known && row?.reserveHours ? hours(row.reserveHours) : <span className="project-muted">—</span>}</td>
            </tr>;
          })}
          {!people.length && <tr><td colSpan={5} className="project-table-empty">В квартале нет сотрудников: резерв по людям появится, когда они будут добавлены.</td></tr>}
          </tbody>
          <tfoot><tr><td><b>Команда</b></td><td className="project-number"><b>{hours(result.totals.availableHours)}</b></td><td />
            <td>{total === null ? "" : `${formatTeamShare(total, result.totals.availableHours)} ёмкости`}</td>
            <td className="project-number"><b>{total === null ? "—" : hours(total)}</b></td></tr></tfoot>
        </table></div>
        <p className="project-muted pp-dialog-note">Доступно — часы сотрудника после календаря, ставки и отсутствий. Своя доля заменяет общую, а не добавляется к ней. Резерв команды — сумма резервов сотрудников. Доли заказчиков по-прежнему считаются от всей доступной ёмкости, {hours(result.totals.availableHours)}.</p>
        {hint && <p className="pp-hintline" role="status">Сначала примените или отмените изменения в этом окне, затем сохраните квартал.</p>}
      </div>
      <div className="pp-modal-foot">
        <div className="pp-effect-line" role="status">{total === null || after === null
          ? <span className="project-field-error">Исправьте доли выше.</span>
          : <span>Резерв: <b>{hours(total)}</b>{now !== null && !sameOnScreen(now, total) && <> <span className="pp-was">сейчас {hours(now)}</span></>}. Не распределено станет {after.startsWith("-") ? <Sign tone="over">{formatSignedHours(after, hours)}</Sign> : formatSignedHours(after, hours)}.</span>}</div>
        <span className="project-actions"><button type="button" className="secondary" onClick={onCancel}>Отмена</button>
          <button type="button" id="reserve-apply" disabled={total === null} onClick={apply}>Применить</button><Kbd name="enter" /></span>
      </div>
    </div>
  </div></DialogPortal>;
}

function formatTeamShare(part: string, whole: string): string {
  const percent = ratioPercent(part, whole, 2);
  return percent === null ? "—" : formatPercent(percent);
}
