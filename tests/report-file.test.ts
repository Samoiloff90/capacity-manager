import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { MAX_REPORT_BYTES, saveReportFile } from "../src/export/report-file";

const ipc = vi.fn<(command: string, args?: InvokeArgs) => Promise<unknown>>();
const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

beforeEach(() => {
  ipc.mockReset();
  vi.stubGlobal("window", { crypto: webcrypto });
  mockIPC((command, args) => ipc(command, args));
});
afterEach(() => { clearMocks(); vi.unstubAllGlobals(); });

describe("native report save client", () => {
  it("sends the default name and the bytes to the narrow native command", async () => {
    ipc.mockResolvedValueOnce({ status: "saved", path: "D:\\Отчёты команды\\Capacity Команда А 2026 Q4.xlsx" });
    await expect(saveReportFile("Capacity Команда А 2026 Q4", zipHeader)).resolves.toEqual({
      status: "saved", path: "D:\\Отчёты команды\\Capacity Команда А 2026 Q4.xlsx"
    });
    expect(ipc.mock.calls).toEqual([["report_save_xlsx", { defaultName: "Capacity Команда А 2026 Q4", bytes: [80, 75, 3, 4] }]]);
  });

  it("reports a cancelled dialog as an outcome, not an error", async () => {
    ipc.mockResolvedValueOnce({ status: "cancelled" });
    await expect(saveReportFile("Capacity 2026 Q4", zipHeader)).resolves.toEqual({ status: "cancelled" });
  });

  it.each([
    [{ status: "saved" }], [{ status: "saved", path: "" }], [{ status: "done" }], ["cancelled"], [null],
    [{ status: "cancelled", path: "x" }]
  ])("rejects an unexpected response %j in Russian", async (response) => {
    ipc.mockResolvedValueOnce(response);
    await expect(saveReportFile("Capacity 2026 Q4", zipHeader)).rejects.toThrow("Неожиданный ответ приложения при сохранении отчёта.");
  });

  it("passes the native error text through", async () => {
    ipc.mockRejectedValueOnce("Не удалось сохранить отчёт: файл открыт в другой программе, например в Excel. Закройте его и повторите.");
    await expect(saveReportFile("Capacity 2026 Q4", zipHeader)).rejects.toBe(
      "Не удалось сохранить отчёт: файл открыт в другой программе, например в Excel. Закройте его и повторите."
    );
  });

  it("refuses empty and oversized reports before calling the native side", async () => {
    await expect(saveReportFile("Capacity 2026 Q4", new Uint8Array())).rejects.toThrow("слишком большой");
    await expect(saveReportFile("Capacity 2026 Q4", new Uint8Array(MAX_REPORT_BYTES + 1))).rejects.toThrow("слишком большой");
    expect(ipc).not.toHaveBeenCalled();
  });
});
