import { useState } from "react";
import { normalizeUserDecimal } from "../domain/capacity/input-format";
import { DeleteButton } from "./project-ui";
import type { QuarterSnapshot } from "../domain/capacity/quarter-capacity.types";

type TasksEditorProps = {
  snapshot: QuarterSnapshot;
  update: (updater: (current: QuarterSnapshot) => QuarterSnapshot) => void;
  onGoToAllocation: () => void;
};

/** All field values live in the workspace draft, including unfinished and invalid input. */
export function TasksEditor({ snapshot, update, onGoToAllocation }: TasksEditorProps) {
  const [removeId, setRemoveId] = useState<string | null>(null);
  const removeTask = snapshot.tasks.find((task) => task.id === removeId);
  const setTask = (id: string, patch: Partial<QuarterSnapshot["tasks"][number]>) => update((current) => ({
    ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch } : task)
  }));

  function addTask() {
    update((current) => {
      const direction = current.directions[0];
      if (!direction) return current;
      return { ...current, tasks: [...current.tasks, {
        id: crypto.randomUUID(), name: "", directionId: direction.id, estimateHours: null,
        mark: "plan", link: null, comment: null
      }] };
    });
  }

  return <>
    <div className="project-section-heading"><div><h2>Задачи квартала</h2>
      <p>Одно направление и одна оценка в часах. Пустая оценка — неизвестна, 0 — ноль часов; дробные — через запятую.</p>
    </div><button type="button" disabled={!snapshot.directions.length} onClick={addTask}>Добавить задачу</button></div>
    {!snapshot.directions.length && <div className="project-message">
      <p>Сначала добавьте направление во вкладке «Распределение», затем укажите его в задаче.</p>
      <div className="project-actions"><button type="button" className="secondary" onClick={onGoToAllocation}>Перейти в «Распределение»</button></div>
    </div>}
    {removeTask && <div className="project-message warning" role="alert">
      <p>Удалить задачу «{removeTask.name || "Без названия"}» из этого квартала?</p>
      <div className="project-actions"><button type="button" className="secondary" onClick={() => setRemoveId(null)}>Отмена</button>
        <button type="button" className="danger" onClick={() => {
          update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== removeTask.id) }));
          setRemoveId(null);
        }}>Подтвердить удаление задачи</button></div>
    </div>}
    <div className="data-table-wrap"><table className="project-table project-tasks-table" aria-label="Задачи квартала">
      <thead><tr><th>Название задачи</th><th>Направление</th><th>Оценка, ч</th><th className="project-row-action"><span className="visually-hidden">Действия</span></th></tr></thead>
      <tbody>{snapshot.tasks.map((task, index) => <tr key={task.id}>
        <td><input className="project-wide-input" aria-label={`Название задачи ${index + 1}`} value={task.name} maxLength={1000}
          placeholder="Название задачи" onChange={(event) => setTask(task.id, { name: event.target.value })} /></td>
        <td><select aria-label={`Направление задачи ${index + 1}`} value={task.directionId}
          onChange={(event) => setTask(task.id, { directionId: event.target.value })}>
          {!snapshot.directions.some((direction) => direction.id === task.directionId) && <option value={task.directionId} disabled>Направление не найдено</option>}
          {snapshot.directions.map((direction) => <option key={direction.id} value={direction.id}>{direction.name || "Направление без названия"}</option>)}
        </select></td>
        <td><input className="project-decimal-input" aria-label={`Оценка задачи ${index + 1}`} inputMode="decimal"
          value={task.estimateHours?.replace(".", ",") ?? ""} placeholder="Без оценки"
          aria-describedby={task.estimateHours === null ? `task-estimate-hint-${task.id}` : undefined}
          onChange={(event) => setTask(task.id, { estimateHours: event.target.value.trim() === "" ? null : event.target.value.replace(",", ".") })}
          onBlur={(event) => {
            try {
              const estimateHours = normalizeUserDecimal(event.target.value);
              if (estimateHours !== task.estimateHours) setTask(task.id, { estimateHours });
            } catch { /* Keep invalid input in the draft for correction. */ }
          }} />
          {task.estimateHours === null && <div className="project-estimate-missing" id={`task-estimate-hint-${task.id}`}>Нет оценки</div>}
        </td>
        <td className="project-row-action"><DeleteButton label={`Удалить задачу ${task.name.trim() || index + 1}`}
          onClick={() => setRemoveId(task.id)} /></td>
      </tr>)}
      {!snapshot.tasks.length && <tr><td colSpan={4} className="project-table-empty">Задачи пока не добавлены. Направление может оставаться резервом без задач.</td></tr>}
      </tbody>
    </table></div>
  </>;
}
