// Development-only positive control for scripts/network-check-windows.ps1.
// Run: node --experimental-websocket scripts/network-check-control.mjs <CDP port> <marker>
// Makes the running app's page send the marker to https://example.com on purpose: CSP is
// bypassed through CDP and the page reloaded, then a POST carries the marker. The NetLog
// summary must find it; if it does not, the method cannot detect a leak.
import assert from "node:assert/strict";

const port = Number(process.argv[2]);
const marker = process.argv[3];
assert(Number.isInteger(port) && port >= 1024 && port < 65536, "CDP port");
assert(marker && marker.length >= 8, "marker");

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((item) => item.type === "page" && item.url === "http://tauri.localhost/");
assert(page, "The Tauri window must be running");
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
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));

try {
  await cdp("Page.enable");
  await cdp("Page.setBypassCSP", { enabled: true });
  await cdp("Page.reload", { ignoreCache: true });
  await sleep(3000);
  const body = JSON.stringify({ control: marker });
  const result = await cdp("Runtime.evaluate", {
    expression: `fetch("https://example.com/capacity-network-control", { method: "POST", mode: "no-cors", body: ${JSON.stringify(body)} })
      .then(() => "sent", (error) => "failed: " + error)`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log(JSON.stringify({ control: result.result.value }));
} finally {
  socket.close();
}
