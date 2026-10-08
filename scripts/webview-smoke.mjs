// Development-only end-to-end check of a running Tauri WebView2.
// Run: node --experimental-websocket scripts/webview-smoke.mjs [local CDP port]
// Only the OS folder picker is replaced. Every project and SQL call is real.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const port = Number(process.argv[2] ?? 19323);
const emulateOffline = process.env.CAPACITY_SMOKE_OFFLINE === "1";
// Network check (scripts/network-check-windows.ps1): unique strings appended to names the
// script never compares, so they can be searched for in everything sent over the network.
const marker = (process.env.CAPACITY_SMOKE_MARKER ?? "").trim();
const marked = (text) => marker ? `${text} ${marker}` : text;
assert(Number.isInteger(port) && port >= 1024 && port < 65536);
const root = resolve("src-tauri/target", `workflow-smoke-${Date.now()}`);
const folderA = resolve(root, "Команда А");
const folderB = resolve(root, "Команда Б");
await mkdir(folderA, { recursive: true });
await mkdir(folderB);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((item) => item.type === "page" && item.url === "http://tauri.localhost/");
assert(page, "The production-asset Tauri window must be running");
assert.equal(new URL(page.webSocketDebuggerUrl).hostname, "127.0.0.1");
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  let result;
  try { result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); }
  catch (error) { throw new Error(`${error.message}: ${expression.slice(0, 180)}`); }
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function waitFor(expression, label = expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(60);
  }
  throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}`);
}
async function click(text) {
  const expression = `Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.matches(':disabled'))`;
  await waitFor(`Boolean(${expression})`, `enabled button ${text}`);
  await evaluate(`${expression}.click()`);
  await sleep(40);
}
async function clickSelector(selector) {
  const expression = `document.querySelector(${JSON.stringify(selector)})`;
  await waitFor(`Boolean(${expression}) && !${expression}.matches(':disabled')`, `enabled control ${selector}`);
  await evaluate(`${expression}.click()`);
  await sleep(40);
}
async function input(selector, value) {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`, `enabled input ${selector}`);
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.matches(':disabled')) throw new Error('Missing enabled input');
    el.focus();
    Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
  await sleep(40);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).blur()`);
  await sleep(40);
}
const aria = (name) => `[aria-label="${name}"]`;
async function selectOption(selector, label) {
  const value = await evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)})?.options ?? [])
    .find(option => option.textContent === ${JSON.stringify(label)})?.value`);
  assert.equal(typeof value, "string", `Select option ${label}`);
  await input(selector, value);
  return value;
}
/** Works of the open source, in screen order: name, estimate as shown and the group. */
async function workRows() {
  return evaluate(`Array.from(document.querySelectorAll('.pp-row'), row => ({
    name: row.querySelector('.pp-wname').firstChild.textContent,
    estimate: row.querySelector('.pp-est').textContent.replace(/\\u00a0/g, ' ').trim(),
    mark: row.classList.contains('cand') ? 'candidate' : 'plan'
  }))`);
}
/** One row of «Источники и доли»: quota, works in the plan and the rest, without «сохранено» markers. */
async function expectSource(name, expected) {
  const expression = `(() => {
    const row = Array.from(document.querySelectorAll('table.pp-sources tbody tr'))
      .find(row => row.querySelector('input[aria-label="Название источника"]')?.value === ${JSON.stringify(name)});
    if (!row) return false;
    const value = index => { const cell = row.cells[index].cloneNode(true); cell.querySelectorAll('.pp-saved').forEach(m => m.remove());
      return cell.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim(); };
    const actual = { quota: value(3), planned: value(4), rest: value(5) };
    return Object.entries(${JSON.stringify(expected)}).every(([key, value]) => actual[key] === value);
  })()`;
  await waitFor(expression, `source ${name}: ${JSON.stringify(expected)}`);
}
async function addSource(name, share) {
  await click("Добавить источник");
  await waitFor("document.activeElement?.getAttribute('aria-label') === 'Название источника'", "new source name in focus");
  const id = await evaluate("document.activeElement.id");
  await input(`#${id}`, name);
  await input(`#${id.replace("src-name-", "src-share-")}`, share);
  return id.replace("src-name-", "");
}
async function openSource(name) {
  await click("План квартала");
  if (await evaluate("Boolean(document.querySelector('#crumb-back'))")) await clickSelector("#crumb-back");
  const button = `Array.from(document.querySelectorAll('.pp-overview .pp-name')).find(b => b.textContent === ${JSON.stringify(name)})`;
  await waitFor(`Boolean(${button})`, `source ${name} in the plan`);
  await evaluate(`${button}.click()`);
  await waitFor(`document.querySelector('#source-title')?.textContent === ${JSON.stringify(name)}`, `workspace of ${name}`);
}
/** The add form of the open source; mark "plan" adds straight to the quarter plan. */
async function addWork(name, estimate, mark = "plan") {
  if (!await evaluate("Boolean(document.querySelector('#add-name'))")) await clickSelector("#btn-add");
  await input("#add-name", name);
  await input("#add-estimate", estimate);
  await clickSelector(`input[name="add-mark"][value="${mark}"]`);
  await clickSelector("#add-submit");
  await waitFor(`Array.from(document.querySelectorAll('.pp-row .pp-wname')).some(n => n.firstChild.textContent === ${JSON.stringify(name)})`, `work ${name} added`);
}
const workRow = (name) => `Array.from(document.querySelectorAll('.pp-row')).find(r => r.querySelector('.pp-wname').firstChild.textContent === ${JSON.stringify(name)})`;
async function workMenu(name, item) {
  await waitFor(`Boolean(${workRow(name)})`, `work ${name}`);
  await evaluate(`${workRow(name)}.querySelector('[data-menu-for]').click()`);
  const button = `Array.from(document.querySelectorAll('.pp-menu button')).find(b => b.textContent === ${JSON.stringify(item)})`;
  await waitFor(`Boolean(${button})`, `menu item ${item}`);
  await evaluate(`${button}.click()`);
  await sleep(40);
}
async function editWork(name, changes) {
  await workMenu(name, "Изменить…");
  await waitFor("Boolean(document.querySelector('#edit-name'))", "edit form");
  if (changes.name !== undefined) await input("#edit-name", changes.name);
  if (changes.estimate !== undefined) await input("#edit-estimate", changes.estimate);
  await clickSelector("#edit-submit");
  await waitFor("!document.querySelector('#edit-name')", "edit saved");
}
/** Rest of the open source as shown in its header. */
const sourceHead = () => evaluate("Array.from(document.querySelectorAll('.pp-head .pp-num strong'), s => s.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim())");
async function readQuarter(planId) {
  const rows = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
    db: window.__smokeSession.sessionKey,
    query: 'SELECT payload_json, revision FROM quarter_plans WHERE plan_id = $1', values: [${JSON.stringify(planId)}]
  })`);
  assert.equal(rows.length, 1, "Exactly one saved quarter");
  return { snapshot: JSON.parse(rows[0].payload_json), revision: rows[0].revision };
}
async function pressKey(key, code, keyCode, modifiers = 0) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  }
  await sleep(60);
}
async function saveQuarter() {
  await click("Сохранить квартал");
  await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'");
}
async function capturePage(filename) {
  const metrics = await cdp("Page.getLayoutMetrics");
  const size = metrics.cssContentSize ?? metrics.contentSize;
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
  await writeFile(resolve(root, filename), Buffer.from(screenshot.data, "base64"));
}
async function folder(value) { await evaluate(`window.__smokeFolder = ${JSON.stringify(value)}`); }
async function expectHours(text) {
  await waitFor(`document.querySelector('.project-totals-plan .project-total strong')?.textContent.replace(/\\u00a0/g, ' ') === ${JSON.stringify(text)}`, `capacity ${text}`);
}
async function expectActiveQuarter(title) {
  await waitFor(`document.querySelector('.project-plan-select select')?.selectedOptions[0]?.textContent === ${JSON.stringify(title)}`, `active ${title}`);
}
/** copyFrom: the visible name of the source quarter, or "Не копировать". */
async function openNewQuarter(year, quarter, copyFrom) {
  await click("Новый квартал…");
  await input(".project-new-quarter .project-year input", String(year));
  await input(".project-new-quarter select", String(quarter));
  if (copyFrom === undefined) return;
  // Without saved quarters there is nothing to copy and the list stays disabled.
  if (await evaluate("document.querySelector('.project-new-quarter .project-copy-source').disabled")) assert.equal(copyFrom, "Не копировать");
  else await selectOption(".project-new-quarter .project-copy-source", copyFrom);
}
async function createQuarter(quarter, year = 2026, copyFrom = "Не копировать") {
  await openNewQuarter(year, quarter, copyFrom);
  await click("Создать квартал");
  await expectActiveQuarter(`${quarter} квартал ${year} года`);
}

try {
  await cdp("Runtime.enable");
  const activeFolder = await evaluate("document.querySelector('.project-path')?.textContent ?? null");
  if (activeFolder) {
    assert(activeFolder.includes("\\src-tauri\\target\\workflow-smoke-"), "Refuse to close a non-smoke project");
    await click("Закрыть проект");
    if (await evaluate("Boolean(document.querySelector('[role=alertdialog]'))")) await click("Не сохранять");
  }
  await waitFor("document.querySelector('.project-welcome') !== null");
  if (emulateOffline) {
    await cdp("Network.enable");
    await cdp("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    assert.equal(await evaluate("navigator.onLine"), false);
  }
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
  // Cancelling the folder picker must be harmless.
  await folder(null);
  await click("Открыть папку проекта");
  assert(await evaluate("Boolean(document.querySelector('.project-welcome'))"));
  await folder(folderA);
  await input(".project-welcome input", marked("Тестовая команда А"));
  await click("Выбрать папку и создать");
  await createQuarter(4);
  await expectHours("0 ч");
  await click("Добавить сотрудника");
  await input(aria("Имя сотрудника 1"), marked("Тестовый участник"));
  await input(aria("Ставка сотрудника 1"), "0,5");
  await expectHours("256 ч");
  await click("Отсутствия");
  await click("Добавить отсутствие");
  await input(aria("Первый день отсутствия 1"), "2026-10-01");
  await input(aria("Последний день отсутствия 1"), "2026-10-02");
  await expectHours("248 ч");
  await click("Календарь");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.project-calendar-month .project-month-name'), e => e.textContent)"), ["октябрь", "ноябрь", "декабрь"]);
  // Two-week sprints from the first Monday (5 October), counted in the month they end.
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.project-calendar-month .project-month-sprints'), e => e.textContent.trim())"),
    ["· 1 спринт", "· 3 спринта", "· 2 спринта"]);
  assert.equal(await evaluate("document.querySelectorAll('.project-sprint-table tbody tr').length"), 6);
  assert.match(await evaluate("document.querySelector('.project-period-facts').textContent"), /^Календарь РФ 2026 · 64 рабочих дня · 6 спринтов/);
  await evaluate(`document.querySelector(${JSON.stringify(aria("Рабочий день 2026-10-03"))}).click()`);
  await expectHours("252 ч");
  await click("Источники и доли");
  const productId = await addSource("Продукт", "20");
  const reserveId = await addSource("Встречи и резерв", "80");
  await expectSource("Продукт", { quota: "50,40 ч", planned: "—", rest: "50,40 ч" });
  const q4 = await evaluate("document.querySelector('.project-plan-select select').value");
  await openSource("Продукт");
  await addWork("Анализ продукта", "30");
  await addWork("Разработка продукта", "25");
  assert.deepEqual(await sourceHead(), ["50,40 ч", "55 ч", "перебор 4,60 ч"]);
  await openSource("Встречи и резерв");
  await addWork("Подготовка встреч", "25");
  assert.deepEqual(await sourceHead(), ["201,60 ч", "25 ч", "176,60 ч"]);
  await waitFor("Array.from(document.querySelectorAll('.project-totals-plan .project-total-note')).some(n => n.textContent.replace(/\\u00a0/g, ' ').includes('перебор 4,60 ч в 1 источнике'))", "overrun in the totals");
  await capturePage("tasks-deficit.png");

  // Missing is a persisted null, never an implicit zero or a complete demand.
  await openSource("Продукт");
  await addWork("Уточнение объёма", "");
  assert.equal((await workRows()).find((row) => row.name === "Уточнение объёма").estimate, "Без оценки");
  assert.deepEqual(await sourceHead(), ["50,40 ч", "не менее 55 ч", "перебор не менее 4,60 ч"]);
  await saveQuarter();
  const tasksWithMissing = (await readQuarter(q4)).snapshot.tasks;
  const missingTask = tasksWithMissing.find((task) => task.name === "Уточнение объёма");
  assert(missingTask, "The unestimated work is persisted");
  assert.equal(missingTask.estimateHours, null);
  await editWork("Уточнение объёма", { estimate: "0" });
  assert.deepEqual(await sourceHead(), ["50,40 ч", "55 ч", "перебор 4,60 ч"]);
  await saveQuarter();
  assert.equal((await readQuarter(q4)).snapshot.tasks.find((task) => task.id === missingTask.id)?.estimateHours, "0");

  // Rename, a decimal comma and a work taken out of the quarter; IDs stay.
  await editWork("Разработка продукта", { name: "Реализация задачи", estimate: "25,0" });
  await workMenu("Реализация задачи", "Перенести в «Не в этом квартале»");
  assert.deepEqual(await sourceHead(), ["50,40 ч", "30 ч", "20,40 ч"]);
  await editWork("Анализ продукта", { estimate: "30,5" });
  assert.deepEqual(await sourceHead(), ["50,40 ч", "30,50 ч", "19,90 ч"]);
  await editWork("Анализ продукта", { estimate: "50,4001" });
  assert.deepEqual(await sourceHead(), ["50,40 ч", "50,40 ч", "перебор <0,01 ч"]);
  await editWork("Анализ продукта", { estimate: "30" });

  // Deletion is undone from its confirmation; deleting again removes only that work.
  await workMenu("Уточнение объёма", "Удалить работу");
  await waitFor(`!${workRow("Уточнение объёма")}`, "work deleted");
  await click("Отменить");
  await waitFor(`Boolean(${workRow("Уточнение объёма")})`, "deletion undone");
  await workMenu("Уточнение объёма", "Удалить работу");
  await waitFor(`!${workRow("Уточнение объёма")}`, "work deleted again");
  assert.deepEqual(await sourceHead(), ["50,40 ч", "30 ч", "20,40 ч"]);
  await saveQuarter();
  const savedTasksBeforeClose = (await readQuarter(q4)).snapshot.tasks;
  assert.equal(savedTasksBeforeClose.length, 3);
  assert.equal(new Set(savedTasksBeforeClose.map((task) => task.id)).size, 3);
  assert(savedTasksBeforeClose.every((task) => task.id && task.id !== missingTask.id));
  const survivors = tasksWithMissing.filter((task) => task.id !== missingTask.id).map((task) => task.id);
  assert.deepEqual(savedTasksBeforeClose.map((task) => task.id), survivors, "Rename, mark changes and deletion preserve the surviving IDs");
  assert.deepEqual(savedTasksBeforeClose.map(({ name, directionId, estimateHours, mark }) => ({ name, directionId, estimateHours, mark })), [
    { name: "Анализ продукта", directionId: productId, estimateHours: "30", mark: "plan" },
    { name: "Реализация задачи", directionId: productId, estimateHours: "25", mark: "out" },
    { name: "Подготовка встреч", directionId: reserveId, estimateHours: "25", mark: "plan" }
  ]);
  await click("Изменить название команды");
  await input(".project-rename input", "Переименованная команда");
  await click("Сохранить название");
  await waitFor("document.querySelector('.project-title h1')?.textContent === 'Переименованная команда'");
  await createQuarter(1);
  await expectHours("0 ч");
  const q1 = await evaluate("document.querySelector('.project-plan-select select').value");
  await click("План квартала");
  await waitFor("document.querySelector('#setup-title')?.textContent === 'Квартал пока не настроен для планирования'", "empty quarter asks for sources");
  assert.deepEqual((await readQuarter(q1)).snapshot.tasks, []);
  await input(".project-plan-select select", q4);
  await expectHours("252 ч");
  await click("Команда");
  await input(aria("Ставка сотрудника 1"), "0,75");
  await expectHours("378 ч");
  await input(".project-plan-select select", q1);
  await waitFor("Boolean(document.querySelector('[role=alertdialog]'))");
  assert.equal(await evaluate("document.querySelector('.project-status').textContent"), "Ожидает решения");
  await click("Отмена");
  await expectHours("378 ч");
  await input(".project-plan-select select", q1);
  await click("Не сохранять");
  await expectHours("0 ч");
  await input(".project-plan-select select", q4);
  await expectHours("252 ч");
  // A year without a bundled calendar requires an explicit manual mode, then remains an independent plan.
  await openNewQuarter(2028, 1, "Не копировать");
  assert(await evaluate("Array.from(document.querySelectorAll('button')).find(e => e.textContent === 'Создать квартал').disabled"));
  await evaluate("document.querySelector('.project-new-quarter .project-confirmation input').click()");
  await click("Создать квартал");
  await expectActiveQuarter("1 квартал 2028 года");
  await expectHours("0 ч");
  // Copying: the nearest saved quarter before 2027 Q1 is offered; team, FTE and shares are copied,
  // absences, tasks and the calendar are not.
  await openNewQuarter(2027, 1);
  assert.equal(await evaluate("document.querySelector('.project-copy-source').selectedOptions[0].textContent"), "4 квартал 2026 года");
  await click("Создать квартал");
  await expectActiveQuarter("1 квартал 2027 года");
  await expectHours("224 ч");
  const copiedId = await evaluate("document.querySelector('.project-plan-select select').value");
  const copied = (await readQuarter(copiedId)).snapshot;
  const source = (await readQuarter(q4)).snapshot;
  assert.deepEqual(copied.members, source.members);
  assert.deepEqual(copied.directions, source.directions);
  assert.deepEqual(copied.competencies, source.competencies);
  assert.deepEqual([copied.absences, copied.tasks], [[], []]);
  assert.equal(copied.calendarSource.version, "ru-2027-tk112-pp1187-2026-09-17-v1");
  await click("Источники и доли");
  await expectSource("Продукт", { quota: "44,80 ч", planned: "—", rest: "44,80 ч" });
  await click("Команда");
  await input(".project-plan-select select", q4);
  await expectHours("252 ч");
  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('.project-welcome'))");
  // A second folder must have independent metadata, people and plans.
  await folder(folderB);
  await input(".project-welcome input", marked("Тестовая команда Б"));
  await click("Выбрать папку и создать");
  await createQuarter(4);
  await expectHours("0 ч");
  await click("План квартала");
  await waitFor("Boolean(document.querySelector('#setup-title'))", "second project has no sources");
  const secondProjectPlanId = await evaluate("document.querySelector('.project-plan-select select').value");
  assert.deepEqual((await readQuarter(secondProjectPlanId)).snapshot.tasks, []);
  await click("Закрыть проект");
  await folder(folderA);
  await click("Открыть папку проекта");
  await expectHours("252 ч");
  assert.equal(await evaluate("document.querySelector('.project-title h1').textContent"), "Переименованная команда");
  assert.equal(await evaluate("document.querySelector('.project-plan-select select').value"), q4);
  await openSource("Продукт");
  assert.deepEqual((await workRows()).map(({ name, estimate }) => ({ name, estimate })), [{ name: "Анализ продукта", estimate: "30 ч" }]);
  assert.equal(await evaluate("document.querySelector('.pp-toggle')?.textContent.replace(/\\u00a0/g, ' ').trim()"), "Не в этом квартале 1 работа");
  await click("Источники и доли");
  await expectSource("Продукт", { quota: "50,40 ч", planned: "30 ч", rest: "20,40 ч" });
  await expectSource("Встречи и резерв", { quota: "201,60 ч", planned: "25 ч", rest: "176,60 ч" });
  // «Сохранить и продолжить» saves the draft before switching.
  await click("Команда");
  await input(aria("Ставка сотрудника 1"), "0,75");
  await input(".project-plan-select select", q1);
  await click("Сохранить и продолжить");
  await expectActiveQuarter("1 квартал 2026 года");
  assert.equal((await readQuarter(q4)).snapshot.members[0].fte, "0.75");
  await input(".project-plan-select select", q4);
  await expectHours("378 ч");
  // Ctrl+S while the field still has focus: its value is normalized before saving.
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(aria("Ставка сотрудника 1"))});
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '0,50');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "Ставка сотрудника 1");
  await pressKey("s", "KeyS", 83, 2);
  await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'", "saved by Ctrl+S");
  assert.equal((await readQuarter(q4)).snapshot.members[0].fte, "0.5");
  await expectHours("252 ч");
  // F5 and Ctrl+R must not reload the page: a reload would drop the draft and keep the project locked.
  await evaluate("window.__smokeNoReload = true; window.__smokeReloadKeys = []; document.addEventListener('keydown', e => window.__smokeReloadKeys.push([e.key, e.defaultPrevented]))");
  await pressKey("F5", "F5", 116);
  await pressKey("r", "KeyR", 82, 2);
  await sleep(500);
  assert.equal(await evaluate("window.__smokeNoReload === true"), true, "The page was not reloaded");
  assert.deepEqual(await evaluate("window.__smokeReloadKeys"), [["F5", true], ["r", true]]);
  // Only text fields keep the native context menu; elsewhere it would offer «Обновить».
  assert.deepEqual(await evaluate(`[".project-plan-select select", ${JSON.stringify(aria("Ставка сотрудника 1"))}, ".project-totals", "body"]
    .map((selector) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.querySelector(selector).dispatchEvent(event);
      return event.defaultPrevented;
    })`), [true, false, true, true]);
  // Request the actual native X/close path with a dirty draft, then cancel it.
  await input(aria("Ставка сотрудника 1"), "0,75");
  await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })");
  await waitFor("Boolean(document.querySelector('[role=alertdialog]'))");
  await click("Отмена");
  await expectHours("378 ч");
  await input(aria("Ставка сотрудника 1"), "0,5");
  await expectHours("252 ч");
  // Real SQL round trip: selected plan, absence, FTE, baseline and manual override.
  const persisted = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
    db: window.__smokeSession.sessionKey,
    query: 'SELECT payload_json, revision FROM quarter_plans WHERE plan_id = $1', values: [${JSON.stringify(q4)}]
  })`);
  const snapshot = JSON.parse(persisted[0].payload_json);
  assert.equal(snapshot.members[0].fte, "0.5");
  assert.equal(snapshot.absences[0].endDate, "2026-10-02");
  assert.equal(snapshot.calendarSource.kind, "ru-official");
  assert.equal(snapshot.calendar.find((day) => day.date === "2026-10-03").isWorking, true);
  assert(!snapshot.calendarSource.baseWorkingDates.includes("2026-10-03"));
  assert.equal(snapshot.directions[0].percent, "20");
  assert.deepEqual(snapshot.tasks, savedTasksBeforeClose, "Work IDs, names, sources, marks and exact estimates survive reopen");
  assert.deepEqual((await readQuarter(q1)).snapshot.tasks, [], "Editing Q4 tasks leaves Q1 independent");
  // CSP must reject attempts; using .invalid prevents accidentally reaching a service.
  await evaluate("window.__smokeViolations = []; document.addEventListener('securitypolicyviolation', e => window.__smokeViolations.push({ directive: e.effectiveDirective, uri: e.blockedURI }))");
  assert.equal(await evaluate("fetch('https://example.invalid/capacity-smoke').then(() => 'allowed', () => 'blocked')"), "blocked");
  await waitFor("window.__smokeViolations.some(e => e.directive === 'connect-src' && e.uri.startsWith('https://example.invalid'))", "actual CSP refusal before network access");
  assert.equal(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:sql|load', { db: 'sqlite:unwanted.sqlite' }).then(() => 'allowed', () => 'blocked')"), "blocked");
  await evaluate("void window.open('https://example.invalid/popup-smoke', '_blank')");
  await sleep(100);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length, 1);
  await click("План квартала");
  await capturePage("workflow.png");
  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('.project-welcome'))");
  // Control for the F5 check above: with preventDefault disabled, the same CDP key does reload
  // the page. The project is closed by now, so the reload loses nothing.
  await evaluate("window.__smokeReloadControl = true; KeyboardEvent.prototype.preventDefault = function () {}");
  await pressKey("F5", "F5", 116);
  const reloadDeadline = Date.now() + 12000;
  let reloaded = false;
  while (!reloaded && Date.now() < reloadDeadline) {
    try { reloaded = await evaluate("window.__smokeReloadControl === undefined && document.readyState === 'complete'"); }
    catch { /* The execution context is replaced during the reload. */ }
    if (!reloaded) await sleep(100);
  }
  assert(reloaded, "Without the guard, F5 from CDP reloads the page");
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "welcome screen after the control reload");
  await evaluate("void (location.href = 'https://example.invalid/navigation-smoke')");
  await sleep(300);
  const afterNavigation = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(afterNavigation.length, 1);
  assert.equal(afterNavigation[0].url, "http://tauri.localhost/");
  await writeFile(resolve(root, "result.json"), JSON.stringify({ passed: true, folderA, folderB, revision: persisted[0].revision,
    networkMode: emulateOffline ? "CDP renderer offline emulation; not an OS network block" : "normal",
    capacityHours: "252", productBudgetHours: "50.4", calendarVersion: snapshot.calendarSource.version,
    taskCount: snapshot.tasks.length, productDemandHours: "30", productRemainingHours: "20.4", reserveDemandHours: "25",
    ui: "quarter planner (stages 3–4)",
    missingEstimateRoundTrip: true, explicitZeroRoundTrip: true, tinyDeficitDisplayed: true,
    quarterCopied: true, savedFromDialog: true, ctrlSSaved: true, reloadKeysBlocked: true, reloadControlReloaded: true,
    contextMenuLimitedToTextFields: true, sprintsShown: true }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts: root }));
} catch (error) {
  await writeFile(resolve(root, "failure.txt"), `${error.stack}\n\n${await evaluate("document.body.innerText").catch(() => "No UI")}`);
  console.error(error);
  console.error(`Artifacts: ${root}`);
  process.exitCode = 1;
} finally {
  socket.close();
}
