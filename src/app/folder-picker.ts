import { invoke } from "@tauri-apps/api/core";

/** «open» — a project folder, «create» — an empty folder for a new team. */
export type FolderPurpose = "open" | "create";

/**
 * The system folder dialog, shown by the native side. Only the folder the user chooses
 * there may be opened or created next, once (Q-001). Null when the user cancels.
 */
export async function pickProjectFolder(purpose: FolderPurpose): Promise<string | null> {
  const folder = await invoke<string | null>("project_pick_folder", { purpose });
  return typeof folder === "string" ? folder : null;
}
