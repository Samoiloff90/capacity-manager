import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/** Same limit as the native command; a typical report is about 20 KB. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export type ReportSaveOutcome = { status: "saved"; path: string } | { status: "cancelled" };

const outcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), path: z.string().min(1) }).strict(),
  z.object({ status: z.literal("cancelled") }).strict()
]);

/**
 * Hands the finished workbook to the native command, which itself shows "Save as"
 * and writes the file. The frontend gets no file-system or save-dialog permission.
 */
export async function saveReportFile(defaultName: string, bytes: Uint8Array): Promise<ReportSaveOutcome> {
  if (bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) {
    throw new Error("Отчёт пустой или слишком большой для выгрузки.");
  }
  const response = await invoke("report_save_xlsx", { defaultName, bytes: Array.from(bytes) });
  const parsed = outcomeSchema.safeParse(response);
  if (!parsed.success) throw new Error("Неожиданный ответ приложения при сохранении отчёта.");
  return parsed.data;
}
