// Development-only end-to-end check of the quarter planner (stages 2–4) against a running EXE.
// The caller starts the EXE with a fresh WebView2 profile and --remote-debugging-port=<port>
// (WEBVIEW2_USER_DATA_FOLDER, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) and stops it afterwards.
//   node --experimental-websocket scripts/planner-smoke.mjs <port> <demo dir>
// <demo dir> holds the fictional demo projects written by the store (cargo test --lib
// write_demo_projects -- --ignored, CAPACITY_DEMO_OUT): Alpha-new-format and Beta-format-0.3.0.
// Copies are made under src-tauri/target/planner-smoke-<time>; the demo folders are not opened.
// Only the folder picker is replaced. Project files, SQL, the calculation and the UI are real.
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [portText, demoInput] = process.argv.slice(2);
const port = Number(portText);
assert(Number.isInteger(port) && port >= 1024 && port < 65536 && demoInput, "Expected: <local CDP port> <demo dir>");
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const target = join(workspace, "src-tauri", "target");
const demo = await realpath(resolve(demoInput));
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const plain = (text) => (text ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const steps = [];
const step = (name) => { steps.push(name); console.log(`- ${name}`); };

const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json())
  .filter((item) => item.type === "page");
assert.equal(pages.length, 1, "Expected exactly one test window");
assert.equal(pages[0].url, "http://tauri.localhost/", "Expected packaged local assets");
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((accept, reject) => { socket.onopen = accept; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const consoleErrors = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(JSON.stringify(message.params.exceptionDetails).slice(0, 400));
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" ").slice(0, 400));
  }
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
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await new Promise((accept) => setTimeout(accept, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
const js = (value) => JSON.stringify(value);
const textOf = (selector) => evaluate(`(document.querySelector(${js(selector)})?.textContent ?? '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim()`);
const texts = (selector) => evaluate(`Array.from(document.querySelectorAll(${js(selector)}), e => e.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim())`);
async function click(label, scope = "document") {
  const button = `Array.from(${scope}.querySelectorAll('button')).find(b => b.textContent.replace(/\\u00a0/g, ' ').trim() === ${js(label)} && !b.matches(':disabled'))`;
  await waitFor(`Boolean(${button})`, `enabled button «${label}»`);
  await evaluate(`${button}.click()`);
}
async function clickSelector(selector) {
  await waitFor(`(() => { const e = document.querySelector(${js(selector)}); return Boolean(e) && !e.matches(':disabled'); })()`, selector);
  await evaluate(`document.querySelector(${js(selector)}).click()`);
}
/** Types like a person: the native value setter, then input and change events React listens to. */
async function type(selector, value) {
  await waitFor(`Boolean(document.querySelector(${js(selector)}))`, selector);
  await evaluate(`(() => {
    const input = document.querySelector(${js(selector)});
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${js(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}
async function key(selector, keyName, extra = {}) {
  await evaluate(`(() => {
    const target = ${selector ? `document.querySelector(${js(selector)})` : "document.activeElement || document.body"};
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ${js(keyName)}, code: ${js(keyName === "s" ? "KeyS" : keyName)}, bubbles: true, cancelable: true, ...${js(extra)} }));
  })()`);
}
const saveShortcut = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))`);
const status = () => textOf(".project-status");

