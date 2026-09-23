// Development-only end-to-end check of a running Tauri WebView2.
// Run: node --experimental-websocket scripts/webview-smoke.mjs [local CDP port]
// Only the OS folder picker is replaced. Every project and SQL call is real.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const port = Number(process.argv[2] ?? 19323);
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
  await input(".project-welcome input", "Тестовая команда А");
  await click("Выбрать папку и создать");
  await createQuarter(4);
  await expectHours("0 ч");
  await click("Добавить сотрудника");
  await input(aria("Имя сотрудника 1"), "Тестовый участник");
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
  await waitFor("document.querySelector('#project-panel').innerText.includes('50,40 ч')");
  await click("Сохранить квартал");
  await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'");
  await click("Изменить название команды");
  await input(".project-rename input", "Переименованная команда");
  await click("Сохранить название");
  await waitFor("document.querySelector('.project-title h1')?.textContent === 'Переименованная команда'");
  const q4 = await evaluate("document.querySelector('.project-plan-select select').value");
  await createQuarter(1);
  await expectHours("0 ч");
  const q1 = await evaluate("document.querySelector('.project-plan-select select').value");
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
  // Unknown year requires an explicit manual mode, then remains an independent plan.
  await input(".project-year input", "2027");
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
  await input(".project-welcome input", "Тестовая команда Б");
  await click("Выбрать папку и создать");
  await createQuarter(4);
  await expectHours("0 ч");
  await click("Закрыть проект");
  await folder(folderA);
  await click("Открыть папку проекта");
  await expectHours("252 ч");
  assert.equal(await evaluate("document.querySelector('.project-title h1').textContent"), "Переименованная команда");
  assert.equal(await evaluate("document.querySelector('.project-plan-select select').value"), q4);
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
  // CSP must reject attempts; using .invalid prevents accidentally reaching a service.
  await evaluate("window.__smokeViolations = []; document.addEventListener('securitypolicyviolation', e => window.__smokeViolations.push({ directive: e.effectiveDirective, uri: e.blockedURI }))");
  assert.equal(await evaluate("fetch('https://example.invalid/capacity-smoke').then(() => 'allowed', () => 'blocked')"), "blocked");
  await waitFor("window.__smokeViolations.some(e => e.directive === 'connect-src' && e.uri.startsWith('https://example.invalid'))", "actual CSP refusal before network access");
  assert.equal(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:sql|load', { db: 'sqlite:unwanted.sqlite' }).then(() => 'allowed', () => 'blocked')"), "blocked");
  await evaluate("void window.open('https://example.invalid/popup-smoke', '_blank')");
  await sleep(100);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length, 1);
  await click("Распределение");
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(root, "workflow.png"), Buffer.from(screenshot.data, "base64"));
  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('.project-welcome'))");
  await evaluate("void (location.href = 'https://example.invalid/navigation-smoke')");
  await sleep(300);
  const afterNavigation = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.equal(afterNavigation.length, 1);
  assert.equal(afterNavigation[0].url, "http://tauri.localhost/");
  await writeFile(resolve(root, "result.json"), JSON.stringify({ passed: true, folderA, folderB, revision: persisted[0].revision,
    capacityHours: "252", productBudgetHours: "50.4", calendarVersion: snapshot.calendarSource.version }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts: root }));
} catch (error) {
  await writeFile(resolve(root, "failure.txt"), `${error.stack}\n\n${await evaluate("document.body.innerText").catch(() => "No UI")}`);
  console.error(error);
  console.error(`Artifacts: ${root}`);
  process.exitCode = 1;
} finally {
  socket.close();
}
