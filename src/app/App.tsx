import { useState } from "react";
import { AppHeader } from "../components/layout/AppHeader";
import { Sidebar } from "../components/layout/Sidebar";
import { routes, ViewId } from "./routes";
import { TeamProvider, useTeam } from "./team-context";
import "./team-name.css";

export default function App() {
  return <TeamProvider><AppWorkspace /></TeamProvider>;
}

function AppWorkspace() {
  const [activeView, setActiveView] = useState<ViewId>("summary");
  const { team, isLoading, loadError, reloadTeam } = useTeam();
  const currentRoute = routes.find((route) => route.id === activeView) ?? routes[0];
  const Page = currentRoute.component;

  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} onNavigate={setActiveView} routes={routes} />
      <main className="workspace">
        <AppHeader
          title={currentRoute.label}
          teamName={team?.name ?? null}
          isLoading={isLoading}
          error={loadError}
          onRetry={() => { void reloadTeam(); }}
        />
        <Page />
      </main>
    </div>
  );
}
