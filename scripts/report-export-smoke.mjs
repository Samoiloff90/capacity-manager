// Development-only check of the XLSX report export in a running release EXE (production CSP).
// Run: node --experimental-websocket scripts/report-export-smoke.mjs <local CDP port>
// Only the folder picker is replaced. The real native "Save as" dialog is driven through
// Windows UI Automation. Artificial data only; workbook contents are checked by Vitest in
// memory, here only existence, size and modification time of the saved files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 19324);
assert(Number.isInteger(port) && port >= 1024 && port < 65536);
assert.equal(process.platform, "win32", "UI Automation of the save dialog is Windows-only");
const root = join(tmpdir(), `capacity report smoke ${Date.now()}`);
const projectFolder = join(root, "Команда отчёта");
const reportFolder = join(root, "Отчёты команды");
await mkdir(projectFolder, { recursive: true });
await mkdir(reportFolder);

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((item) => item.type === "page" && item.url === "http://tauri.localhost/");
assert(page, "The production-asset Tauri window must be running");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((accept, reject) => { socket.onopen = accept; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = true) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function waitFor(expression, label = expression, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}`);
}
const buttonExpression = (text) => `Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
async function click(text) {
  await waitFor(`Boolean(${buttonExpression(text)}) && !${buttonExpression(text)}.matches(':disabled')`, `enabled button ${text}`);
  // Do not await: the export click opens a modal native dialog.
  await evaluate(`setTimeout(() => ${buttonExpression(text)}.click(), 0)`, false);
  await sleep(60);
}
async function input(selector, value) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.matches(':disabled')) throw new Error('Missing enabled input');
    el.focus();
    Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    el.blur();
  })()`);
  await sleep(60);
}
const text = () => evaluate("document.body.innerText");
const exportButton = () => evaluate(`(() => { const b = ${buttonExpression("Выгрузить отчёт")};
  return b ? { disabled: b.disabled, title: b.title, hint: b.parentElement.querySelector('.project-muted')?.textContent ?? '' } : null; })()`);

// Managed UI Automation sees the Common Item Dialog only as panes without patterns,
// so the dialog is driven with classic Win32 messages to its child controls.
const win32Dialog = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class SaveDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static IntPtr Child(IntPtr parent, int id, string cls) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (h, lp) => { var sb = new StringBuilder(64); GetClassNameW(h, sb, 64);
      if (GetDlgCtrlID(h) == id && (cls == null || sb.ToString() == cls)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr h) { var sb = new StringBuilder(2048); SendMessageW(h, 0x000D, (IntPtr)2048, sb); return sb.ToString(); }
}
'@
function Wait-Dialog([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $found = [SaveDlg]::FindWindowW('#32770', 'Сохранить отчёт')
    if ($found -ne [IntPtr]::Zero) { return $found }
    Start-Sleep -Milliseconds 200
  }
  throw 'Save dialog not found'
}
`;

/** Drives the native dialog titled "Сохранить отчёт". Returns the default file name it offered. */
function driveSaveDialog(action, path = "", confirmOverwrite = false) {
  const script = `${win32Dialog}
$ErrorActionPreference = 'Stop'
$dialog = Wait-Dialog 30
Start-Sleep -Milliseconds 400
$edit = [SaveDlg]::Child($dialog, 1001, 'Edit')
if ($edit -eq [IntPtr]::Zero) { throw 'File name box not found' }
[Console]::Out.WriteLine('DEFAULT:' + [SaveDlg]::Text($edit))
if ('${action}' -eq 'cancel') {
  [void][SaveDlg]::PostMessageW([SaveDlg]::Child($dialog, 2, 'Button'), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  exit 0
}
[void][SaveDlg]::SendMessageW($edit, 0x000C, [IntPtr]::Zero, '${path.replaceAll("'", "''")}')
Start-Sleep -Milliseconds 300
[void][SaveDlg]::PostMessageW([SaveDlg]::Child($dialog, 1, 'Button'), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
if ('${confirmOverwrite}' -eq 'true') {
  # The overwrite question is a task dialog popup owned by the save dialog.
  $deadline = (Get-Date).AddSeconds(10)
  $popup = [IntPtr]::Zero
  while ($popup -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $candidate = [SaveDlg]::GetWindow($dialog, 6)
    if ($candidate -ne [IntPtr]::Zero -and $candidate -ne $dialog) { $popup = $candidate }
  }
  if ($popup -eq [IntPtr]::Zero) { throw 'Overwrite confirmation not found' }
  # TDM_CLICK_BUTTON with IDYES; a classic message box has a real button with id 6 instead.
  [void][SaveDlg]::SendMessageW($popup, 0x0466, [IntPtr]6, [IntPtr]::Zero)
  $yes = [SaveDlg]::Child($popup, 6, 'Button')
  if ($yes -ne [IntPtr]::Zero) { [void][SaveDlg]::PostMessageW($yes, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
}
`;
  return runPowerShell(script).then((output) => /DEFAULT:(.*)/.exec(output)?.[1]?.trim() ?? "");
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { errors += chunk.toString("utf8"); });
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`PowerShell ${code}: ${errors || output}`)));
  });
}