async function pickFolder(folder) {
  await evaluate(`(() => {
    window.__plannerRestore?.();
    const originalFetch = window.fetch;
    window.__plannerRestore = () => { window.fetch = originalFetch; delete window.__plannerRestore; };
    window.fetch = async (resource, options) => {
      const raw = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      const url = new URL(raw, location.href);
      const command = url.hostname === 'ipc.localhost' ? decodeURIComponent(url.pathname.slice(1)) : null;
      if (command === 'plugin:dialog|open') return new Response(${js(JSON.stringify(folder))}, {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' }
      });
      const result = await originalFetch.call(window, resource, options);
      if ((command === 'project_open' || command === 'project_create') && result.headers.get('Tauri-Response') === 'ok') window.__plannerSession = await result.clone().json();
      return result;
    };
  })()`);
}
async function openProject(folder) {
  await pickFolder(folder);
  await click("Открыть папку проекта");
  await waitFor(`document.querySelector('.project-path')?.textContent === ${js(folder)}`, `opened ${folder}`);
}
async function closeProject(answer) {
  await click("Закрыть проект");
  if (answer) {
    await waitFor("Boolean(document.querySelector('[role=alertdialog]'))", "unsaved-changes dialog");
    const message = await textOf("#discard-message");
    await click(answer, "document.querySelector('[role=alertdialog]')");
    await waitFor("Boolean(document.querySelector('.project-welcome'))", "closed to the welcome screen");
    return message;
  }
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "closed to the welcome screen");
  return null;
}
async function tab(label) {
  await click(label, "document.querySelector('.project-tabs')");
  await waitFor(`document.querySelector('.project-tabs [aria-selected=true]')?.textContent.startsWith(${js(label)})`, `tab ${label}`);
}
/** The five figures of the team balance, as shown. */
const totals = () => evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('.project-totals-plan .project-total'), t => [
  t.querySelector('.project-total-label').textContent.trim(), t.querySelector('strong').textContent.replace(/\\u00a0/g, ' ').trim()]))`);
const head = () => evaluate(`Array.from(document.querySelectorAll('.pp-head .pp-num strong'), s => s.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim())`);
async function openSource(name) {
  if (await evaluate("Boolean(document.querySelector('#crumb-back'))")) await clickSelector("#crumb-back");
  await waitFor(`Array.from(document.querySelectorAll('.pp-overview .pp-name')).some(b => b.textContent === ${js(name)})`, `source ${name} in the overview`);
  await evaluate(`Array.from(document.querySelectorAll('.pp-overview .pp-name')).find(b => b.textContent === ${js(name)}).click()`);
  await waitFor(`document.querySelector('#source-title')?.textContent === ${js(name)}`, `workspace of ${name}`);
}
const overviewRow = (name) => evaluate(`(() => {
  const row = Array.from(document.querySelectorAll('.pp-overview tbody tr')).find(r => r.querySelector('.pp-name')?.textContent === ${js(name)});
  return row ? Array.from(row.cells, c => c.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim()) : null;
})()`);
const workRow = (name) => `Array.from(document.querySelectorAll('.pp-row')).find(r => r.querySelector('.pp-wname')?.firstChild?.textContent === ${js(name)})`;
async function menu(name, item) {
  await waitFor(`Boolean(${workRow(name)})`, `work ${name}`);
  await evaluate(`${workRow(name)}.querySelector('[data-menu-for]').click()`);
  await click(item, "document.querySelector('.pp-menu')");
}
const sourcesRow = (name) => evaluate(`(() => {
  const row = Array.from(document.querySelectorAll('table.pp-sources tbody tr')).find(r => r.querySelector('input[aria-label="Название источника"]')?.value === ${js(name)});
  return row ? Array.from(row.cells, c => c.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim()) : null;
})()`);
async function rows(sessionKey) {
  const result = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:sql|select', { db: ${js(sessionKey)},
    query: 'SELECT plan_id, year, quarter, revision, payload_version, payload_json FROM quarter_plans ORDER BY year, quarter', values: [] })`);
  return result.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

