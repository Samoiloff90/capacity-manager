import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// DEC-023: the app has no network features. The CSP (desktop_policy.rs) blocks page
// requests at run time; this test keeps network APIs out of the UI source in the first
// place. Comments are ignored, so explaining an API in a comment is fine.

const root = fileURLToPath(new URL("..", import.meta.url));

/** External URLs the UI may contain: calendar sources shown as plain text. */
const ALLOWED_URLS = new Set([
  "https://mintrud.gov.ru/labour/relationship/351",
  "https://government.ru/docs/all/161028/"
]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["fetch()", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["new Image()", /\bnew\s+Image\s*\(/],
  ["window.open", /\bwindow\s*\.\s*open\s*\(/],
  ["Web Worker", /\bnew\s+Worker\s*\(|\bSharedWorker\b|\bserviceWorker\b|\bimportScripts\b/],
  ["remote import()", /\bimport\s*\(\s*["'`](?:https?:)?\/\//],
  ["iframe", /<iframe\b/i],
  ["srcset", /\bsrcset\b/i],
  ["remote CSS url()", /url\(\s*["']?\s*(?:https?:)?\/\//i],
  ["CSS @import", /@import\b/i],
  ["preconnect/prefetch link", /<link\b[^>]*\brel\s*=\s*["']?(?:preconnect|prefetch|dns-prefetch|prerender)\b/i],
  ["PapaParse download", /\bdownload\s*:\s*true\b/],
  ["network plugin", /@tauri-apps\/plugin-(?:http|shell|opener|websocket|upload|updater)\b/]
];

function files(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/** Source text without comments. */
function withoutComments(path: string, text: string): string {
  if (/\.tsx?$/.test(path)) {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
    return ts.createPrinter({ removeComments: true }).printFile(source);
  }
  if (path.endsWith(".css")) return text.replace(/\/\*[\s\S]*?\*\//g, "");
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function violations(path: string, text: string): string[] {
  const code = withoutComments(path, text);
  const found = FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  for (const url of code.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? []) {
    if (!ALLOWED_URLS.has(url)) found.push(`URL ${url}`);
  }
  return found;
}

describe("no network APIs in the UI (DEC-023)", () => {
  it("finds none in src/ and index.html", () => {
    const sources = [...files(join(root, "src"), [".ts", ".tsx", ".css"]), join(root, "index.html")];
    expect(sources.length).toBeGreaterThan(40);
    const report = sources.flatMap((path) =>
      violations(path, readFileSync(path, "utf8")).map((name) => `${relative(root, path)}: ${name}`));
    expect(report).toEqual([]);
  });

  it("detects network APIs in code but not in comments", () => {
    expect(violations("a.ts", "// fetch(url) is not used\n/* new WebSocket(u) */ const x = 1;")).toEqual([]);
    expect(violations("a.ts", "await fetch('/x');")).toEqual(["fetch()"]);
    expect(violations("a.tsx", "const v = <img srcSet='a' />;")).toEqual(["srcset"]);
    expect(violations("a.css", "/* url(https://x.test/f.woff) */ a { color: red }")).toEqual([]);
    expect(violations("a.css", "a { background: url('//cdn.test/x.png') }")).toEqual(["remote CSS url()"]);
    expect(violations("a.ts", "const u = 'https://example.test/api';")).toEqual(["URL https://example.test/api"]);
    expect(violations("a.ts", "import { fetch as f } from '@tauri-apps/plugin-http';")).toEqual(["network plugin"]);
  });

  it("depends on no Tauri network plugin", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(dependencies.filter((name) => FORBIDDEN.at(-1)![1].test(name))).toEqual([]);
  });
});
