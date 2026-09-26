#!/usr/bin/env node
// Development-only: summarises a Chromium/WebView2 NetLog (--net-log-capture-mode=Everything)
// for the network check (DEC-023, scripts/network-check-windows.ps1).
// Run: node scripts/netlog-summary.mjs <netlog.json> --markers "m1,m2" [--out summary.json]
// Prints hosts, URLs without query strings, bytes sent per remote endpoint and every place
// a marker occurs in sent data or in event parameters. The raw log never leaves the machine;
// the summary holds no request contents apart from a short context around marker hits.
import { readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Parses a NetLog, tolerating a file cut off when the browser did not exit cleanly. */
export function parseNetLog(text) {
  try {
    return { log: JSON.parse(text), truncated: false };
  } catch {
    const events = text.indexOf('"events"');
    const lastEvent = text.lastIndexOf("},");
    if (events < 0 || lastEvent < events) throw new Error("NetLog is not readable");
    return { log: JSON.parse(`${text.slice(0, lastEvent + 1)}]}`), truncated: true };
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "ipc.localhost", "tauri.localhost"]);
const TEST_PROBE_HOSTS = new Set(["example.invalid"]);

function hostOf(endpoint) {
  if (!endpoint) return "";
  try { return new URL(endpoint).hostname.replace(/^\[|\]$/g, ""); } catch { /* not a URL */ }
  const bracket = /^\[([^\]]+)\]:\d+$/.exec(endpoint);
  if (bracket) return bracket[1];
  const lastColon = endpoint.lastIndexOf(":");
  return lastColon > 0 && endpoint.indexOf(":") === lastColon ? endpoint.slice(0, lastColon) : endpoint;
}

export function classify(endpoint) {
  const host = hostOf(endpoint).toLowerCase();
  if (!host) return "unknown";
  if (LOCAL_HOSTS.has(host) || host.startsWith("127.") || host.endsWith(".localhost")) return "local";
  if (TEST_PROBE_HOSTS.has(host)) return "test-probe";
  return "external";
}

