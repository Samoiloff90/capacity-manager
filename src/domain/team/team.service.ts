import { calculateCapacity } from "../capacity/capacity.calculator";
import { CapacityAbsence, CapacityMonth, CapacityPerson, PersonCapacityResult } from "../capacity/capacity.types";
import {
  absencesRepository,
  competenciesRepository,
  peopleRepository,
  quarterMonthsRepository,
  quarterPlansRepository,
  teamsRepository
} from "../../db/repositories";
import { Competency, Person, QuarterMonth, QuarterPlan, Team } from "../../db/types";

const DEFAULT_COMPETENCIES = ["SA", "BPMN", "Frontend", "Java", "Python", "QA"];

const DEFAULT_QUARTER_MONTHS = [
  { month: 4, month_name: "Апрель", working_days: 21 },
  { month: 5, month_name: "Май", working_days: 22 },
  { month: 6, month_name: "Июнь", working_days: 22 }
];

export type TeamEmployeeForm = {
  id?: number;
  fullName: string;
  competencyId: number;
  fte: number;
  productiveRatio: number;
  notes?: string | null;
};

export type TeamTableRow = {
  person: Person;
  competencyName: string;
  months: Array<{
    month: QuarterMonth;
    capacity: PersonCapacityResult;
  }>;
};

export type TeamPageData = {
  team: Team;
  quarterPlan: QuarterPlan;
  months: QuarterMonth[];
  competencies: Competency[];
  rows: TeamTableRow[];
};

export const teamService = {
  async getTeam(): Promise<Team> {
    return ensureTeam();
  },

  async renameTeam(teamId: number, inputName: string): Promise<Team> {
    const name = inputName.trim();
    if (!name) throw new Error("Укажите название команды");
    const team = await getTeamById(teamId);
    await teamsRepository.save({
      id: team.id,
      name,
      lead_name: team.lead_name,
      description: team.description
    });
    return getTeamById(team.id);
  },

  async getPageData(teamId?: number): Promise<TeamPageData> {
    const { team, competencies, quarterPlan, months } = await ensureBaseData(teamId);
    const people = await peopleRepository.list(team.id);
    const absences = await absencesRepository.list();
    const rows = buildRows(people, competencies, quarterPlan, months, absences);

    return {
      team,
      quarterPlan,
      months,
      competencies,
      rows
    };
  },

  async saveEmployee(input: TeamEmployeeForm, teamId?: number) {
    const { team } = await ensureBaseData(teamId);
    await peopleRepository.save({
      id: input.id,
      team_id: team.id,
      full_name: input.fullName.trim(),
      competency_id: input.competencyId,
      fte: input.fte,
      productive_ratio: input.productiveRatio,
      notes: input.notes ?? null,
      is_active: 1
    });
  },

  async deleteEmployee(id: number) {
    await peopleRepository.remove(id);
  }
};

// Each bootstrap reads before inserting; serialize overlapping StrictMode requests.
let baseDataQueue: Promise<unknown> = Promise.resolve();

function ensureBaseData(teamId?: number) {
  const result = baseDataQueue.then(async () => {
    const team = teamId === undefined ? await ensureTeam() : await getTeamById(teamId);
    const competencies = await ensureCompetencies();
    const quarterPlan = await ensureQuarterPlan(team.id);
    const months = await ensureQuarterMonths(quarterPlan.id);
    return { team, competencies, quarterPlan, months };
  });
  // Return the original rejection to its caller without blocking later retries.
  baseDataQueue = result.catch(() => undefined);
  return result;
}

async function getTeamById(teamId: number): Promise<Team> {
  const team = await teamsRepository.getById(teamId);
  if (!team) throw new Error("Команда не найдена");
  return team;
}

// The header and React StrictMode can request the initial team concurrently.
let pendingTeam: Promise<Team> | null = null;

function ensureTeam(): Promise<Team> {
  pendingTeam ??= findOrCreateTeam().finally(() => {
    pendingTeam = null;
  });
  return pendingTeam;
}

