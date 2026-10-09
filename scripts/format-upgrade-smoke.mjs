// Development-only check of the project format upgrade (DEC-044) against running Windows EXEs.
// The caller starts each EXE with a fresh WebView2 profile and --remote-debugging-port=<port>
// (WEBVIEW2_USER_DATA_FOLDER, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), and stops it afterwards.
//   node --experimental-websocket scripts/format-upgrade-smoke.mjs upgrade <port> <src-tauri/target/workflow-smoke-N>
//     new build: a copy of synthetic project A opens unchanged, the first save asks, Cancel writes
//     nothing, Confirm makes a byte-identical backup, writes format 2 and the edit survives reopening.
//   node --experimental-websocket scripts/format-upgrade-smoke.mjs legacy <port> <format-upgrade-*/result.json>
//     0.3.0 build: refuses the upgraded copy without changing it and opens the restored backup.
// Only synthetic smoke projects inside src-tauri/target are copied and opened; their sources are never written.
// The new build shows the planner (stages 3–4): numbers come from «Источники и доли» and the
// estimate is edited from the work's menu. The 0.3.0 build keeps its own tabs.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inFolderDialog } from "./native-folder-dialog.mjs";

const [mode, portText, input] = process.argv.slice(2);
assert(["upgrade", "legacy"].includes(mode) && portText && input, "Expected: upgrade|legacy <local CDP port> <path>");
const planner = mode === "upgrade";
const port = Number(portText);
assert(Number.isInteger(port) && port >= 1024 && port < 65536, "Invalid CDP port");
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const target = join(workspace, "src-tauri", "target");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = async (path) => sha256(await readFile(path));
const inside = (parent, child) => { const path = relative(parent, child); return path !== "" && !path.startsWith("..") && !isAbsolute(path); };
/** user_version in the SQLite header: 1 for projects of 0.1.0–0.3.0, 2 after the upgrade. */
const fileFormat = async (path) => (await readFile(path)).readUInt32BE(60);

const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json())
  .filter((item) => item.type === "page");
