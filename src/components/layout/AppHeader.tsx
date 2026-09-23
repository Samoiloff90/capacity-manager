type AppHeaderProps = {
  title: string;
  teamName: string | null;
  isLoading: boolean;
  error: string;
  onRetry: () => void;
};

export function AppHeader({ title, teamName, isLoading, error, onRetry }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div>
        <span className="eyebrow">Раздел</span>
        <h1>{title}</h1>
      </div>
      <div className="header-meta team-header-name" aria-live="polite">
        {isLoading ? <span>Загрузка команды…</span> : error ? (
          <>
            <span role="alert">{error}</span>
            <button type="button" onClick={onRetry}>Повторить</button>
          </>
        ) : <span>{teamName}</span>}
      </div>
    </header>
  );
}