async function findOrCreateTeam() {
  const teams = await teamsRepository.list();
  // The legacy UI has one team; its selection must not change when its name changes.
  const existing = teams.reduce<Team | undefined>((selected, team) =>
    selected === undefined || team.id < selected.id ? team : selected, undefined);
  if (existing) return existing;

  const teamId = await teamsRepository.save({
    name: "Моя команда",
    lead_name: null,
    description: "Команда разработки"
  });
  const team = await teamsRepository.getById(teamId);
  if (!team) throw new Error("Не удалось создать команду");
  return team;
}

async function ensureCompetencies() {
  const existing = await competenciesRepository.list();
  const existingNames = new Set(existing.map((item) => item.name.toLowerCase()));
  const existingCodes = new Set(existing.map((item) => item.code.toLowerCase()));

  for (const [index, name] of DEFAULT_COMPETENCIES.entries()) {
    if (!existingNames.has(name.toLowerCase()) && !existingCodes.has(name.toLowerCase())) {
      await competenciesRepository.save({ name, code: name, sort_order: index + 1 });
    }
  }

  return competenciesRepository.list();
}

async function ensureQuarterPlan(teamId: number) {
  const plans = await quarterPlansRepository.list(teamId);
  const existing = plans.find((plan) => plan.year === 2026 && plan.quarter === 2);
  if (existing) return existing;

  const planId = await quarterPlansRepository.save({
    team_id: teamId,
    year: 2026,
    quarter: 2,
    hours_per_day: 8,
    days_per_sprint: 10
  });
  const plan = await quarterPlansRepository.getById(planId);
  if (!plan) throw new Error("Не удалось создать квартал");
  return plan;
}

async function ensureQuarterMonths(quarterPlanId: number) {
  const existing = await quarterMonthsRepository.list(quarterPlanId);
  const existingMonths = new Set(existing.map((item) => item.month));

  for (const month of DEFAULT_QUARTER_MONTHS) {
    if (!existingMonths.has(month.month)) {
      await quarterMonthsRepository.save({ quarter_plan_id: quarterPlanId, ...month });
    }
  }

  return quarterMonthsRepository.list(quarterPlanId);
}

function buildRows(
  people: Person[],
  competencies: Competency[],
  quarterPlan: QuarterPlan,
  months: QuarterMonth[],
  absences: Awaited<ReturnType<typeof absencesRepository.list>>
): TeamTableRow[] {
  const competencyById = new Map(competencies.map((competency) => [competency.id, competency]));
  const capacityPeople: CapacityPerson[] = people
    .filter((person) => person.is_active)
    .map((person) => ({
      id: person.id,
      fullName: person.full_name,
      fte: person.fte,
      productiveRatio: person.productive_ratio
    }));
  const capacityAbsences: CapacityAbsence[] = absences.map((absence) => ({
    id: absence.id,
    personId: absence.person_id,
    startDate: absence.start_date,
    endDate: absence.end_date
  }));

  const capacityByMonth = new Map<number, ReturnType<typeof calculateCapacity>>();
  for (const quarterMonth of months) {
    const month: CapacityMonth = {
      year: quarterPlan.year,
      month: quarterMonth.month,
      workingDays: quarterMonth.working_days,
      hoursPerDay: quarterPlan.hours_per_day,
      daysPerSprint: quarterPlan.days_per_sprint
    };
    capacityByMonth.set(
      quarterMonth.id,
      calculateCapacity({
        month,
        people: capacityPeople,
        absences: capacityAbsences
      })
    );
  }

  return people
    .filter((person) => person.is_active)
    .map((person) => ({
      person,
      competencyName: competencyById.get(person.competency_id)?.name ?? "Не указана",
      months: months.map((month) => {
        const capacity = capacityByMonth.get(month.id)?.people.find((item) => item.personId === person.id);
        if (!capacity) {
          throw new Error(`Не удалось рассчитать емкость для ${person.full_name}`);
        }
        return { month, capacity };
      })
    }));
}
