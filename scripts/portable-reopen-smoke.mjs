// Development-only check against an already RESTARTED, unpacked Windows EXE.
// Run: node --experimental-websocket scripts/portable-reopen-smoke.mjs <port> <workflow/result.json>
// Caller must stop the previous test EXE after its successful smoke closed project A,
// then restart the unpacked EXE with a fresh WebView profile, like a new recipient.
// This script never launches/kills processes, installs anything, or changes production files.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.argv.length, 4, "Expected <local CDP port> <successful workflow result.json>");
const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port >= 1024 && port < 65536, "Invalid CDP port");
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const target = join(workspace, "src-tauri", "target");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
async function checkedExisting(path) {
  const absolute = resolve(path);
  assert(inside(workspace, absolute), "Only paths inside this workspace are accepted");
  let cursor = workspace;
  for (const segment of relative(workspace, absolute).split(sep)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    assert(!info.isSymbolicLink(), "Symbolic links/junctions are not accepted in fixture paths");
  }
  const canonical = await realpath(absolute);
  assert.equal(relative(absolute, canonical), "", "Fixture path resolves through an unexpected redirect");
  return canonical;
}

await checkedExisting(target);
const resultPath = await checkedExisting(process.argv[3]);
assert.equal(basename(resultPath), "result.json", "Use the original smoke result.json");
const workflow = dirname(resultPath);
assert.equal(relative(target, dirname(workflow)), "", "The workflow must be directly inside src-tauri/target");
assert(/^workflow-smoke-\d+$/.test(basename(workflow)), "Not a generated workflow-smoke directory");
const resultInfo = await lstat(resultPath);
assert(resultInfo.isFile() && resultInfo.size <= 65536, "Unexpected result.json file");
const originalResultBytes = await readFile(resultPath);
const previous = JSON.parse(originalResultBytes.toString("utf8"));
assert.equal(previous.passed, true, "The source workflow must have passed");
assert.equal(previous.capacityHours, "252");
assert.equal(previous.productBudgetHours, "50.4");
assert.equal(previous.taskCount, 2);
assert.equal(previous.productDemandHours, "30");
assert.equal(previous.reserveDemandHours, "25");
assert(Number.isInteger(previous.revision) && previous.revision >= 1);
assert.equal(typeof previous.calendarVersion, "string");
assert.equal(typeof previous.folderA, "string");
assert(isAbsolute(previous.folderA), "The source project path must be absolute");
const source = await checkedExisting(previous.folderA);
assert.equal(relative(workflow, dirname(source)), "", "Source and result must belong to the same workflow");
assert.equal(basename(source), "Команда А", "Only synthetic project A is accepted");
assert((await lstat(source)).isDirectory());
// The current native fixture is a flat folder. Reject journals, WAL, links, and
// unexpected content rather than quietly making an incomplete or unsafe copy.
const sourceNames = (await readdir(source)).sort();
assert.deepEqual(sourceNames, [".capacity.lock", "capacity.sqlite"]);
const sourceFiles = [];
for (const name of sourceNames) {
  const path = await checkedExisting(join(source, name));
  const info = await lstat(path);
  assert(info.isFile() && info.size <= 134217728, "Unexpected fixture file");
  const bytes = await readFile(path);
  if (name === "capacity.sqlite") {
    assert.equal(bytes.subarray(0, 16).toString("binary"), "SQLite format 3\0");
    assert.equal(bytes[18], 1, "Copy requires DELETE journal mode");
    assert.equal(bytes[19], 1, "Copy requires DELETE journal mode");
  }
  sourceFiles.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
}