const root = join(target, `planner-smoke-${Date.now()}`);
const result = { root, steps, passed: false };
try {
  await cdp("Runtime.enable");
  await waitFor("Boolean(document.querySelector('.project-welcome'))", "fresh EXE on the welcome screen");
  assert.match(await textOf(".project-preview-note"), /^Тестовая версия 0\.4\.0-alpha\.1 с новым форматом проектов/);
  await mkdir(root);

  // A. The fictional demo project in the new format: the PO's control example of DEC-041.
  const alpha = join(root, "Alpha");
  await cp(join(demo, "Alpha-new-format"), alpha, { recursive: true });
  await openProject(alpha);
  step("demo project opened on «План квартала»");
  assert.equal(await textOf(".project-tabs [aria-selected=true]"), "План квартала");
  assert.match(await textOf(".project-topbar .project-chip.preview"), /^Тестовая версия 0\.4\.0-alpha\.1$/);
  assert.deepEqual(await totals(), {
    "Доступно команде": "2 000 ч", "Резерв на встречи": "344,80 ч", "Занято работами": "не менее 980 ч",
    "Остатки квот": "не более 390 ч", "Не распределено": "305,20 ч"
  });
  assert.deepEqual((await overviewRow("Запросы УИ")).slice(0, 4), ["Запросы УИ", "12,5% · 250 ч", "200 ч · 80%", "50 ч"]);
  assert.match((await overviewRow("Мобильное приложение"))[3], /^Перебор 20 ч/);
  step("team balance and source table: 2 000 ч, reserve 344,80 ч, «Запросы УИ» 250 / 200 / 50");

  await openSource("Запросы УИ");
  assert.deepEqual(await head(), ["250 ч", "200 ч", "50 ч"]);
  await click("Добавить работу");
  await waitFor("document.activeElement?.id === 'add-name'", "focus in the name field");
  await type("#add-name", "Отчёт для финансовой службы");
  await type("#add-estimate", "28");
  await clickSelector("input[name=add-mark][value=plan]");
  await waitFor("document.querySelector('.pp-form[data-form=add] .pp-mark-note')?.textContent === 'Сразу займёт бюджет источника'", "plan mode note");
  assert.equal(await textOf(".pp-form[data-form=add] .pp-effect-line"), "После включения работы на 28 ч в плане будет 228 ч, останется 22 ч.");
  assert.equal(await textOf("#add-submit"), "Добавить в план квартала");
  await key("#add-comment", "Enter");
  await waitFor("Boolean(document.querySelector('.pp-done'))", "confirmation of the added work");
  assert.deepEqual(await head(), ["250 ч", "228 ч", "22 ч"]);
  assert.match(await textOf(".pp-done"), /^Добавлено в план квартала: «Отчёт для финансовой службы», 28 ч\. Остаток квоты: 22 ч.s?Отменить$/);
  assert.match(await textOf(".pp-head"), /было 200 ч/);
  assert.equal(await evaluate("document.activeElement?.id"), "add-name");
  step("added 28 h to the plan: 228 h taken, 22 h left, «было 200 ч», focus back in the name");

  await clickSelector("#add-undo");
  await waitFor("!document.querySelector('.pp-done')", "undo done");
  assert.deepEqual(await head(), ["250 ч", "200 ч", "50 ч"]);
  await type("#add-name", "Отчёт для финансовой службы");
  await type("#add-estimate", "28");
  assert.equal(await evaluate("document.querySelector('input[name=add-mark][value=plan]').checked"), true, "the mode stays «В план квартала»");
  await clickSelector("#add-submit");
  await waitFor("Boolean(document.querySelector('.pp-done'))", "added again");
  assert.deepEqual(await head(), ["250 ч", "228 ч", "22 ч"]);
  step("«Отменить» removed the work; added again");

  await menu("Отчёт для финансовой службы", "Изменить…");
  await waitFor("document.activeElement?.id === 'edit-name'", "edit form");
  await type("#edit-estimate", "34");
  assert.equal(await textOf(".pp-form[data-form=edit] .pp-effect-line"), "Оценка: 28 ч → 34 ч. Остаток квоты станет 16 ч.");
  await key("#edit-estimate", "Enter");
  await waitFor("!document.querySelector('.pp-form[data-form=edit]')", "edit saved");
  assert.deepEqual(await head(), ["250 ч", "234 ч", "16 ч"]);
  assert.equal(plain(await evaluate(`${workRow("Отчёт для финансовой службы")}.querySelector('.pp-est').textContent`)), "34 ч");
  step("estimate 28 → 34 h replaces the old one: 234 h taken, 16 h left");

  // Errors at the field, 0 h and the remembered mode (DEC-041, DEC-043).
  await type("#add-name", "Справочник подразделений");
  await type("#add-estimate", "M");
  await key("#add-estimate", "Enter");
  await waitFor("document.querySelector('#add-estimate')?.getAttribute('aria-invalid') === 'true'", "size rejected");
  assert.match(await textOf(".pp-form[data-form=add]"), /«M» — размер, а нужны часы\. Размеры в часы не переводятся\./);
  assert.deepEqual(await head(), ["250 ч", "234 ч", "16 ч"]);
  await type("#add-estimate", "0");
  assert.match(await textOf(".pp-form[data-form=add] .pp-zero"), /^Указана нулевая трудоёмкость\. Если оценка неизвестна, оставьте поле пустым/);
  await type("#add-estimate", "");
  await key("#add-name", "Escape");
  await waitFor("!document.querySelector('.pp-form[data-form=add]')", "form closed by Esc");
  assert.equal(await textOf("#btn-add"), "Продолжить ввод работы");
  step("«M» is not hours, 0 h shows the note, Esc keeps the typed text");

  await clickSelector("#crumb-back");
  await waitFor("Boolean(document.querySelector('.pp-overview'))", "overview");
  assert.match((await overviewRow("Запросы УИ"))[0], /незаконченный ввод работы/);
  await openSource("Запросы УИ");
  await waitFor("Boolean(document.querySelector('#btn-add'))", "workspace");
  await click("Продолжить ввод работы");
  assert.equal(await evaluate("document.querySelector('#add-name').value"), "Справочник подразделений");
  assert.equal(await evaluate("document.querySelector('input[name=add-mark][value=plan]').checked"), true);
  step("unfinished input kept per source and marked in the table");
  // A fresh form after a blank one starts with the remembered «В план квартала», visibly.
  await clickSelector("#add-clear");
  await key("#add-name", "Escape");
  await waitFor("!document.querySelector('.pp-form[data-form=add]')", "blank form forgotten");
  assert.equal(await textOf("#btn-add"), "Добавить работу");
  await click("Добавить работу");
  assert.equal(await evaluate("document.querySelector('input[name=add-mark][value=plan]').checked"), true);
  assert.equal(await textOf(".pp-remembered"), "Как в прошлый раз для «Запросы УИ»");
  assert.equal(await evaluate("document.querySelector('.pp-form[data-form=add]').classList.contains('to-plan')"), true);
  await type("#add-name", "Справочник подразделений");
  await key("#add-name", "Escape");
  await waitFor("!document.querySelector('.pp-form[data-form=add]')", "form closed with input");
  step("the remembered «В план квартала» is visible before adding: «Как в прошлый раз для «Запросы УИ»»");

  // Candidates: include with consequence, undo from the confirmation; move out and back.
  await openSource("Продукт «Витрина»");
  assert.deepEqual(await head(), ["800 ч", "не менее 600 ч", "не более 200 ч"]);
  assert.equal(plain(await evaluate(`${workRow("Отзывы покупателей")}.querySelector('.pp-effect').textContent`)), "В плане будет не менее 760 ч, останется не более 40 ч");
  await evaluate(`${workRow("Отзывы покупателей")}.querySelector('.pp-action').click()`);
  await waitFor("Boolean(document.querySelector('.pp-ghost'))", "confirmation after including");
  assert.match(await textOf(".pp-ghost"), /^Включено в план квартала: «Отзывы покупателей», 160 ч\. Остаток квоты: не более 40 ч.s?Отменить$/);
  assert.deepEqual(await head(), ["800 ч", "не менее 760 ч", "не более 40 ч"]);
  await click("Отменить", "document.querySelector('.pp-ghost')");
  await waitFor("!document.querySelector('.pp-ghost')", "undone");
  assert.deepEqual(await head(), ["800 ч", "не менее 600 ч", "не более 200 ч"]);
  await menu("Корзина: промокоды", "Перенести в «Не в этом квартале»");
  await waitFor("Boolean(document.querySelector('.pp-ghost'))", "moved out");
  assert.deepEqual(await head(), ["800 ч", "не менее 320 ч", "не более 480 ч"]);
  await menu("Корзина: промокоды", "Включить в план квартала");
  await waitFor(`(${workRow("Корзина: промокоды")})?.classList.contains('plan')`, "back in the plan");
  assert.deepEqual(await head(), ["800 ч", "не менее 600 ч", "не более 200 ч"]);
  step("include with consequence and undo; «Не в этом квартале» takes no budget");

  // Sources and the reserve window (stage 3).
  await tab("Источники и доли");
  const shareInput = (name) => `Array.from(document.querySelectorAll('table.pp-sources input[aria-label="Название источника"]')).find(i => i.value === ${js(name)}).closest('tr').querySelector('.pp-share')`;
  assert.equal(await evaluate(`${shareInput("Запросы УИ")}.value`), "12,5");
  assert.deepEqual((await sourcesRow("Запросы УИ")).slice(3, 6), ["250 ч", "234 ч", "16 чсохранено: остаток 50 ч"]);
  assert.match((await sourcesRow("Встречи и ритуалы"))[2], /общая; своя у 1 · всего 17,24%/);
  assert.equal((await textOf("table.pp-sources tfoot")).replace(/\s/g, ""), "Выделеноисточникам84,74%1694,80чНераспределено15,26%305,20чпереборвисточниках:20ч");
  step("«Источники и доли»: share 12,5, quota 250 ч, 234 ч in the plan, «сохранено: остаток 50 ч»; reserve 17,24% with an own share");

  await clickSelector("#reserve-open-src-meetings");
  await waitFor("Boolean(document.querySelector('#reserve-title'))", "reserve window");
  assert.equal(await textOf(".pp-modal-foot .pp-effect-line"), "Резерв: 344,80 ч. Не распределено станет 305,20 ч.");
  await type('input[aria-label="Своя доля, %: Борис Петров"]', "20");
  assert.equal(await textOf(".pp-modal-foot .pp-effect-line"), "Резерв: 366,40 ч сейчас 344,80 ч. Не распределено станет 283,60 ч.");
  await saveShortcut();
  await waitFor("Boolean(document.querySelector('.pp-hintline'))", "hint instead of saving");
  assert.equal(await textOf(".pp-hintline"), "Сначала примените или отмените изменения в этом окне, затем сохраните квартал.");
  assert.equal(await status(), "Есть несохранённые изменения");
  await click("Отмена", "document.querySelector('[role=dialog]')");
  await waitFor("!document.querySelector('#reserve-title')", "reserve window closed");
  assert.match((await sourcesRow("Встречи и ритуалы"))[3], /^344,80 ч/);
  step("reserve window: own share 20% gives 366,40 ч and 283,60 ч not allocated; Ctrl+S there does not save; «Отмена» applies nothing");

  const debtId = await evaluate(`${shareInput("Техдолг")}.id`);
  await type(`#${debtId}`, "десять");
  assert.match((await sourcesRow("Техдолг"))[2], /Число от 0 до 100\./);
  assert.match((await sourcesRow("Техдолг"))[3], /^—/);
  await saveShortcut();
  await waitFor("Boolean(document.querySelector('.project-message.error'))", "save refused");
  assert.match(await textOf(".project-message.error"), /^Не удалось сохранить\. Доля источника «Техдолг»: число от 0 до 100\./);
  await key(`#${debtId}`, "Escape");
  await waitFor(`${shareInput("Техдолг")}.value === '10'`, "Esc restored the share");
  assert.match((await sourcesRow("Техдолг"))[3], /^200 ч/);
  step("unreadable share: error at the field, not counted, save refused with its name; Esc restored 10");

  // Restoring the share changed the quarter, so the refused-save error is gone by itself.
  assert.equal(await evaluate("Boolean(document.querySelector('.project-message.error'))"), false);
  await saveShortcut();
  await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'", "saved by Ctrl+S");
  const messages = await texts(".project-message[role=status]");
  assert(messages.includes("Изменения квартала «1 квартал 2027 года» сохранены."), messages.join(" | "));
  assert(messages.some((line) => line.startsWith("Сохранение не балансирует план: перебор квоты — «Мобильное приложение» 20 ч.")), messages.join(" | "));
  step("Ctrl+S saved; the warning names the overrun of «Мобильное приложение» 20 ч");

  await click("Как составить план квартала");
  await waitFor("document.querySelector('#help-title')?.textContent === 'Как составить план квартала'", "help page");
  assert.deepEqual(await texts(".pp-help .pp-steps b"), ["Проверить ёмкость", "Распределить доли", "Добавить работы", "Выбрать состав плана", "Проверить остатки и превышения"]);
  await key(null, "Escape");
  await waitFor("!document.querySelector('#help-title')", "help closed by Esc");
  step("«Как составить план квартала»: five steps, closes by Esc");

  const alphaSession = await evaluate("window.__plannerSession?.sessionKey");
  const savedRows = await rows(alphaSession);
  assert.equal(savedRows.length, 1);
  assert.deepEqual([savedRows[0].payload_version, savedRows[0].revision], [2, 2]);
  const added = savedRows[0].payload.tasks.find((task) => task.name === "Отчёт для финансовой службы");
  assert.deepEqual({ estimateHours: added.estimateHours, mark: added.mark, directionId: added.directionId }, { estimateHours: "34", mark: "plan", directionId: "src-requests" });
  assert(!JSON.stringify(savedRows[0].payload).includes("Справочник подразделений"), "unfinished input is not written to the file");
  step("file: payload 2, revision 2, the work with 34 h in the plan; the unfinished input is not in it");

  await click("Закрыть проект");
  await waitFor("Boolean(document.querySelector('[role=alertdialog]'))", "dialog about the unfinished input");
  assert.equal(plain(await textOf("#discard-message")), "Незаконченный ввод работ в файл проекта не сохраняется и будет потерян:«Запросы УИ», 1 квартал 2027 года: «Справочник подразделений»");
  await click("Отмена", "document.querySelector('[role=alertdialog]')");
  await waitFor("!document.querySelector('[role=alertdialog]') && Boolean(document.querySelector('.project-topbar'))", "still open after «Отмена»");
  const lost = await closeProject("Не сохранять");
  assert.match(plain(lost), /«Справочник подразделений»/);
  step("closing asks about the unfinished input; «Отмена» keeps the project, «Не сохранять» closes it");

  await openProject(alpha);
  await openSource("Запросы УИ");
  assert.deepEqual(await head(), ["250 ч", "234 ч", "16 ч"]);
  assert.equal(await textOf("#btn-add"), "Добавить работу");
  assert(await evaluate(`Boolean(${workRow("Отчёт для финансовой службы")}?.classList.contains('plan'))`));
  assert.deepEqual(await totals(), {
    "Доступно команде": "2 000 ч", "Резерв на встречи": "344,80 ч", "Занято работами": "не менее 1 014 ч",
    "Остатки квот": "не более 356 ч", "Не распределено": "305,20 ч"
  });
  await closeProject();
  step("reopened: 234 h taken, 16 h left in «Запросы УИ»; the session input is gone");

  // B. A new project from scratch: the main path of the intermediate build.
  const fresh = join(root, "Новая команда");
  await mkdir(fresh);
  await type(".project-welcome input", "Команда проверки");
  await pickFolder(fresh);
  await click("Выбрать папку и создать");
  await waitFor(`document.querySelector('.project-path')?.textContent === ${js(fresh)}`, "new project");
  await click("Новый квартал…");
  await waitFor("Boolean(document.querySelector('#new-quarter-title'))", "new quarter dialog");
  await type(".project-new-quarter .project-year input", "2027");
  await evaluate(`(() => { const select = Array.from(document.querySelectorAll('.project-new-quarter select'))[0];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '1');
    select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click("Создать квартал");
  await waitFor("document.querySelector('.project-tabs [aria-selected=true]')?.textContent === 'Команда'", "team tab of the new quarter");
  await click("Добавить сотрудника");
  await type('[aria-label="Имя сотрудника 1"]', "Сотрудник проверки");
  await waitFor(`(${js("")}, document.querySelector('.project-totals-plan .project-total strong')?.textContent.replace(/\\u00a0/g, ' ') === '448 ч')`, "448 h available");
  await tab("План квартала");
  assert.equal(await textOf("#setup-title"), "Квартал пока не настроен для планирования");
  await clickSelector("#setup-sources");
  await waitFor("document.querySelector('.project-tabs [aria-selected=true]')?.textContent.startsWith('Источники и доли')", "sources tab");
  await clickSelector("#btn-source-add");
  await waitFor("document.activeElement?.getAttribute('aria-label') === 'Название источника'", "focus in the new source name");
  const firstId = await evaluate("document.activeElement.id");
  await type(`#${firstId}`, "Поддержка");
  await type(`#${firstId.replace("src-name-", "src-share-")}`, "50");
  assert.match((await sourcesRow("Поддержка"))[3], /^224 ч/);
  await clickSelector("#btn-source-add");
  await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Название источника' && document.activeElement.id !== ${js(firstId)}`, "second source");
  const secondId = await evaluate("document.activeElement.id");
  await type(`#${secondId}`, "Встречи");
  await evaluate(`(() => { const select = document.querySelector(${js(`#${secondId.replace("src-name-", "src-kind-")}`)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'reserve');
    select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await type(`#${secondId.replace("src-name-", "src-share-")}`, "10");
  assert.deepEqual(await totals(), {
    "Доступно команде": "448 ч", "Резерв на встречи": "44,80 ч", "Занято работами": "0 ч",
    "Остатки квот": "224 ч", "Не распределено": "179,20 ч"
  });
  step("new project: quarter, a person, a work source 50% and a reserve 10%");
  await tab("План квартала");
  await openSource("Поддержка");
  await click("Добавить работу");
  await type("#add-name", "Разбор обращений");
  await type("#add-estimate", "16");
  assert.equal(await evaluate("document.querySelector('input[name=add-mark][value=candidate]').checked"), true, "a new work starts on review");
  assert.equal(await textOf(".pp-form[data-form=add] .pp-mark-note"), "Бюджет не займёт");
  await clickSelector("#add-submit");
  await waitFor(`Boolean(${workRow("Разбор обращений")})`, "work on review");
  assert.deepEqual(await head(), ["224 ч", "0 ч", "224 ч"]);
  assert.equal(plain(await evaluate(`${workRow("Разбор обращений")}.querySelector('.pp-effect').textContent`)), "В плане будет 16 ч, останется 208 ч");
  await evaluate(`${workRow("Разбор обращений")}.querySelector('.pp-action').click()`);
  await waitFor(`(${workRow("Разбор обращений")})?.classList.contains('plan')`, "included");
  assert.deepEqual(await head(), ["224 ч", "16 ч", "208 ч"]);
  await click("Сохранить квартал");
  await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'", "saved");
  await closeProject();
  await openProject(fresh);
  await openSource("Поддержка");
  assert.deepEqual(await head(), ["224 ч", "16 ч", "208 ч"]);
  await closeProject();
  step("work added on review, included in the plan, saved and reopened: 16 h taken, 208 h left");

  // C. The demo project in the format of 0.3.0: opened unchanged, upgraded on the first save.
  const beta = join(root, "Beta");
  await cp(join(demo, "Beta-format-0.3.0"), beta, { recursive: true });
  const betaFile = join(beta, "capacity.sqlite");
  const betaSha = await sha256(betaFile);
  await openProject(beta);
  assert.deepEqual((await overviewRow("Продукт")).slice(1, 4), ["50% · 704 ч", "не менее 160 ч · от 23%", "не более 544 ч1 в плане без оценки"]);
  assert.match((await overviewRow("Встречи и резерв"))[1], /^20% · 281,60 ч$/);
  await closeProject();
  assert.equal(await sha256(betaFile), betaSha, "opening a project of 0.3.0 changed the file");
  await openProject(beta);
  await openSource("Продукт");
  await menu("Личный кабинет: история заказов", "Изменить…");
  await type("#edit-estimate", "150");
  await clickSelector("#edit-submit");
  await waitFor("!document.querySelector('.pp-form[data-form=edit]')", "edit saved");
  await saveShortcut();
  await waitFor("document.querySelector('#format-upgrade-title')?.textContent === 'Обновить формат проекта'", "format question");
  assert.equal(await status(), "Ожидает решения");
  await click("Обновить формат и сохранить");
  await waitFor("document.querySelector('.project-status')?.textContent === 'Все изменения сохранены'", "saved after the upgrade");
  const notice = (await texts(".project-message[role=status]")).join(" | ");
  const backup = /Резервная копия исходного проекта: (.+?\.sqlite)\./.exec(notice)?.[1];
  assert(backup && dirname(backup) === beta, notice);
  assert.equal(await sha256(backup), betaSha, "the backup is the file of 0.3.0");
  assert.match(basename(backup), /^capacity-backup-format1-\d{4}-\d{2}-\d{2}\.sqlite$/);
  await closeProject();
  await openProject(beta);
  await openSource("Продукт");
  assert.equal(plain(await evaluate(`${workRow("Личный кабинет: история заказов")}.querySelector('.pp-est').textContent`)), "150 ч");
  assert.deepEqual((await readdir(beta)).filter((name) => name !== ".capacity.lock").sort(), ["capacity-backup-format1-" + basename(backup).slice(24), "capacity.sqlite"].sort());
  await closeProject();
  step("project of 0.3.0: opened unchanged; first save asked, made a byte-identical backup, upgraded; the edit survives reopening");

  assert.deepEqual(consoleErrors, [], "errors in the page console");
  result.passed = true;
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  result.consoleErrors = consoleErrors;
  try { await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2)); } catch { /* the root may not exist */ }
  socket.close();
}
