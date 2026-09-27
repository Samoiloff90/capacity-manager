import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProjectWorkspaceController } from "./project-workspace-controller";

const Context = createContext<ProjectWorkspaceController | null>(null);
const preferenceKey = (projectId: string) => `capacity-manager:selected-plan:${projectId}`;

export function ProjectWorkspaceProvider({ children }: PropsWithChildren) {
  const [controller] = useState(() => {
    const store = new ProjectWorkspaceController({
      readSelectedPlan: (projectId) => localStorage.getItem(preferenceKey(projectId)),
      writeSelectedPlan: (projectId, planId) => localStorage.setItem(preferenceKey(projectId), planId)
    });
    if (isTauri()) store.actions.setCloseProtectionReady(false);
    return store;
  });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let closing = false;
    const window = getCurrentWindow();
    void window.onCloseRequested(async (event) => {
      event.preventDefault();
      if (disposed || closing) return;
      closing = true;
      try {
        if (await controller.actions.closeProject()) await window.destroy();
      } catch {
        controller.actions.reportError("Не удалось закрыть окно. Попробуйте ещё раз.");
      } finally { closing = false; }
    }).then((stop) => {
      if (disposed) stop();
      else { unlisten = stop; controller.actions.setCloseProtectionReady(true); }
    }).catch(() => {
      if (!disposed) {
        controller.actions.setCloseProtectionReady(false);
        controller.actions.reportError("Не удалось подключить защиту несохранённых изменений. Работа с проектами недоступна; перезапустите приложение.");
      }
    });
    return () => { disposed = true; unlisten?.(); };
  }, [controller]);
  useEffect(() => {
    if (!isTauri()) return;
    // Reloading the page would drop the draft without the unsaved-changes dialog while the
    // native session keeps the project locked, so browser reload shortcuts are disabled.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.code === "KeyR")) event.preventDefault();
    };
    // The page menu offers "Reload", also over selects, checkboxes and date fields.
    // Only text fields keep their menu for cut, copy and paste.
    const onMenu = (event: MouseEvent) => {
      const editable = event.target instanceof Element
        && event.target.closest("input:not([type]), input[type='text'], input[type='search'], textarea, [contenteditable='true']");
      if (!editable) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onMenu);
    };
  }, []);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function useProjectWorkspace() {
  const controller = useContext(Context);
  if (!controller) throw new Error("Контекст проекта недоступен.");
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { state, actions: controller.actions };
}
