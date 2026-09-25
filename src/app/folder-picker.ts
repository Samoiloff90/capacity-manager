import { open } from "@tauri-apps/plugin-dialog";

/** Shows the system folder dialog; null when the user cancels. */
export async function pickProjectFolder(title: string): Promise<string | null> {
  const folder = await open({ directory: true, multiple: false, title });
  return typeof folder === "string" ? folder : null;
}
