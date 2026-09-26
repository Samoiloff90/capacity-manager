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
async function taskRows() {
  return evaluate(`Array.from(document.querySelectorAll('[aria-label^="Название задачи "]'), input => {
    const row = input.closest('tr');
    const direction = row.querySelector('[aria-label^="Направление задачи "]');
    return { name: input.value, directionId: direction.value,
      estimate: row.querySelector('[aria-label^="Оценка задачи "]').value };
  })`);
}
async function expectDirection(name, expected) {
  const expression = `(() => {
    const row = Array.from(document.querySelectorAll('table.project-direction-summary tbody tr'))
      .find(row => row.cells[0]?.textContent.trim() === ${JSON.stringify(name)});
    if (!row) return false;
    const text = selector => row.querySelector(selector)?.textContent.trim();
    const actual = {
      budget: text('.project-direction-budget'),
      demandLabel: text('.project-direction-demand .project-balance-label'),
      demand: text('.project-direction-demand .project-balance-value'),
      balanceLabel: text('.project-direction-balance .project-balance-label'),
      balance: text('.project-direction-balance .project-balance-value')
    };
    return Object.entries(${JSON.stringify(expected)}).every(([key, value]) => actual[key] === value);
  })()`;
  await waitFor(expression, `direction ${name}: ${JSON.stringify(expected)}`);
}
async function clickTaskDeletion(text) {
  const expression = `(() => {
    const alert = Array.from(document.querySelectorAll('#project-panel [role="alert"]'))
      .find(alert => Array.from(alert.querySelectorAll('button'))
        .some(button => button.textContent.trim() === 'Подтвердить удаление задачи'));
    return Array.from(alert?.querySelectorAll('button') ?? [])
      .find(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.matches(':disabled'));
  })()`;
  await waitFor(`Boolean(${expression})`, `task deletion control ${text}`);
  await evaluate(`${expression}.click()`);
  await sleep(40);
}
async function readQuarter(planId) {
  const rows = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
    db: window.__smokeSession.sessionKey,
    query: 'SELECT payload_json, revision FROM quarter_plans WHERE plan_id = $1', values: [${JSON.stringify(planId)}]
  })`);
  assert.equal(rows.length, 1, "Exactly one saved quarter");
  return { snapshot: JSON.parse(rows[0].payload_json), revision: rows[0].revision };
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
  const expected = text.replace(/^(\d+) ч$/, "$1,00 ч");
  await waitFor(`document.querySelector('.project-summary-card strong')?.textContent === ${JSON.stringify(expected)}`, `capacity ${expected}`);
}
async function createQuarter(quarter) {
  await input(".project-year input", "2026");
  await input(".project-period-bar form select", String(quarter));
  await click("Создать квартал");
  await waitFor(`document.querySelector('.project-section-heading h2')?.textContent === '${quarter} квартал 2026 года'`);
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
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.project-calendar-month h3'), e => e.textContent)"), ["октябрь", "ноябрь", "декабрь"]);
  await evaluate(`document.querySelector(${JSON.stringify(aria("Рабочий день 2026-10-03"))}).click()`);
  await expectHours("252 ч");
  await click("Распределение");
  await click("Добавить направление");
  await input(aria("Название направления 1"), "Продукт");
  await input(aria("Доля направления 1"), "20");
  await click("Добавить направление");
  await input(aria("Название направления 2"), "Встречи и резерв");
  await input(aria("Доля направления 2"), "80");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "0,00 ч", balanceLabel: "Остаток", balance: "50,40 ч" });
  const q4 = await evaluate("document.querySelector('.project-plan-select select').value");
  await click("Задачи");
  await click("Добавить задачу");
  await input(aria("Название задачи 1"), "Анализ продукта");
  const productId = await selectOption(aria("Направление задачи 1"), "Продукт");
  await input(aria("Оценка задачи 1"), "30");
  await click("Добавить задачу");
  await input(aria("Название задачи 2"), "Разработка продукта");
  await selectOption(aria("Направление задачи 2"), "Продукт");
  await input(aria("Оценка задачи 2"), "25");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "55,00 ч", balanceLabel: "Дефицит", balance: "4,60 ч" });
  await expectDirection("Встречи и резерв", { budget: "201,60 ч", demandLabel: "Потребность", demand: "0,00 ч", balanceLabel: "Остаток", balance: "201,60 ч" });
  await capturePage("tasks-deficit.png");

  // Missing is a persisted null, never an implicit zero or a complete demand.
  await click("Добавить задачу");
  await input(aria("Название задачи 3"), "Уточнение объёма");
  await selectOption(aria("Направление задачи 3"), "Продукт");
  assert.equal((await taskRows())[2].estimate, "");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Известная потребность", demand: "55,00 ч", balanceLabel: "Дефицит не менее", balance: "4,60 ч" });
  await saveQuarter();
  const tasksWithMissing = (await readQuarter(q4)).snapshot.tasks;
  const missingTask = tasksWithMissing.find((task) => task.name === "Уточнение объёма");
  assert(missingTask, "The unestimated task is persisted");
  assert.equal(missingTask.estimateHours, null);
  await input(aria("Оценка задачи 3"), "0");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "55,00 ч", balanceLabel: "Дефицит", balance: "4,60 ч" });
  await saveQuarter();
  assert.equal((await readQuarter(q4)).snapshot.tasks.find((task) => task.id === missingTask.id)?.estimateHours, "0");

  // Rename and move the same task; comma input must survive as an exact decimal.
  await input(aria("Название задачи 2"), "Реализация задачи");
  const reserveId = await selectOption(aria("Направление задачи 2"), "Встречи и резерв");
  await input(aria("Оценка задачи 2"), "25,0");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "30,00 ч", balanceLabel: "Остаток", balance: "20,40 ч" });
  await expectDirection("Встречи и резерв", { budget: "201,60 ч", demandLabel: "Потребность", demand: "25,00 ч", balanceLabel: "Остаток", balance: "176,60 ч" });
  await input(aria("Оценка задачи 1"), "30,5");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "30,50 ч", balanceLabel: "Остаток", balance: "19,90 ч" });
  await input(aria("Оценка задачи 1"), "50,4001");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "50,40 ч", balanceLabel: "Дефицит", balance: "<0,01 ч" });
  await input(aria("Оценка задачи 1"), "30");

  // Cancellation retains the row; confirmation removes only its stable ID.
  await clickSelector(aria("Удалить задачу Уточнение объёма"));
  await clickTaskDeletion("Отмена");
  assert.equal((await taskRows()).length, 3);
  assert.equal((await taskRows())[2].name, "Уточнение объёма");
  await clickSelector(aria("Удалить задачу Уточнение объёма"));
  await clickTaskDeletion("Подтвердить удаление задачи");
  await waitFor("document.querySelectorAll('[aria-label^=\"Название задачи \"]').length === 2");
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "30,00 ч", balanceLabel: "Остаток", balance: "20,40 ч" });
  await saveQuarter();
  const savedTasksBeforeClose = (await readQuarter(q4)).snapshot.tasks;
  assert.equal(savedTasksBeforeClose.length, 2);
  assert.equal(new Set(savedTasksBeforeClose.map((task) => task.id)).size, 2);
  assert(savedTasksBeforeClose.every((task) => task.id && task.id !== missingTask.id));
  assert.deepEqual(savedTasksBeforeClose.map((task) => task.id), tasksWithMissing.slice(0, 2).map((task) => task.id), "Rename, move and deletion preserve the surviving task IDs");
  assert.deepEqual(savedTasksBeforeClose.map(({ name, directionId, estimateHours }) => ({ name, directionId, estimateHours })), [
    { name: "Анализ продукта", directionId: productId, estimateHours: "30" },
    { name: "Реализация задачи", directionId: reserveId, estimateHours: "25" }
  ]);
  await click("Изменить название команды");
  await input(".project-rename input", "Переименованная команда");
  await click("Сохранить название");
  await waitFor("document.querySelector('.project-title h1')?.textContent === 'Переименованная команда'");
  await createQuarter(1);
  await expectHours("0 ч");
  const q1 = await evaluate("document.querySelector('.project-plan-select select').value");
  await click("Задачи");
  assert.deepEqual(await taskRows(), []);
  assert.deepEqual((await readQuarter(q1)).snapshot.tasks, []);
  await input(".project-plan-select select", q4);
  await expectHours("252 ч");
  await click("Команда");
  await input(aria("Ставка сотрудника 1"), "0,75");
  await expectHours("378 ч");
  await input(".project-plan-select select", q1);
  await waitFor("Boolean(document.querySelector('[role=alertdialog]'))");
  await click("Вернуться");
  await expectHours("378 ч");
  await input(".project-plan-select select", q1);
  await click("Не сохранять");
  await expectHours("0 ч");
  await input(".project-plan-select select", q4);
  await expectHours("252 ч");
  // A year without a bundled calendar requires an explicit manual mode, then remains an independent plan.
  await input(".project-year input", "2028");
  assert(await evaluate("Array.from(document.querySelectorAll('button')).find(e => e.textContent === 'Создать квартал').disabled"));
  await evaluate("document.querySelector('.project-confirmation input').click()");
  await click("Создать квартал");
  await expectHours("0 ч");
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
  await click("Задачи");
  assert.deepEqual(await taskRows(), []);
  const secondProjectPlanId = await evaluate("document.querySelector('.project-plan-select select').value");
  assert.deepEqual((await readQuarter(secondProjectPlanId)).snapshot.tasks, []);
  await click("Закрыть проект");
  await folder(folderA);
  await click("Открыть папку проекта");
  await expectHours("252 ч");
  assert.equal(await evaluate("document.querySelector('.project-title h1').textContent"), "Переименованная команда");
  assert.equal(await evaluate("document.querySelector('.project-plan-select select').value"), q4);
  await click("Задачи");
  assert.deepEqual(await taskRows(), [
    { name: "Анализ продукта", directionId: productId, estimate: "30" },
    { name: "Реализация задачи", directionId: reserveId, estimate: "25" }
  ]);
  await expectDirection("Продукт", { budget: "50,40 ч", demandLabel: "Потребность", demand: "30,00 ч", balanceLabel: "Остаток", balance: "20,40 ч" });
  await expectDirection("Встречи и резерв", { budget: "201,60 ч", demandLabel: "Потребность", demand: "25,00 ч", balanceLabel: "Остаток", balance: "176,60 ч" });
  // Request the actual native X/close path with a dirty draft, then cancel it.
  await click("Команда");
  await input(aria("Ставка сотрудника 1"), "0,75");
  await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })");
  await waitFor("Boolean(document.querySelector('[role=alertdialog]'))");
  await click("Вернуться");
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
  assert.deepEqual(snapshot.tasks, savedTasksBeforeClose, "Task IDs, names, direction references and exact estimates survive reopen");
  assert.deepEqual((await readQuarter(q1)).snapshot.tasks, [], "Editing Q4 tasks leaves Q1 independent");
  // CSP must reject attempts; using .invalid prevents accidentally reaching a service.
  await evaluate("window.__smokeViolations = []; document.addEventListener('securitypolicyviolation', e => window.__smokeViolations.push({ directive: e.effectiveDirective, uri: e.blockedURI }))");
  assert.equal(await evaluate("fetch('https://example.invalid/capacity-smoke').then(() => 'allowed', () => 'blocked')"), "blocked");
  await waitFor("window.__smokeViolations.some(e => e.directive === 'connect-src' && e.uri.startsWith('https://example.invalid'))", "actual CSP refusal before network access");
  assert.equal(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:sql|load', { db: 'sqlite:unwanted.sqlite' }).then(() => 'allowed', () => 'blocked')"), "blocked");
  await evaluate("void window.open('https://example.invalid/popup-smoke', '_blank')");
  await sleep(100);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length, 1);
  await click("Задачи");
  await capturePage("workflow.png");
  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('.project-welcome'))");
  await evaluate("void (location.href = 'https://example.invalid/navigation-smoke')");
  await sleep(300);
  const afterNavigation = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(afterNavigation.length, 1);
  assert.equal(afterNavigation[0].url, "http://tauri.localhost/");
  await writeFile(resolve(root, "result.json"), JSON.stringify({ passed: true, folderA, folderB, revision: persisted[0].revision,
    networkMode: emulateOffline ? "CDP renderer offline emulation; not an OS network block" : "normal",
    capacityHours: "252", productBudgetHours: "50.4", calendarVersion: snapshot.calendarSource.version,
    taskCount: snapshot.tasks.length, productDemandHours: "30", productRemainingHours: "20.4", reserveDemandHours: "25",
    missingEstimateRoundTrip: true, explicitZeroRoundTrip: true, tinyDeficitDisplayed: true }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts: root }));
} catch (error) {
  await writeFile(resolve(root, "failure.txt"), `${error.stack}\n\n${await evaluate("document.body.innerText").catch(() => "No UI")}`);
  console.error(error);
  console.error(`Artifacts: ${root}`);
  process.exitCode = 1;
} finally {
  socket.close();
}
