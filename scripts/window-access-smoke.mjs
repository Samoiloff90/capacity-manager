// Development-only check of Q-001 (DEC-055) on the built EXE: what a script in the real WebView2
// can do through the commands of the window. Creates only temporary projects with fictional names
// under src-tauri/target and touches no other files. Windows: the folder is chosen in the native
// dialog (native-folder-dialog.mjs).
// Run: node --experimental-websocket scripts/window-access-smoke.mjs <local CDP port>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inFolderDialog } from "./native-folder-dialog.mjs";

const port = Number(process.argv[2] ?? 19323);
assert(Number.isInteger(port) && port >= 1024 && port < 65536);
const root = resolve("src-tauri/target", `window-access-smoke-${Date.now()}`);
const folderA = resolve(root, "Проект А");
const folderB = resolve(root, "Проект Б");
const copies = resolve(root, "копии");
const fresh = resolve(root, "новая");
for (const folder of [folderA, folderB, copies, fresh]) await mkdir(folder, { recursive: true });

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
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function call(command, args) {
  const expression = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error) }))`;
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function choose(purpose, folder) {
  const choosing = inFolderDialog(purpose, folder);
  const picked = await call("project_pick_folder", { purpose });
  await choosing;
  assert(picked.ok, picked.error);
  assert.equal(picked.value?.toLowerCase(), folder.toLowerCase());
  return picked.value;
}
const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const refusedSql = /not authorized|authorization denied|prohibited|too many attached/i;
const notChosen = /выбрать в окне выбора папки/;
const report = { root, refused: [], allowed: [] };

// Project B: created through a choice, closed. It plays "another database on the computer".
const pathB = await choose("create", folderB);
const sessionB = await call("project_create", { folderPath: pathB, name: "Проект Б" });
assert(sessionB.ok, sessionB.error);
assert((await call("project_close", { sessionKey: sessionB.value.sessionKey })).ok);
const fileB = resolve(folderB, "capacity.sqlite");
const beforeB = { sha: await sha(fileB), entries: (await readdir(folderB)).sort() };

// Path 2: open and create need the folder the user has just chosen for the same purpose.
const openB = await call("project_open", { folderPath: pathB });
assert(!openB.ok && notChosen.test(openB.error), JSON.stringify(openB));
const createFresh = await call("project_create", { folderPath: fresh, name: "Чужая" });
assert(!createFresh.ok && notChosen.test(createFresh.error), JSON.stringify(createFresh));
const pickedForOpen = await choose("open", folderB);
const wrongPurpose = await call("project_create", { folderPath: pickedForOpen, name: "Не та цель" });
assert(!wrongPurpose.ok && notChosen.test(wrongPurpose.error), JSON.stringify(wrongPurpose));
const usedChoice = await call("project_open", { folderPath: pickedForOpen });
assert(!usedChoice.ok && notChosen.test(usedChoice.error), "a choice serves once");
report.refused.push("project_open without a choice", "project_create without a choice", "wrong purpose", "second use of a choice");
const dialogPermission = await call("plugin:dialog|open", { options: { directory: true } });
assert(!dialogPermission.ok, "the window has no dialog permission");
report.refused.push(`plugin:dialog|open: ${dialogPermission.error.slice(0, 80)}`);

// Project A: the chosen project. Path 1: only the statements of the application.
const pathA = await choose("create", folderA);
const sessionA = await call("project_create", { folderPath: pathA, name: "Проект А" });
assert(sessionA.ok, sessionA.error);
const db = sessionA.value.sessionKey;
const sqlB = fileB.replaceAll("'", "''");
const forbidden = [
  ["execute", `ATTACH DATABASE '${sqlB}' AS other`],
  ["execute", `VACUUM INTO '${resolve(copies, "copy.sqlite").replaceAll("'", "''")}'`],
  ["execute", "VACUUM"],
  ["execute", "CREATE TABLE evil (x)"],
  ["execute", "CREATE TEMP TABLE evil (x)"],
  ["execute", "CREATE INDEX evil ON quarter_plans (year)"],
  ["execute", "DROP TABLE quarter_plans"],
  ["execute", "ALTER TABLE quarter_plans ADD COLUMN evil TEXT"],
  ["execute", "PRAGMA user_version = 99"],
  ["execute", "PRAGMA journal_mode = DELETE"],
  ["execute", "DELETE FROM quarter_plans"],
  ["execute", "UPDATE project_meta SET project_id = 'evil'"],
  ["execute", "SAVEPOINT evil"],
  ["select", "SELECT sql FROM sqlite_master"],
  ["select", "PRAGMA database_list"],
  ["select", "SELECT load_extension('evil')"],
];
for (const [kind, query] of forbidden) {
  const result = await call(`plugin:sql|${kind}`, { db, query, values: [] });
  assert(!result.ok && refusedSql.test(result.error), `${query}: ${JSON.stringify(result)}`);
  report.refused.push(`${query.slice(0, 60)} → ${result.error.slice(0, 70)}`);
}
const rename = await call("plugin:sql|execute", { db, query: "UPDATE project_meta SET name = $1", values: ["Проект А (переименован)"] });
assert(rename.ok, rename.error);
const name = await call("plugin:sql|select", { db, query: "SELECT name FROM project_meta", values: [] });
assert(name.ok && name.value[0].name === "Проект А (переименован)", JSON.stringify(name));
const plans = await call("plugin:sql|select", { db, query: "SELECT plan_id FROM quarter_plans", values: [] });
assert(plans.ok, plans.error);
report.allowed.push("UPDATE project_meta SET name", "SELECT name FROM project_meta", "SELECT plan_id FROM quarter_plans");

// Nothing outside changed, no copy, no leftovers; the chosen project still opens.
assert.equal(await sha(fileB), beforeB.sha, "project B unchanged");
assert.deepEqual((await readdir(folderB)).sort(), beforeB.entries);
assert.deepEqual(await readdir(copies), [], "no copy written");
assert.deepEqual(await readdir(fresh), [], "nothing created without a choice");
report.folderA = (await readdir(folderA)).sort();
assert((await call("project_close", { sessionKey: db })).ok);
const reopenPath = await choose("open", folderA);
const reopened = await call("project_open", { folderPath: reopenPath });
assert(reopened.ok, reopened.error);
assert.equal(reopened.value.name, "Проект А (переименован)");
assert((await call("project_close", { sessionKey: reopened.value.sessionKey })).ok);
report.reopened = reopened.value.name;
report.passed = true;
await writeFile(resolve(root, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
socket.close();
