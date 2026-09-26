import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

interface Hit { marker: string; variant: string; place: string; remote: string; class: string }
interface Summary {
  truncated: boolean;
  captureModeHasBytes: boolean;
  hosts: Array<{ host: string; class: string }>;
  urls: Array<{ url: string; class: string }>;
  markerHits: Hit[];
  externalMarkerHits: Hit[];
}
interface NetLogSummary { summarise(text: string, markers: string[]): Summary }

// Plain JS used by the network check (scripts/netlog-summary.mjs); loaded by URL for tsc.
const load = (): Promise<NetLogSummary> => import(/* @vite-ignore */ new URL("../scripts/netlog-summary.mjs", import.meta.url).href);

const ascii = "zqxnet7f3a9c";
const cyrillic = "маркерсети5821";
const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString("base64");
const types = { TCP_CONNECT: 1, SSL_SOCKET_BYTES_SENT: 2, URL_REQUEST_START_JOB: 3, SOCKET_BYTES_SENT: 4 };

function netlog(events: Array<{ type: number; source: number; params: Record<string, unknown> }>): string {
  const lines = events.map((event) => JSON.stringify({ type: event.type, source: { id: event.source, type: 1 }, phase: 0, time: "1", params: event.params }));
  return `{"constants":${JSON.stringify({ logEventTypes: types, logSourceType: { SOCKET: 1 } })},\n"events": [\n${lines.join(",\n")}\n]}`;
}

describe("NetLog summary for the network check", () => {
  it("finds markers in sent bytes split across chunks, in base64, UTF-16 and gzip bodies", async () => {
    const request = Buffer.from(`POST /collect HTTP/1.1\r\nHost: example.com\r\n\r\nname=${ascii}`);
    const text = netlog([
      { type: types.TCP_CONNECT, source: 10, params: { address: "93.184.215.14:443" } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 10, params: { byte_count: 50, bytes: b64(request.subarray(0, 50)) } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 10, params: { byte_count: request.length - 50, bytes: b64(request.subarray(50)) } },
      { type: types.TCP_CONNECT, source: 11, params: { address: "203.0.113.7:443" } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 11, params: { bytes: b64(`payload=${b64(Buffer.concat([Buffer.from("x"), Buffer.from(cyrillic)]))}`) } },
      { type: types.TCP_CONNECT, source: 12, params: { address: "198.51.100.2:443" } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 12, params: { bytes: b64(Buffer.from(`t=${cyrillic}`, "utf16le")) } },
      { type: types.TCP_CONNECT, source: 13, params: { address: "198.51.100.3:443" } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 13, params: { bytes: b64(Buffer.concat([
        Buffer.from("POST / HTTP/1.1\r\nContent-Encoding: gzip\r\n\r\n"), gzipSync(Buffer.from(`{"team":"${ascii}"}`))])) } },
      { type: types.URL_REQUEST_START_JOB, source: 20, params: { method: "POST", url: "https://example.com/collect?secret=1" } }
    ]);
    const summary = (await load()).summarise(text, [ascii, cyrillic]);
    expect(summary.captureModeHasBytes).toBe(true);
    const found = summary.externalMarkerHits.map((hit) => `${hit.remote} ${hit.marker} ${hit.variant} ${hit.place}`);
    expect(found).toEqual(expect.arrayContaining([
      `93.184.215.14:443 ${ascii} utf-8 sent bytes`,
      `203.0.113.7:443 ${cyrillic} base64 (offset 1) sent bytes`,
      `198.51.100.2:443 ${cyrillic} utf-16le sent bytes`,
      `198.51.100.3:443 ${ascii} utf-8 decompressed body`
    ]));
    // URLs are listed without their query string.
    expect(summary.urls).toEqual([{ url: "POST https://example.com/collect", count: 1, class: "external" }]);
  });

  it("classifies loopback traffic as local and reports a clean log as clean", async () => {
    const text = netlog([
      { type: types.TCP_CONNECT, source: 30, params: { address: "127.0.0.1:1420" } },
      { type: types.SOCKET_BYTES_SENT, source: 30, params: { bytes: b64(`GET /?t=${ascii} HTTP/1.1`) } },
      { type: types.TCP_CONNECT, source: 31, params: { address: "13.107.42.14:443" } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 31, params: { bytes: b64("GET /config HTTP/1.1\r\nHost: config.edge.skype.com\r\n\r\n") } }
    ]);
    const summary = (await load()).summarise(text, [ascii, cyrillic]);
    expect(summary.markerHits.map((hit) => hit.class)).toEqual(["local"]);
    expect(summary.externalMarkerHits).toEqual([]);
  });

  it("reads a log cut off before the browser exited", async () => {
    const full = netlog([
      { type: types.TCP_CONNECT, source: 40, params: { address: "93.184.215.14:443" } },
      { type: types.SSL_SOCKET_BYTES_SENT, source: 40, params: { bytes: b64(`q=${ascii}`) } },
      { type: types.TCP_CONNECT, source: 41, params: { address: "93.184.215.15:443" } }
    ]);
    const cut = full.slice(0, full.lastIndexOf("{\"type\"") + 20);
    const summary = (await load()).summarise(cut, [ascii]);
    expect(summary.truncated).toBe(true);
    expect(summary.externalMarkerHits).toHaveLength(1);
  });
});
