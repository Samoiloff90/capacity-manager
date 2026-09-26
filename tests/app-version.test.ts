import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ReleaseCheck {
  readAppVersions(root: string): Record<string, string | undefined>;
  checkReleaseTag(tag: string, root: string): string[];
  isPrerelease(tag: string): boolean;
}

const root = fileURLToPath(new URL("..", import.meta.url));
// Plain JS used by CI (scripts/check-release.mjs); loaded by URL so tsc does not need its types.
const release = (): Promise<ReleaseCheck> => import(/* @vite-ignore */ new URL("../scripts/check-release.mjs", import.meta.url).href);

describe("application version and release tags", () => {
  it("is the same semantic version in every file", async () => {
    const versions = (await release()).readAppVersions(root);
    const expected = versions["src-tauri/tauri.conf.json"];
    expect(expected).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(Object.keys(versions)).toHaveLength(6);
    for (const [source, version] of Object.entries(versions)) expect({ source, version }).toEqual({ source, version: expected });
  });

  it("rejects malformed tags and tags that do not match the version", async () => {
    const { checkReleaseTag, readAppVersions } = await release();
    const version = readAppVersions(root)["src-tauri/tauri.conf.json"];
    for (const tag of [version ?? "", `v${version}+build`, `release-${version}`, ""]) {
      expect(checkReleaseTag(tag, root)).toEqual([expect.stringContaining("не в формате")]);
    }
    expect(checkReleaseTag("v99.0.0", root)).toEqual(expect.arrayContaining([
      expect.stringContaining("src-tauri/tauri.conf.json: версия"),
      expect.stringContaining("Нет описания релиза docs/releases/v99.0.0.md")
    ]));
  });

  it("marks 0.x and suffixed versions as pre-releases", async () => {
    const { isPrerelease } = await release();
    expect(isPrerelease("v0.1.0")).toBe(true);
    expect(isPrerelease("v1.0.0-rc.1")).toBe(true);
    expect(isPrerelease("v1.0.0")).toBe(false);
  });
});
