import { AppRoute, ViewId } from "../../app/routes";

type SidebarProps = {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  routes: AppRoute[];
};

export function Sidebar({ activeView, onNavigate, routes }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          🐗
        </span>
        <span>Capacity Planner</span>
      </div>

      <nav className="sidebar-nav" aria-label="Основная навигация">
        {routes.map((route) => {
          const Icon = route.icon;
          return (
            <button
              key={route.id}
              className={activeView === route.id ? "active" : ""}
              type="button"
              onClick={() => onNavigate(route.id)}
            >
              <Icon size={18} />
              <span>{route.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">Q2 2026</div>
    </aside>
  );
}