assert.equal(pages.length, 1, "Expected exactly one test window");
assert.equal(pages[0].url, "http://tauri.localhost/", "Expected packaged local assets");
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((accept, reject) => { socket.onopen = accept; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
};
const cdp = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: accept, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function waitFor(expression, label = expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((accept) => setTimeout(accept, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(text, scope = "document") {
  const button = `Array.from(${scope}.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.matches(':disabled'))`;
  await waitFor(`Boolean(${button})`, `enabled button ${text}`);
  await evaluate(`${button}.click()`);
}
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
const status = () => text(".project-status");

/** Only the folder picker is replaced; project_open, SQL and the calculation are real. */
async function pickFolder(folder) {
  await evaluate(`(() => {
    window.__formatRestore?.();
    const originalFetch = window.fetch;
    window.__formatRestore = () => { window.fetch = originalFetch; delete window.__formatRestore; };
    window.fetch = async (resource, options) => {
      const raw = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      const url = new URL(raw, location.href);
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : null;
      if (command === 'plugin:dialog|open' && ${JSON.stringify(folder)} !== null) return new Response(${JSON.stringify(JSON.stringify(folder))}, {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' }
      });
      const result = await originalFetch.call(window, resource, options);
      if (command === 'project_open' && result.headers.get('Tauri-Response') === 'ok') window.__formatSession = await result.clone().json();
      return result;
    };
  })()`);
}
async function openProject(folder) {
  if (planner) {
    // The new build (Q-001): only the folder chosen in its native dialog opens.
    await pickFolder(null);
    const choosing = inFolderDialog("open", folder);
    await click("Открыть папку проекта");
    await choosing;
  } else {
    await pickFolder(folder);
    await click("Открыть папку проекта");
  }
  await waitFor(`document.querySelector('.project-path')?.textContent === ${JSON.stringify(folder)}`, `opened ${folder}`);
}
async function selectQ4() {
  await waitFor(`(() => { const s = document.querySelector('.project-plan-select select');
    return s && !s.matches(':disabled') && Array.from(s.options).some(o => o.textContent === '4 квартал 2026 года'); })()`, "Q4 2026 available");
  await evaluate(`(() => {
    const select = document.querySelector('.project-plan-select select');
    const option = Array.from(select.options).find(o => o.textContent === '4 квартал 2026 года');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (planner) {
    await waitFor("document.querySelector('.project-totals-plan .project-total strong')?.textContent === '252 ч'", "Q4 capacity 252 ч");
    await click("Источники и доли");
  } else {
    await waitFor("document.querySelector('.project-total-available strong')?.textContent === '252 ч'", "Q4 capacity 252 ч");
    await click("Задачи");
  }
}
/** Quota, works in the plan and the rest; the 0.3.0 build names them budget, demand and balance. */
async function direction(name) {
  if (planner) {
    return evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('table.pp-sources tbody tr'))
        .find(r => r.querySelector('input[aria-label="Название источника"]')?.value === ${JSON.stringify(name)});
      const value = (index) => {
        const cell = row?.cells[index]?.cloneNode(true);
        cell?.querySelectorAll('.pp-saved').forEach((marker) => marker.remove());
        return cell ? cell.textContent.replace(/\u00a0/g, ' ').trim() : null;
      };
      return { budget: value(3), demand: value(4), balance: value(5) };
    })()`);
  }
  return evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('table.project-direction-summary tbody tr')).find(r => r.cells[0]?.textContent.trim() === ${JSON.stringify(name)});
    const value = (selector) => row?.querySelector(selector)?.textContent.trim() ?? null;
    return { budget: value('.project-direction-budget'), demand: value('.project-direction-demand .project-balance-value'),
      balance: value('.project-direction-balance .project-balance-value') };
  })()`);
}
async function expectNumbers(product, reserve) {
  await waitFor(planner ? "Boolean(document.querySelector('table.pp-sources tbody tr'))"
    : "Boolean(document.querySelector('table.project-direction-summary tbody tr'))", "balance table");
  assert.deepEqual(await direction("Продукт"), product);
  assert.deepEqual(await direction("Встречи и резерв"), reserve);
}
/** The new build: «План квартала» → «Продукт» → the work's menu «Изменить…» → a new estimate. */
async function editEstimate(work, estimate) {
  await click("План квартала");
  await waitFor("Array.from(document.querySelectorAll('.pp-overview .pp-name')).some(b => b.textContent === 'Продукт')", "plan overview");
  await evaluate("Array.from(document.querySelectorAll('.pp-overview .pp-name')).find(b => b.textContent === 'Продукт').click()");
  const row = `Array.from(document.querySelectorAll('.pp-row')).find(r => r.querySelector('.pp-wname')?.firstChild?.textContent === ${JSON.stringify(work)})`;
  await waitFor(`Boolean(${row})`, `work ${work}`);
  await evaluate(`${row}.querySelector('[data-menu-for]').click()`);
  await click("Изменить…");
  await waitFor("Boolean(document.querySelector('#edit-estimate'))", "edit form");
  await evaluate(`(() => {
    const input = document.querySelector('#edit-estimate');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(estimate)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Сохранить изменения");
  await waitFor("!document.querySelector('#edit-estimate')", "edit saved");
  await click("Источники и доли");
}
async function closeProject() {
  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "closed to the welcome screen");
}
async function quarterRows() {
  const rows = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', { db: window.__formatSession.sessionKey,
    query: 'SELECT year, quarter, revision, payload_version, payload_json FROM quarter_plans ORDER BY year, quarter', values: [] })`);
  return rows.map(({ year, quarter, revision, payload_version, payload_json }) => ({ period: `${year}-${quarter}`, revision, payload_version, payload: JSON.parse(payload_json) }));
}
const product0 = { budget: "50,40 ч", demand: "30 ч", balance: "20,40 ч" };
const reserve0 = { budget: "201,60 ч", demand: "25 ч", balance: "176,60 ч" };

let root;
try {
  await cdp("Runtime.enable");
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "fresh EXE on the welcome screen");
  if (mode === "upgrade") {
    const workflow = await realpath(resolve(input));
    assert.equal(dirname(workflow), target, "The workflow must be directly inside src-tauri/target");
    assert(/^workflow-smoke-\d+$/.test(basename(workflow)), "Not a generated workflow-smoke directory");
    const previous = JSON.parse(await readFile(join(workflow, "result.json"), "utf8"));
    assert.equal(previous.passed, true);
    const source = join(workflow, "Команда А");
    const original = await readFile(join(source, "capacity.sqlite"));
    assert.equal(original.readUInt32BE(60), 1, "The source is a project of format 1");
    root = join(target, `format-upgrade-${Date.now()}`);
    await mkdir(root);
    const copy = join(root, "Команда А");
    await mkdir(copy);
    const database = join(copy, "capacity.sqlite");
    await copyFile(join(source, "capacity.sqlite"), database, constants.COPYFILE_EXCL);
    const originalSha = sha256(original);
    assert.equal(await fileSha(database), originalSha);

    // 1. Open and close: the file stays byte-identical, the numbers are those of 0.3.0.
    await openProject(copy);
    const teamName = await text(".project-title h1");
    await selectQ4();
    await expectNumbers(product0, reserve0);
    const before = await quarterRows();
    assert(before.every((row) => row.payload_version === 1), "Old quarters stay format 1 in the file");
    await closeProject();
    assert.equal(await fileSha(database), originalSha, "Opening and closing changed the file");
    assert.deepEqual((await readdir(copy)).filter((name) => name.startsWith("capacity-backup")), []);

    // 2. An edit and the first save: the question, then Cancel writes nothing.
    await openProject(copy);
    await selectQ4();
    await editEstimate("Анализ продукта", "28");
    await waitFor("document.querySelector('.project-status')?.textContent === 'Есть несохранённые изменения'", "dirty after the edit");
    await click("Сохранить квартал");
    await waitFor("document.querySelector('#format-upgrade-title')?.textContent === 'Обновить формат проекта'", "format question");
    const question = await text("#format-upgrade-message");
    assert(question.includes("После обновления формата этот файл нельзя будет открыть в версии 0.3.0. Перед сохранением будет создана резервная копия исходного проекта."), question);
    assert(question.includes(copy), `The question names the project folder: ${question}`);
    assert.equal(await status(), "Ожидает решения");
    await click("Отмена", "document.querySelector('[role=alertdialog]')");
    await waitFor("!document.querySelector('#format-upgrade-title')", "question closed");
    assert.equal(await status(), "Есть несохранённые изменения");
    assert.equal(await fileSha(database), originalSha, "Cancel changed the file");
    assert.deepEqual((await readdir(copy)).filter((name) => name.startsWith("capacity-backup")), []);

    // 3. Confirm: a byte-identical backup first, then format 2 and the save.
    await click("Сохранить квартал");
    await waitFor("Boolean(document.querySelector('#format-upgrade-title'))", "format question again");
    await click("Обновить формат и сохранить");
    await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'", "saved after the upgrade");
    const notice = await evaluate("Array.from(document.querySelectorAll('.project-message[role=status]'), m => m.textContent.trim()).join(' | ')");
    const match = /Резервная копия исходного проекта: (.+?\.sqlite)\./.exec(notice);
    assert(match, `The notice names the backup: ${notice}`);
    const backupPath = match[1];
    assert.equal(dirname(backupPath), copy, "The backup is in the project folder");
    assert.match(basename(backupPath), /^capacity-backup-format1-\d{4}-\d{2}-\d{2}\.sqlite$/);
    assert.equal(await fileSha(backupPath), originalSha, "The backup is the original file");
    assert.equal(await fileFormat(database), 2);
    const after = await quarterRows();
    const q4 = after.find((row) => row.period === "2026-4");
    assert.equal(q4.payload_version, 2);
    assert.equal(q4.revision, before.find((row) => row.period === "2026-4").revision + 1);
    assert(q4.payload.tasks.every((task) => task.mark === "plan" && task.link === null && task.comment === null));
    assert(q4.payload.directions.every((item) => item.kind === "work"), "No direction became a reserve");
    assert.deepEqual(after.filter((row) => row.period !== "2026-4").map((row) => [row.period, row.payload_version, row.revision]),
      before.filter((row) => row.period !== "2026-4").map((row) => [row.period, 1, row.revision]), "Other quarters are not rewritten");
    await expectNumbers({ budget: "50,40 ч", demand: "28 ч", balance: "22,40 ч" }, reserve0);
    await closeProject();
    const upgradedSha = await fileSha(database);

    // 4. Reopen: the edit is there; a later save asks nothing.
    await openProject(copy);
    await selectQ4();
    await expectNumbers({ budget: "50,40 ч", demand: "28 ч", balance: "22,40 ч" }, reserve0);
    await closeProject();
    assert.equal(await fileSha(database), upgradedSha, "Reopening changed the upgraded file");
    assert.equal(await fileSha(backupPath), originalSha, "The backup stays as it was");

    const evidence = { passed: true, mode, sourceWorkflow: workflow, sourceCreatedAt: new Date(Number(basename(workflow).slice(15))).toISOString(),
      teamName, copy, database, backupPath, originalSha, upgradedSha, openCloseUnchanged: true, cancelWritesNothing: true,
      backupMatchesOriginal: true, formatAfter: 2, otherQuarters: "format 1, not rewritten", folderPicker: "stubbed; native dialog not exercised" };
    await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ passed: true, artifacts: root }));
  } else {
    const resultPath = await realpath(resolve(input));
    root = dirname(resultPath);
    assert(inside(target, root) && /^format-upgrade-\d+$/.test(basename(root)), "Use a format-upgrade result.json");
    const upgraded = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(upgraded.passed, true);
    assert.equal(await fileSha(upgraded.database), upgraded.upgradedSha);

    // 0.3.0 refuses the upgraded project and leaves it as it is.
    await pickFolder(upgraded.copy);
    await click("Открыть папку проекта");
    await waitFor("Boolean(document.querySelector('.project-message.error'))", "0.3.0 error message");
    const refusal = await text(".project-message.error p");
    assert(refusal.includes("Версия проекта не поддерживается"), refusal);
    assert.equal(await evaluate("document.querySelector('.project-path')?.textContent ?? null"), null);
    assert.equal(await fileSha(upgraded.database), upgraded.upgradedSha, "0.3.0 changed the upgraded file");

    // The documented restore: the backup becomes capacity.sqlite; 0.3.0 opens it with the old numbers.
    const restored = join(root, "Восстановленная команда");
    await mkdir(restored);
    await copyFile(upgraded.backupPath, join(restored, "capacity.sqlite"), constants.COPYFILE_EXCL);
    assert.equal(await fileSha(join(restored, "capacity.sqlite")), upgraded.originalSha);
    await click("Скрыть сообщение");
    await openProject(restored);
    await selectQ4();
    await expectNumbers(product0, reserve0);
    await closeProject();
    const evidence = { passed: true, mode, refusal, upgradedUnchanged: true, restored, restoredOpensWithOldNumbers: true };
    await writeFile(join(root, "legacy-result.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
    console.log(JSON.stringify(evidence));
  }
} catch (error) {
  if (root) await writeFile(join(root, `${mode}-failure.txt`), String(error.stack ?? error)).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await evaluate("window.__formatRestore?.()").catch(() => {});
  socket.close();
}
