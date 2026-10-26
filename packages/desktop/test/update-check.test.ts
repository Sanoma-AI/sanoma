import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  CHECK_EVERY_MS,
  checkDue,
  fetchReleases,
  type GitHubRelease,
  newerRelease,
  readSettings,
  RELEASES_URL,
  runCheck,
  savedNewer,
  shouldNotify,
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

test("savedNewer: the last check's release while it is later than the app", () => {
  const newer = { version: "0.2.0", url: "https://github.com/Sanoma-AI/sanoma/releases/tag/desktop-v0.2.0" };
  expect(savedNewer({ newer }, "0.1.0")).toEqual(newer);
  expect(savedNewer({ newer }, "0.2.0")).toBeUndefined();
  expect(savedNewer({ newer }, "0.3.0")).toBeUndefined();
  expect(savedNewer({}, "0.1.0")).toBeUndefined();
  expect(savedNewer({ newer: { version: 2 } } as never, "0.1.0")).toBeUndefined();
  expect(
    savedNewer({ newer: { version: "0.2.0", url: "file:///Applications/Calculator.app" } }, "0.1.0"),
  ).toBeUndefined();
});

test("shouldNotify: once per version", () => {
  const found = { version: "0.2.0", url: "u" };
  expect(shouldNotify({}, found)).toBe(true);
  expect(shouldNotify({ newer: found }, found)).toBe(false);
  expect(shouldNotify({ newer: { version: "0.1.5", url: "u" } }, found)).toBe(true);
  expect(shouldNotify({ newer: found }, undefined)).toBe(false);
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

test("settings: missing, broken or not an object reads as empty", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sanoma-settings-")), "settings.json");
  expect(readSettings(file)).toEqual({});
  for (const text of ["{ not json", "null", "[]", "3"]) {
    writeFileSync(file, text);
    expect(readSettings(file)).toEqual({});
  }
  writeSettings(file, { updateCheckedAt: "2026-10-25T12:00:00.000Z", newer: undefined });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ updateCheckedAt: "2026-10-25T12:00:00.000Z" });
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

const github = (releases: GitHubRelease[]) => (async () => Response.json(releases)) as unknown as typeof fetch;
const setup = () => join(mkdtempSync(join(tmpdir(), "sanoma-check-")), "settings.json");

describe("runCheck", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");

  test("saves the time and the find, notifies once, then waits a day unless asked", async () => {
    const file = setup();
    writeFileSync(file, JSON.stringify({ other: 1 }));
    const fetchImpl = github([release("desktop-v0.2.0")]);
    const first = await runCheck({ file, current: "0.1.0", asked: false, now, fetchImpl });
    expect(first).toEqual({ found: { version: "0.2.0", url: release("desktop-v0.2.0").html_url }, notify: true });
    expect(readSettings(file)).toEqual({ other: 1, updateCheckedAt: new Date(now).toISOString(), newer: first!.found });
    expect(await runCheck({ file, current: "0.1.0", asked: false, now: now + 60_000, fetchImpl })).toBeUndefined();
    expect(await runCheck({ file, current: "0.1.0", asked: true, now: now + 60_000, fetchImpl })).toMatchObject({
      notify: false,
    });
    const later = await runCheck({
      file,
      current: "0.1.0",
      asked: false,
      now: now + CHECK_EVERY_MS + 60_000,
      fetchImpl,
    });
    expect(later).toMatchObject({ found: { version: "0.2.0" }, notify: false });
  });

  test("no notification when the settings cannot be saved", async () => {
    // The settings file's folder is a file: nothing can be written there.
    const blocker = setup();
    writeFileSync(blocker, "");
    const file = join(blocker, "settings.json");
    const fetchImpl = github([release("desktop-v0.2.0")]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCheck({ file, current: "0.1.0", asked: false, now, fetchImpl })).toMatchObject({ notify: false });
  });

  test("a failed answer throws and saves nothing, so the next start checks again", async () => {
    const file = setup();
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(runCheck({ file, current: "0.1.0", asked: false, now, fetchImpl })).rejects.toThrow(/500/);
    expect(readSettings(file)).toEqual({});
  });
});