/** Holds an exclusive handle so the rename fails like with a workbook open in Excel. */
function lockFile(path, seconds) {
  return runPowerShell(`
$stream = [System.IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'None')
[Console]::Out.WriteLine('LOCKED')
Start-Sleep -Seconds ${seconds}
$stream.Close()`);
}

async function reopenProject() {
  await click("Закрыть проект");
  if (await evaluate("Boolean(document.querySelector('[role=alertdialog]'))")) await click("Не сохранять");
  await waitFor("Boolean(document.querySelector('.project-welcome'))");
  await evaluate(`window.__smokeFolder = ${JSON.stringify(projectFolder)}`);
  await click("Открыть папку проекта");
  await waitFor("document.querySelector('.project-section-heading h2')?.textContent === '4 квартал 2026 года'");
}

async function replaceQuarter(update) {
  const rows = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
    db: window.__smokeSession.sessionKey, query: 'SELECT plan_id, payload_json, revision FROM quarter_plans', values: []
  })`);
  assert.equal(rows.length, 1);
  const snapshot = update(JSON.parse(rows[0].payload_json));
  const result = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|execute', {
    db: window.__smokeSession.sessionKey,
    query: 'UPDATE quarter_plans SET payload_json = $1, revision = revision + 1 WHERE plan_id = $2 AND revision = $3',
    values: [${JSON.stringify(JSON.stringify(snapshot))}, ${JSON.stringify(rows[0].plan_id)}, ${rows[0].revision}]
  })`);
  assert.equal(result[0], 1, "Exactly one quarter updated");
}

async function exportTo(path, { confirmOverwrite = false } = {}) {
  await evaluate("window.__lastNotice = null");
  await click("Выгрузить отчёт");
  return driveSaveDialog("save", path, confirmOverwrite);
}

