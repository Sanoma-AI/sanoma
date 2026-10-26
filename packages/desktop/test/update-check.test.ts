import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHECK_EVERY_MS,
  checkDue,
  fetchReleases,
  type GitHubRelease,
  isLater,
  newerRelease,
  readSettings,
  RELEASES_URL,
  writeSettings,
} from "../src/update-check.ts";

const release = (tag: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/Sanoma-AI/sanoma/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
});

describe("newerRelease", () => {
  test("the newest published desktop release later than the app", () => {
    const releases = [release("desktop-v0.2.0"), release("desktop-v0.3.1"), release("desktop-v0.3.0")];
    expect(newerRelease("0.1.0", releases)).toEqual({
      version: "0.3.1",
      url: "https://github.com/Sanoma-AI/sanoma/releases/tag/desktop-v0.3.1",
    });
  });

  test("nothing when the app is that version or later", () => {
    expect(newerRelease("0.2.0", [release("desktop-v0.2.0"), release("desktop-v0.1.9")])).toBeUndefined();
    expect(newerRelease("0.2.0", [])).toBeUndefined();
  });

  test("compares each part as a number", () => {
    expect(newerRelease("0.9.0", [release("desktop-v0.10.0")])?.version).toBe("0.10.0");
    expect(newerRelease("0.10.0", [release("desktop-v0.9.9")])).toBeUndefined();
    expect(newerRelease("1.9.9", [release("desktop-v2.0.0")])?.version).toBe("2.0.0");
  });

  test("skips drafts, prereleases, other tags, other versions and pages off GitHub", () => {
    const releases = [
      release("desktop-v0.5.0", { draft: true }),
      release("desktop-v0.4.0", { prerelease: true }),
      release("v0.9.0"),
      release("sanoma@0.9.0"),
      release("desktop-v0.6.0-beta.1"),
      release("desktop-v0.7"),
      release("desktop-v0.8.0", { html_url: "https://example.com/desktop-v0.8.0" }),
    ];
    expect(newerRelease("0.1.0", releases)).toBeUndefined();
  });

  test("nothing for an app version it cannot read", () => {
    expect(newerRelease("0.1.0-dev", [release("desktop-v0.2.0")])).toBeUndefined();
  });
});

test("isLater", () => {
  expect(isLater("0.2.0", "0.1.0")).toBe(true);
  expect(isLater("0.1.0", "0.1.0")).toBe(false);
  expect(isLater("0.1.0", "0.2.0")).toBe(false);
  expect(isLater("0.2.0-beta", "0.1.0")).toBe(false);
});

const at = (ms: number) => ({ updateCheckedAt: new Date(ms).toISOString() });

test("checkDue: once a day, and again when the clock went back", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  expect(checkDue({}, now)).toBe(true);
  expect(checkDue({ updateCheckedAt: "not a time" }, now)).toBe(true);
  expect(checkDue(at(now - 60_000), now)).toBe(false);
  expect(checkDue(at(now - CHECK_EVERY_MS), now)).toBe(true);
  expect(checkDue(at(now + 60_000), now)).toBe(true);
});

test("settings: missing or broken reads as empty, a write merges", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sanoma-settings-")), "settings.json");
  expect(readSettings(file)).toEqual({});
  writeFileSync(file, "{ not json");
  expect(readSettings(file)).toEqual({});
  writeFileSync(file, JSON.stringify({ other: 1 }));
  writeSettings(file, { updateCheckedAt: "2026-10-25T12:00:00.000Z", newer: { version: "0.2.0", url: "u" } });
  writeSettings(file, { newer: undefined });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ other: 1, updateCheckedAt: "2026-10-25T12:00:00.000Z" });
});

test("fetchReleases asks GitHub's API and fails on an error status", async () => {
  const asked: [string, RequestInit | undefined][] = [];
  const answer = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push([String(url), init]);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  expect(await fetchReleases("0.1.0", answer(200, [release("desktop-v0.2.0")]))).toEqual([release("desktop-v0.2.0")]);
  expect(asked[0]![0]).toBe(RELEASES_URL);
  expect(asked[0]![1]?.headers).toMatchObject({ "User-Agent": "Sanoma/0.1.0" });
  await expect(fetchReleases("0.1.0", answer(403, { message: "rate limited" }))).rejects.toThrow(/403/);
});