const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) });
assert(response.ok, "Local CDP endpoint failed");
const pages = (await response.json()).filter((item) => item.type === "page");
assert.equal(pages.length, 1, "Expected exactly one restarted test window");
assert.equal(pages[0].url, "http://tauri.localhost/", "Expected packaged local assets");
const debuggerUrl = new URL(pages[0].webSocketDebuggerUrl);
assert.equal(debuggerUrl.protocol, "ws:");
assert.equal(debuggerUrl.hostname, "127.0.0.1");
assert.equal(Number(debuggerUrl.port), port);
assert(!debuggerUrl.username && !debuggerUrl.password);
const socket = new WebSocket(debuggerUrl);
await new Promise((accept, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connection timeout")); }, 10000);
  socket.onopen = () => { clearTimeout(timer); accept(); };
  socket.onerror = (error) => { clearTimeout(timer); reject(error); };
});
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
socket.onclose = () => {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("CDP disconnected")); }
  pending.clear();
};
function cdp(method, params = {}) {
  return new Promise((accept, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: accept, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function waitFor(expression, label = expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((accept) => setTimeout(accept, 60));
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(text) {
  const button = `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.matches(':disabled'))`;
  await waitFor(`Boolean(${button})`, `enabled button ${text}`);
  await evaluate(`${button}.click()`);
}
async function expectDirection(name, expected) {
  await waitFor(`(() => {
    const row = Array.from(document.querySelectorAll('table.project-direction-summary tbody tr'))
      .find(row => row.cells[0]?.textContent.trim() === ${JSON.stringify(name)});
    if (!row) return false;
    const text = selector => row.querySelector(selector)?.textContent.trim();
    const actual = { budget: text('.project-direction-budget'),
      demandLabel: text('.project-direction-demand .project-balance-label'), demand: text('.project-direction-demand .project-balance-value'),
      balanceLabel: text('.project-direction-balance .project-balance-label'), balance: text('.project-direction-balance .project-balance-value') };
    return Object.entries(${JSON.stringify(expected)}).every(([key, value]) => actual[key] === value);
  })()`, `copied direction ${name}`);
}

let evidenceRoot;
let stubInstalled = false;
try {
  await cdp("Runtime.enable");
  assert.equal(await evaluate("document.querySelector('.project-path')?.textContent ?? null"), null, "Refuse an active project");
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "restarted EXE welcome screen");
  assert.equal(await evaluate("Boolean(window.__smokeSession || window.__smokeFolder || window.__portableReopenRestore)"), false,
    "Expected a fresh WebView context; stop the previous test EXE first");

  evidenceRoot = join(target, `portable-reopen-${randomUUID()}`);
  await mkdir(evidenceRoot); // Unique, non-recursive, no overwrite or cleanup of existing paths.
  const copy = join(evidenceRoot, "Копия команды");
  await mkdir(copy);
  for (const file of sourceFiles) {
    await copyFile(join(source, file.name), join(copy, file.name), constants.COPYFILE_EXCL);
    assert.equal(sha256(await readFile(join(copy, file.name))), file.sha256, `Copied bytes: ${file.name}`);
    assert.equal(sha256(await readFile(join(source, file.name))), file.sha256, `Source changed during copy: ${file.name}`);
  }
  assert.deepEqual((await readdir(source)).sort(), sourceNames, "Source folder changed during copy");
  assert.equal(sha256(await readFile(resultPath)), sha256(originalResultBytes), "The source result changed");

  // Only the folder picker is stubbed. Observe the real project_open response;
  // no native project/SQL command or calculation is substituted.
  await evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__portableReopenRestore = () => { window.fetch = originalFetch; delete window.__portableReopenRestore; };
    window.fetch = async (resource, options) => {
      const raw = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      const url = new URL(raw, location.href);
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : null;
      if (command === 'plugin:dialog|open') return new Response(${JSON.stringify(JSON.stringify(copy))}, {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' }
      });
      const result = await originalFetch.call(window, resource, options);
      if (command === 'project_open' && result.headers.get('Tauri-Response') === 'ok') {
        window.__portableReopenSession = await result.clone().json();
      }
      return result;
    };
  })()`);
  stubInstalled = true;
  await click("Открыть папку проекта");
  await waitFor("document.querySelector('.project-title h1')?.textContent === 'Переименованная команда' && Boolean(document.querySelector('.project-path'))", "copied project opened");
  const shownPath = await evaluate("document.querySelector('.project-path')?.textContent");
  assert.equal(relative(copy, shownPath), "", "The UI must open the new copy, not project A");
  // The selected-quarter preference belongs to the local WebView profile, not
  // SQLite. A recipient's fresh profile may initially select the latest plan.
  await waitFor(`(() => {
    const select = document.querySelector('.project-plan-select select');
    return select && !select.matches(':disabled') && Array.from(select.options)
      .some(option => option.textContent === '4 квартал 2026 года');
  })()`, "copied Q4 is available for explicit selection");
  const requestedPlanId = await evaluate(`(() => {
    const select = document.querySelector('.project-plan-select select');
    const option = Array.from(select.options).find(option => option.textContent === '4 квартал 2026 года');
    select.focus();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.blur();
    return option.value;
  })()`);
  await waitFor("document.querySelector('.project-summary-card strong')?.textContent === '252,00 ч'", "explicitly selected copied Q4 capacity");
  const selection = await evaluate(`(() => {
    const select = document.querySelector('.project-plan-select select');
    return { id: select.value, label: select.selectedOptions[0]?.textContent };
  })()`);
  assert.equal(selection.label, "4 квартал 2026 года", "The recipient can select the copied quarter");
  assert.equal(selection.id, requestedPlanId);
  assert(selection.id);
  await click("Команда");
  await waitFor("document.querySelector('[aria-label=\"Ставка сотрудника 1\"]')?.value === '0,5'");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Имя сотрудника 1\"]')?.value"), "Тестовый участник");
  await click("Задачи");
  await waitFor("document.querySelectorAll('[aria-label^=\"Название задачи \"]').length === 2");
  const displayedTasks = await evaluate(`Array.from(document.querySelectorAll('[aria-label^="Название задачи "]'), input => {
    const row = input.closest('tr'); const direction = row.querySelector('select');
    return { name: input.value, direction: direction.selectedOptions[0].textContent,
      estimate: row.querySelector('[aria-label^="Оценка задачи "]').value };
  })`);
  assert.deepEqual(displayedTasks, [
    { name: "Анализ продукта", direction: "Продукт", estimate: "30" },
    { name: "Реализация задачи", direction: "Встречи и резерв", estimate: "25" }
  ]);
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "30,00 ч", balanceLabel: "Остаток", balance: "20,40 ч" });
  await expectDirection("Встречи и резерв", { budget: "201,60 ч", demandLabel: "Потребность", demand: "25,00 ч", balanceLabel: "Остаток", balance: "176,60 ч" });

  const rows = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
    db: window.__portableReopenSession.sessionKey,
    query: 'SELECT plan_id, year, quarter, revision, payload_json FROM quarter_plans ORDER BY year, quarter', values: []
  })`);
  assert.deepEqual(rows.map(({ year, quarter }) => ({ year, quarter })), [
    { year: 2026, quarter: 1 }, { year: 2026, quarter: 4 }, { year: 2028, quarter: 1 }
  ]);
  const selected = rows.find((row) => row.plan_id === selection.id);
  assert(selected);
  assert.equal(selected.year, 2026);
  assert.equal(selected.quarter, 4);
  assert.equal(selected.revision, previous.revision);
  const snapshot = JSON.parse(selected.payload_json);
  assert.equal(snapshot.year, 2026);
  assert.equal(snapshot.quarter, 4);
  assert.equal(snapshot.members.length, 1);
  assert.equal(snapshot.members[0].fte, "0.5");
  assert.equal(snapshot.absences.length, 1);
  assert.equal(snapshot.absences[0].memberId, snapshot.members[0].id);
  assert.equal(snapshot.absences[0].startDate, "2026-10-01");
  assert.equal(snapshot.absences[0].endDate, "2026-10-02");
  assert.equal(snapshot.calendar.length, 92);
  assert.equal(snapshot.calendarSource.kind, "ru-official");
  assert.equal(snapshot.calendarSource.version, previous.calendarVersion);
  assert.equal(snapshot.calendar.find((day) => day.date === "2026-10-03")?.isWorking, true);
  assert(!snapshot.calendarSource.baseWorkingDates.includes("2026-10-03"));
  assert.deepEqual(snapshot.directions.map(({ name, percent }) => ({ name, percent })), [
    { name: "Продукт", percent: "20" }, { name: "Встречи и резерв", percent: "80" }
  ]);
  const directions = new Map(snapshot.directions.map((direction) => [direction.id, direction.name]));
  assert.deepEqual(snapshot.tasks.map((task) => ({ name: task.name, estimate: task.estimateHours, direction: directions.get(task.directionId) })), displayedTasks);
  assert.equal(new Set(snapshot.tasks.map((task) => task.id)).size, 2);
  for (const row of rows.filter((row) => row.plan_id !== selection.id)) {
    const other = JSON.parse(row.payload_json);
    assert.deepEqual(other.tasks, []);
    assert.deepEqual(other.members, []);
  }
  assert.equal(await evaluate("document.querySelector('.project-status')?.textContent"), "Все изменения сохранены");
  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "copied project closed");
  assert.equal(await evaluate("document.querySelector('.project-path')?.textContent ?? null"), null);
  for (const file of sourceFiles) {
    assert.equal(sha256(await readFile(join(source, file.name))), file.sha256, `Source remains unchanged: ${file.name}`);
  }
  const evidence = { passed: true, sourceResult: resultPath, sourceResultSha256: sha256(originalResultBytes),
    sourceFolder: source, copiedFolder: copy, copiedFiles: sourceFiles, sqliteBytesMatchedBeforeOpen: true,
    sourceUnchangedAfterClose: true, callerPreconditions: "Previous test EXE stopped after successful smoke; tested EXE relaunched from unpacked ZIP with a fresh WebView profile",
    restartProcessVerifiedBy: "caller; fresh renderer state and welcome checked here",
    freshWebViewProfile: true, freshWebViewProfileVerifiedBy: "caller-provided fresh user data folder; not inspected by this script",
    explicitQuarterSelection: true, selectedQuarterPreferenceScope: "local WebView profile; not transferred by the SQLite copy",
    folderPicker: "stubbed; native dialog interaction not verified", cleanOsOrRuntimeAbsenceTest: false,
    selectedPlanId: selection.id, revision: selected.revision, capacityHours: "252", productRemainingHours: "20.4",
    reserveRemainingHours: "176.6", snapshotSha256: sha256(Buffer.from(selected.payload_json, "utf8")),
    snapshot, closedToWelcome: true };
  await writeFile(join(evidenceRoot, "result.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ passed: true, artifacts: evidenceRoot }));
} catch (error) {
  if (evidenceRoot) await writeFile(join(evidenceRoot, "failure.txt"), String(error.stack ?? error), { flag: "wx" });
  console.error(error);
  process.exitCode = 1;
} finally {
  if (stubInstalled) await evaluate("window.__portableReopenRestore?.(); delete window.__portableReopenSession;").catch(() => {});
  socket.close();
}