/** Byte patterns a marker can take in sent data. */
export function markerVariants(marker) {
  const utf8 = Buffer.from(marker, "utf8");
  const variants = [
    ["utf-8", utf8],
    ["utf-16le", Buffer.from(marker, "utf16le")],
    ["percent-encoded", Buffer.from(encodeURIComponent(marker), "latin1")],
    ["percent-encoded (lower case)", Buffer.from(encodeURIComponent(marker).replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()), "latin1")],
    ["form-encoded", Buffer.from(encodeURIComponent(marker).replace(/%20/g, "+"), "latin1")],
    ["json \\u escapes", Buffer.from(JSON.stringify(marker).slice(1, -1).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), "latin1")],
    ["json \\u escapes (upper case)", Buffer.from(marker.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`), "latin1")]
  ];
  // base64 at the three possible alignments: only the characters that depend on the marker alone.
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), utf8]).toString("base64");
    const start = offset === 0 ? 0 : offset === 1 ? 2 : 3;
    const end = Math.floor((offset + utf8.length) / 3) * 4;
    const needle = encoded.slice(start, end);
    if (needle.length >= 8) variants.push([`base64 (offset ${offset})`, Buffer.from(needle, "latin1")]);
  }
  // An ASCII marker looks the same in several encodings: keep the first name per pattern.
  const seen = new Set();
  return variants.filter(([, bytes]) => {
    const key = bytes.toString("hex");
    if (!bytes.length || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Request bodies that declare a content encoding are decompressed too (best effort). */
function decompressedBodies(bytes) {
  const text = bytes.toString("latin1");
  const bodies = [];
  const pattern = /content-encoding:\s*(gzip|deflate|br)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const bodyStart = text.indexOf("\r\n\r\n", match.index);
    if (bodyStart < 0) continue;
    const body = bytes.subarray(bodyStart + 4);
    const decoders = match[1].toLowerCase() === "gzip" ? [gunzipSync] : match[1].toLowerCase() === "br" ? [brotliDecompressSync] : [inflateSync, inflateRawSync];
    for (const decode of decoders) {
      try { bodies.push(decode(body)); break; } catch { /* truncated or not compressed */ }
    }
  }
  return bodies;
}

function findAll(haystack, needle) {
  const positions = [];
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) positions.push(index);
  return positions;
}

function context(bytes, position, length) {
  return bytes.subarray(Math.max(0, position - 24), position + length + 24).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
}

export function summarise(text, markers) {
  const { log, truncated } = parseNetLog(text);
  const constants = log.constants ?? {};
  const eventName = Object.fromEntries(Object.entries(constants.logEventTypes ?? {}).map(([name, id]) => [id, name]));
  const sourceName = Object.fromEntries(Object.entries(constants.logSourceType ?? {}).map(([name, id]) => [id, name]));
  const sources = new Map();
  const source = (id, type) => {
    if (!sources.has(id)) sources.set(id, { id, type: sourceName[type] ?? String(type), remotes: new Set(), hosts: new Set(), sent: [], received: 0, outboundParams: [] });
    return sources.get(id);
  };
  const hosts = new Set();
  const urls = new Map();
  for (const event of log.events ?? []) {
    const name = eventName[event.type] ?? String(event.type);
    const item = source(event.source?.id, event.source?.type);
    const params = event.params ?? {};
    for (const key of ["address", "remote_address", "peer_address"]) if (typeof params[key] === "string") item.remotes.add(params[key]);
    if (Array.isArray(params.address_list)) for (const address of params.address_list) item.remotes.add(address);
    if (typeof params.host === "string") { item.hosts.add(params.host); hosts.add(hostOf(params.host) || params.host); }
    if (typeof params.url === "string" && /^https?:|^wss?:/.test(params.url)) {
      const url = new URL(params.url);
      item.hosts.add(url.host);
      hosts.add(url.hostname);
      const key = `${params.method ?? ""} ${url.origin}${url.pathname}`.trim();
      urls.set(key, (urls.get(key) ?? 0) + 1);
    }
    if (typeof params.bytes === "string" && /BYTES_SENT/.test(name)) item.sent.push(Buffer.from(params.bytes, "base64"));
    else if (typeof params.byte_count === "number" && /BYTES_RECEIVED/.test(name)) item.received += params.byte_count;
    // Raw "bytes" are searched decoded above; the rest (URLs, headers, hosts) as text.
    if (/SEND|REQUEST|START_JOB|HEADERS|UPLOAD/.test(name)) {
      const { bytes: _bytes, ...rest } = params;
      item.outboundParams.push([name, JSON.stringify(rest)]);
    }
  }

  const variants = markers.map((marker) => [marker, markerVariants(marker)]);
  const hits = [];
  const endpoints = new Map();
  for (const item of sources.values()) {
    const remote = [...item.remotes][0] ?? [...item.hosts][0] ?? "";
    const where = classify(remote);
    const sentBytes = Buffer.concat(item.sent);
    if (sentBytes.length || item.remotes.size) {
      const key = remote || `(source ${item.id})`;
      const entry = endpoints.get(key) ?? { endpoint: key, class: where, sources: 0, bytesSent: 0 };
      entry.sources += 1;
      entry.bytesSent += sentBytes.length;
      endpoints.set(key, entry);
    }
    const haystacks = [["sent bytes", sentBytes], ...decompressedBodies(sentBytes).map((body) => ["decompressed body", body]),
      ...item.outboundParams.map(([event, json]) => [`params of ${event}`, Buffer.from(json, "utf8")])];
    for (const [marker, forms] of variants) {
      for (const [place, bytes] of haystacks) {
        for (const [variant, needle] of forms) {
          for (const position of findAll(bytes, needle)) {
            hits.push({ marker, variant, place, sourceId: item.id, sourceType: item.type, remote, class: where,
              context: context(bytes, position, needle.length) });
          }
        }
      }
    }
  }
  const unique = new Map(hits.map((hit) => [`${hit.marker}|${hit.sourceId}|${hit.place}|${hit.variant}`, hit]));
  return {
    truncated,
    events: (log.events ?? []).length,
    captureModeHasBytes: [...sources.values()].some((item) => item.sent.length > 0),
    hosts: [...hosts].filter(Boolean).sort().map((host) => ({ host, class: classify(host) })),
    urls: [...urls].sort().map(([url, count]) => ({ url, count, class: classify(url.split(" ").pop()) })),
    endpoints: [...endpoints.values()].sort((a, b) => b.bytesSent - a.bytesSent),
    markerHits: [...unique.values()],
    externalMarkerHits: [...unique.values()].filter((hit) => hit.class === "external" || hit.class === "unknown")
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  const option = (name) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const markers = (option("--markers") ?? "").split(",").map((marker) => marker.trim()).filter(Boolean);
  if (!file || !markers.length) {
    console.error('Usage: node scripts/netlog-summary.mjs <netlog.json> --markers "m1,m2" [--out summary.json]');
    process.exit(2);
  }
  const summary = summarise(readFileSync(file, "utf8"), markers);
  const out = option("--out");
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    truncated: summary.truncated, events: summary.events, captureModeHasBytes: summary.captureModeHasBytes,
    externalHosts: summary.hosts.filter((host) => host.class === "external").map((host) => host.host),
    markerHits: summary.markerHits.map(({ marker, class: where, remote, place, variant }) => ({ marker, class: where, remote, place, variant }))
  }, null, 2));
}
