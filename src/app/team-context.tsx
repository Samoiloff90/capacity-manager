import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Team } from "../db/types";
import { teamService } from "../domain/team/team.service";

type TeamContextValue = {
  team: Team | null;
  isLoading: boolean;
  loadError: string;
  reloadTeam: () => Promise<void>;
  nameDraft: string;
  changeNameDraft: (name: string) => void;
  resetNameDraft: () => void;
  saveName: () => Promise<void>;
  isSaving: boolean;
  saveError: string;
  nameSaved: boolean;
};

const TeamContext = createContext<TeamContextValue | null>(null);

export function TeamProvider({ children }: { children: ReactNode }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const loadVersion = useRef(0);
  const saveInProgress = useRef(false);

  const reloadTeam = useCallback(async () => {
    const version = ++loadVersion.current;
    setIsLoading(true);
    setLoadError("");
    try {
      const loaded = await teamService.getTeam();
      if (version !== loadVersion.current) return;
      setTeam(loaded);
      setNameDraft(loaded.name);
    } catch {
      if (version === loadVersion.current) {
        setLoadError("Не удалось загрузить название команды. Попробуйте ещё раз.");
      }
    } finally {
      if (version === loadVersion.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadTeam();
    return () => { loadVersion.current += 1; };
  }, [reloadTeam]);

  function changeNameDraft(name: string) {
    setNameDraft(name);
    setNameSaved(false);
  }

  function resetNameDraft() {
    setNameDraft(team?.name ?? "");
    setSaveError("");
    setNameSaved(false);
  }

  async function saveName() {
    if (!team || saveInProgress.current) return;
    if (!nameDraft.trim()) {
      setSaveError("Укажите название команды");
      setNameSaved(false);
      return;
    }
    saveInProgress.current = true;
    setIsSaving(true);
    setSaveError("");
    setNameSaved(false);
    try {
      const saved = await teamService.renameTeam(team.id, nameDraft);
      setTeam(saved);
      setNameDraft(saved.name);
      setNameSaved(true);
    } catch {
      setSaveError("Не удалось сохранить название команды. Изменения остались в поле — попробуйте ещё раз.");
    } finally {
      saveInProgress.current = false;
      setIsSaving(false);
    }
  }

  return (
    <TeamContext.Provider value={{
      team, isLoading, loadError, reloadTeam, nameDraft, changeNameDraft,
      resetNameDraft, saveName, isSaving, saveError, nameSaved
    }}>
      {children}
    </TeamContext.Provider>
  );
}

export function useTeam() {
  const context = useContext(TeamContext);
  if (!context) throw new Error("Данные команды недоступны");
  return context;
}