const results = {};
try {
  await cdp("Runtime.enable");
  const openFolder = await evaluate("document.querySelector('.project-path')?.textContent ?? null");
  if (openFolder) {
    assert(openFolder.includes("capacity report smoke"), "Refuse to close a project that this smoke did not create");
    await click("Закрыть проект");
    if (await evaluate("Boolean(document.querySelector('[role=alertdialog]'))")) await click("Не сохранять");
  }
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "welcome screen");
  await evaluate(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (resource, options) => {
      const url = new URL(typeof resource === 'string' ? resource : resource.url);
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : null;
      if (command === 'plugin:dialog|open') return new Response(JSON.stringify(window.__smokeFolder ?? null), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' }
      });
      const response = await nativeFetch(resource, options);
      if ((command === 'project_create' || command === 'project_open') && response.headers.get('Tauri-Response') === 'ok') {
        window.__smokeSession = await response.clone().json();
      }
      return response;
    };
  })()`);
  await evaluate(`window.__smokeFolder = ${JSON.stringify(projectFolder)}`);
  await input(".project-welcome input", "Тестовая команда: отчёт/Q4");
  await click("Выбрать папку и создать");
  await input(".project-year input", "2026");
  await input(".project-period-bar form select", "4");
  await click("Создать квартал");
  await waitFor("document.querySelector('.project-section-heading h2')?.textContent === '4 квартал 2026 года'");

  // README scenario written as a saved quarter, then reopened like a real project.
  await replaceQuarter((snapshot) => ({
    ...snapshot,
    calendar: snapshot.calendar.map((day) => day.date === "2026-10-03" ? { ...day, isWorking: true } : day),
    members: [{ id: "m1", name: "Тестовый сотрудник", competencyId: snapshot.competencies[0].id, fte: "0.5" }],
    absences: [{ id: "a1", memberId: "m1", startDate: "2026-10-01", endDate: "2026-10-02" }],
    directions: [{ id: "d1", name: "Продукт", percent: "20" }, { id: "d2", name: "Встречи и прочее", percent: "80" }],
    tasks: [
      { id: "t1", name: "Задача 30", directionId: "d1", estimateHours: "30" },
      { id: "t2", name: "Задача 25", directionId: "d1", estimateHours: "25" }
    ]
  }));
  await reopenProject();
  await waitFor("document.querySelector('.project-summary-card strong')?.textContent === '252,00 ч'", "252 h");
  results.availableWhenSaved = await exportButton();
  assert.deepEqual(results.availableWhenSaved, { disabled: false, title: "Сохранить отчёт по сохранённому кварталу в файл Excel", hint: "" });

  await input('[aria-label="Ставка сотрудника 1"]', "0,75");
  results.whenDirty = await exportButton();
  assert.deepEqual(results.whenDirty, { disabled: true, title: "Сохраните квартал", hint: "Сохраните квартал" });
  await input('[aria-label="Ставка сотрудника 1"]', "0,5");
  await waitFor(`!${buttonExpression("Выгрузить отчёт")}.disabled`, "export enabled after reverting the draft");

  // 1. Cancel: nothing is written and no message appears.
  await click("Выгрузить отчёт");
  results.defaultName = await driveSaveDialog("cancel");
  assert.equal(results.defaultName, "Capacity Тестовая команда отчёт Q4 2026 Q4.xlsx");
  await waitFor(`!${buttonExpression("Выгрузить отчёт")}.disabled`, "export enabled after cancel");
  assert(!/Отчёт сохранён|Не удалось/.test(await text()), "Cancel shows no message");
  assert.deepEqual(await readdir(reportFolder), []);

  // 2. Save into a Cyrillic folder with spaces.
  const target = join(reportFolder, "Capacity отчёт Q4.xlsx");
  await exportTo(target);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(`Отчёт сохранён: ${target}`)})`, "saved notice");
  const first = await stat(target);
  assert(first.size > 1000);
  results.saved = { path: target, size: first.size };

  // 3. Overwrite after the OS confirmation.
  await sleep(1100);
  await exportTo(target, { confirmOverwrite: true });
  await waitFor(`document.body.innerText.includes(${JSON.stringify(`Отчёт сохранён: ${target}`)})`, "overwrite notice");
  const second = await stat(target);
  assert(second.mtimeMs > first.mtimeMs, "The file was replaced");
  results.overwritten = { size: second.size };

  // 4. Target held by another program: a Russian error, the old file stays, no temp file.
  const lock = lockFile(target, 12);
  await sleep(1500);
  await exportTo(target, { confirmOverwrite: true });
  await waitFor("document.body.innerText.includes('файл открыт в другой программе')", "locked-file error", 30000);
  await lock;
  const afterLock = await stat(target);
  assert.equal(afterLock.mtimeMs, second.mtimeMs, "The locked file was not changed");
  assert.deepEqual((await readdir(reportFolder)).filter((name) => name.startsWith(".capacity-export-")), []);
  results.locked = "error shown, file unchanged, no temp file";
  await click("Скрыть сообщение");

  // 5. A large plan: worksheet XML above fflate's 160 kB worker threshold, production CSP.
  await replaceQuarter((snapshot) => ({
    ...snapshot,
    tasks: Array.from({ length: 3000 }, (_, index) => ({
      id: `big-${index}`, name: `Задача с достаточно длинным названием номер ${index}`,
      directionId: index % 2 ? "d1" : "d2", estimateHours: String(index % 40)
    }))
  }));
  await reopenProject();
  const large = join(reportFolder, "Capacity большой отчёт.xlsx");
  const started = Date.now();
  await exportTo(large);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(`Отчёт сохранён: ${large}`)})`, "large report notice", 60000);
  results.large = { size: (await stat(large)).size, milliseconds: Date.now() - started };

  await click("Закрыть проект");
  console.log(JSON.stringify({ ok: true, root, results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, root, results, error: String(error?.stack ?? error) }, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}
