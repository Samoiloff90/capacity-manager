import { FormEvent, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { TeamEmployeeForm, TeamPageData, TeamTableRow, teamService } from "../domain/team/team.service";
import { useTeam } from "../app/team-context";

const emptyForm: TeamEmployeeForm = {
  fullName: "",
  competencyId: 0,
  fte: 1,
  productiveRatio: 0.7,
  notes: ""
};

export function TeamPage() {
  const teamState = useTeam();
  const teamId = teamState.team?.id;
  const nameChanged = teamState.team !== null && teamState.nameDraft !== teamState.team.name;
  const [data, setData] = useState<TeamPageData | null>(null);
  const [form, setForm] = useState<TeamEmployeeForm>(emptyForm);
  const [search, setSearch] = useState("");
  const [competencyFilter, setCompetencyFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadData() {
    if (teamId === undefined) return;
    setIsLoading(true);
    setError("");
    try {
      const pageData = await teamService.getPageData(teamId);
      setData(pageData);
      setForm((current) => ({
        ...current,
        competencyId: current.competencyId || pageData.competencies[0]?.id || 0
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить команду");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [teamId]);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((row) => {
      const matchesSearch = row.person.full_name.toLowerCase().includes(search.trim().toLowerCase());
      const matchesCompetency = competencyFilter === "all" || row.person.competency_id === Number(competencyFilter);
      return matchesSearch && matchesCompetency;
    });
  }, [data, search, competencyFilter]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (teamId === undefined) return;
    if (!form.fullName.trim()) {
      setError("Укажите ФИО сотрудника");
      return;
    }
    if (!form.competencyId) {
      setError("Выберите компетенцию");
      return;
    }

    await teamService.saveEmployee(form, teamId);
    setForm({ ...emptyForm, competencyId: data?.competencies[0]?.id ?? 0 });
    await loadData();
  }

  function startEdit(row: TeamTableRow) {
    setForm({
      id: row.person.id,
      fullName: row.person.full_name,
      competencyId: row.person.competency_id,
      fte: row.person.fte,
      productiveRatio: row.person.productive_ratio,
      notes: row.person.notes ?? ""
    });
  }

  async function deleteEmployee(row: TeamTableRow) {
    const confirmed = window.confirm(`Удалить сотрудника "${row.person.full_name}"?`);
    if (!confirmed) return;
    await teamService.deleteEmployee(row.person.id);
    if (form.id === row.person.id) {
      setForm({ ...emptyForm, competencyId: data?.competencies[0]?.id ?? 0 });
    }
    await loadData();
  }

  function cancelEdit() {
    setForm({ ...emptyForm, competencyId: data?.competencies[0]?.id ?? 0 });
    setError("");
  }

  return (
    <section className="page team-page">
      <div className="page-heading">
        <div>
          <h2>Команда</h2>
          <p>Таблица сотрудников, ставок, производственной загрузки и расчетной емкости по месяцам.</p>
        </div>
      </div>

      <form className="team-name-form" onSubmit={(event) => {
        event.preventDefault();
        void teamState.saveName();
      }}>
        <label htmlFor="team-name">
          Название команды
          <input
            id="team-name"
            value={teamState.nameDraft}
            onChange={(event) => teamState.changeNameDraft(event.target.value)}
            disabled={!teamState.team || teamState.isLoading || teamState.isSaving}
            aria-invalid={Boolean(teamState.saveError)}
            aria-describedby={teamState.saveError ? "team-name-error" : "team-name-status"}
          />
        </label>
        <div className="team-name-actions">
          <button type="submit" disabled={!nameChanged || teamState.isLoading || teamState.isSaving}>
            {teamState.isSaving ? "Сохранение…" : "Сохранить название"}
          </button>
          {nameChanged && (
            <button className="secondary" type="button" disabled={teamState.isSaving} onClick={teamState.resetNameDraft}>
              Отменить изменения
            </button>
          )}
          <p id="team-name-status" role="status">
            {teamState.isLoading ? "Загрузка названия команды…"
              : teamState.loadError ? "Название команды недоступно. Повторите загрузку в шапке."
              : teamState.isSaving ? "Название сохраняется…"
              : nameChanged ? "Есть несохранённые изменения"
              : teamState.nameSaved ? "Название сохранено" : ""}
          </p>
        </div>
        {teamState.saveError && <div id="team-name-error" className="inline-error" role="alert">{teamState.saveError}</div>}
      </form>

      <form className="employee-form" onSubmit={handleSubmit}>
        <input
          aria-label="ФИО"
          placeholder="ФИО"
          value={form.fullName}
          onChange={(event) => setForm({ ...form, fullName: event.target.value })}
        />
        <select
          aria-label="Компетенция"
          value={form.competencyId}
          onChange={(event) => setForm({ ...form, competencyId: Number(event.target.value) })}
        >
          <option value={0} disabled>
            Компетенция
          </option>
          {data?.competencies.map((competency) => (
            <option key={competency.id} value={competency.id}>
              {competency.name}
            </option>
          ))}
        </select>
        <label>
          <span>Ставка</span>
          <input
            min="0"
            max="1"
            step="0.05"
            type="number"
            value={form.fte}
            onChange={(event) => setForm({ ...form, fte: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Загрузка</span>
          <input
            min="0"
            max="1"
            step="0.05"
            type="number"
            value={form.productiveRatio}
            onChange={(event) => setForm({ ...form, productiveRatio: Number(event.target.value) })}
          />
        </label>
        <button type="submit" disabled={!data || isLoading}>
          {form.id ? <Save size={16} /> : <Plus size={16} />}
          {form.id ? "Сохранить" : "Добавить"}
        </button>
        {form.id && (
          <button className="secondary" type="button" onClick={cancelEdit}>
            <X size={16} />
            Отмена
          </button>
        )}
      </form>

      <div className="table-toolbar">
        <input
          aria-label="Поиск по ФИО"
          placeholder="Поиск по ФИО"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Фильтр по компетенции"
          value={competencyFilter}
          onChange={(event) => setCompetencyFilter(event.target.value)}
        >
          <option value="all">Все компетенции</option>
          {data?.competencies.map((competency) => (
            <option key={competency.id} value={competency.id}>
              {competency.name}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="inline-error">{error}</div>}
      {isLoading && teamState.team && <div className="empty-state">Загрузка команды...</div>}

      {!isLoading && data && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Компетенция</th>
                <th>Ставка</th>
                <th>Производственная загрузка</th>
                {data.months.map((month) => (
                  <th key={month.id}>{month.month_name}</th>
                ))}
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.person.id}>
                  <td>{row.person.full_name}</td>
                  <td>{row.competencyName}</td>
                  <td>{formatNumber(row.person.fte)}</td>
                  <td>{formatPercent(row.person.productive_ratio)}</td>
                  {row.months.map(({ month, capacity }) => (
                    <td key={month.id}>
                      <span
                        className="capacity-cell"
                        title={`Рабочих дней: ${capacity.workingDays}
Отсутствия: ${capacity.absenceWorkingDays}
Доступно: ${capacity.availableDays}
Производственные дни: ${capacity.productiveDays}
Часы: ${capacity.productiveHours}
Спринты: ${capacity.sprints ?? "н/д"}`}
                      >
                        <b>{capacity.productiveDays} д</b>
                        <span>{capacity.productiveHours} ч</span>
                        <span>{capacity.sprints ?? "н/д"} сп</span>
                      </span>
                    </td>
                  ))}
                  <td>
                    <div className="row-actions">
                      <button className="icon-button" type="button" title="Редактировать" onClick={() => startEdit(row)}>
                        <Pencil size={16} />
                      </button>
                      <button className="icon-button danger" type="button" title="Удалить" onClick={() => deleteEmployee(row)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5 + data.months.length}>Сотрудники не найдены</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
