#!/usr/bin/env node
// Release preflight: the tag vX.Y.Z must match the application version in every file
// that carries it, and docs/releases/<tag>.md must hold the release notes.
// Usage: node scripts/check-release.mjs v0.1.0   (exits 1 and prints the problems)
// Also imported by tests/app-version.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Every place the application version lives. */
export function readAppVersions(root) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const lock = JSON.parse(read("package-lock.json"));
  return {
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
    "package.json": JSON.parse(read("package.json")).version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages?.[""]?.version,
    "src-tauri/Cargo.toml": /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1],
    "src-tauri/Cargo.lock": /^name = "capacity-planner"\r?\nversion = "([^"]+)"/m.exec(read("src-tauri/Cargo.lock"))?.[1]
  };
}

/** Problems that block releasing `tag`; empty when the release may proceed. */
export function checkReleaseTag(tag, root) {
  const problems = [];
  const match = TAG_PATTERN.exec(tag ?? "");
  if (!match) {
    problems.push(`Тег «${tag ?? ""}» не в формате vX.Y.Z или vX.Y.Z-суффикс (знак + не допускается).`);
    return problems;
  }
  const version = match[1];
  for (const [file, found] of Object.entries(readAppVersions(root))) {
    if (found !== version) problems.push(`${file}: версия ${found ?? "не найдена"}, а тег — ${version}.`);
  }
  if (!existsSync(join(root, "docs", "releases", `${tag}.md`))) problems.push(`Нет описания релиза docs/releases/${tag}.md.`);
  return problems;
}

/** Versions 0.x and versions with a suffix are published as pre-releases. */
export function isPrerelease(tag) {
  const version = TAG_PATTERN.exec(tag)?.[1] ?? "";
  return version.startsWith("0.") || version.includes("-");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const problems = checkReleaseTag(tag, root);
  if (problems.length) {
    for (const problem of problems) console.log(`::error title=Release ${tag ?? ""}::${problem}`);
    process.exit(1);
  }
  console.log(`Тег ${tag} соответствует версии приложения; ${isPrerelease(tag) ? "пробная версия (pre-release)" : "обычный релиз"}.`);
}
