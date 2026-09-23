import { BarChart3, CalendarDays, LayoutDashboard, Package, Settings, Umbrella, Users } from "lucide-react";
import { AnalyticsPage } from "../pages/AnalyticsPage";
import { AbsencesPage } from "../pages/AbsencesPage";
import { QuarterPage } from "../pages/QuarterPage";
import { SettingsPage } from "../pages/SettingsPage";
import { SummaryPage } from "../pages/SummaryPage";
import { TeamPage } from "../pages/TeamPage";
import { WorkloadPage } from "../pages/WorkloadPage";

export type ViewId = "summary" | "team" | "quarter" | "absences" | "workload" | "analytics" | "settings";

export type AppRoute = {
  id: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
  component: () => JSX.Element;
};

export const routes: AppRoute[] = [
  { id: "summary", label: "Сводка", icon: LayoutDashboard, component: SummaryPage },
  { id: "team", label: "Команда", icon: Users, component: TeamPage },
  { id: "quarter", label: "Квартал", icon: CalendarDays, component: QuarterPage },
  { id: "absences", label: "Отсутствия", icon: Umbrella, component: AbsencesPage },
  { id: "workload", label: "Нагрузка", icon: Package, component: WorkloadPage },
  { id: "analytics", label: "Аналитика", icon: BarChart3, component: AnalyticsPage },
  { id: "settings", label: "Настройки", icon: Settings, component: SettingsPage }
];

