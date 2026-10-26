import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type Company,
  companyName,
  partitionOf,
  portFor,
  readCompanies,
  remember,
  slugOf,
  writeCompanies,
} from "../src/companies.ts";
import { eventOf, listeningUrlOf } from "../src/events.ts";
import { launch, launcherEnv, launcherOf, type Stream, USAGE_EXIT } from "../src/launcher.ts";
import { linkTarget } from "../src/links.ts";
import { hidePasswords, openLog, TAIL_LINES } from "../src/logs.ts";
import { folderArgument, syncedFolderWarning } from "../src/places.ts";
import { startSession } from "../src/session.ts";
import { shims, writeShims } from "../src/shims.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "sanoma-desktop-"));

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until `check` holds, up to `ms`. */
async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function fakeLaunch(mode: string, port: number, extra: { killAfterMs?: number; stdin?: string } = {}) {
  const lines: [Stream, string][] = [];
  const env = { ...launcherEnv(process.env, "/shims", port), FAKE_MODE: mode, FAKE_STDIN: extra.stdin ?? "" };
  const launched = launch({
    node: process.execPath,
    cli: fixture("launcher.mjs"),
    cwd: temp(),
    port,
    env,
    pollMs: 50,
    killAfterMs: extra.killAfterMs,
    onLine: (stream, line) => lines.push([stream, line]),
  });
  const pids = async () => {
    await until(() => lines.some(([, l]) => l.startsWith("pids ")));
    return lines
      .find(([, l]) => l.startsWith("pids "))![1]
      .split(" ")
      .slice(1)
      .map(Number);
  };
  return { launched, lines, pids };
}

describe("launcher events", () => {
  test("reads the ready and error events, and nothing else", () => {
    expect(eventOf('{"sanoma":1,"event":"ready","url":"http://127.0.0.1:3100","sites":{}}')).toEqual({
      event: "ready",
      url: "http://127.0.0.1:3100",
    });
    expect(eventOf('{"sanoma":1,"event":"error","message":"no config"}')).toEqual({
      event: "error",
      message: "no config",
    });
    expect(eventOf('{"sanoma":1,"event":"database","url":"postgresql://…"}')).toBeUndefined();
    expect(eventOf('{"sanoma":1,"event":"ready"}')).toBeUndefined();
    expect(eventOf('{"event":"ready","url":"http://x"}')).toBeUndefined();
    expect(eventOf("{not json")).toBeUndefined();
    expect(eventOf("acme running call")).toBeUndefined();
  });

  test("reads where the app is from the line a launcher without events prints", () => {
    expect(listeningUrlOf("acme at http://127.0.0.1:3100; ctrl-c to stop")).toBe("http://127.0.0.1:3100");
    expect(listeningUrlOf("acme running publish-post; ctrl-c to stop")).toBeUndefined();
    expect(listeningUrlOf("www: http://www.localhost:3100")).toBeUndefined();
  });
});

describe("the process manager", () => {
  test("is ready on the ready event", async () => {
    const port = await freePort();
    const { launched } = fakeLaunch("event", port);
    await expect(launched.ready).resolves.toBe(`http://localhost:${port}`);
    await launched.stop();
  });

  test("is ready on the launcher's human line", async () => {
    const port = await freePort();
    const { launched } = fakeLaunch("line", port);
    await expect(launched.ready).resolves.toBe(`http://localhost:${port}`);
    await launched.stop();
  });

  test("falls back to polling /healthz on the port", async () => {
    const port = await freePort();
    const { launched, lines } = fakeLaunch("silent", port);
    await expect(launched.ready).resolves.toBe(`http://127.0.0.1:${port}`);
    expect(lines).toContainEqual(["stderr", "listening"]);
    await launched.stop();
  });

  test("gives the environment: events on, the port, the shims first; the port wins over .env", async () => {
    const port = await freePort();
    const lines: [Stream, string][] = [];
    const cwd = temp();
    writeFileSync(join(cwd, ".env"), "SANOMA_APP_PORT=3000\n");
    const launched = launch({
      node: process.execPath,
      cli: fixture("launcher.mjs"),
      cwd,
      port,
      env: { ...launcherEnv({ PATH: "/usr/bin:/bin" }, "/shims", port), FAKE_MODE: "event" },
      onLine: (stream, line) => lines.push([stream, line]),
    });
    await launched.ready;
    expect(lines).toContainEqual(["stdout", `env ${port} 1 /shims`]);
    await launched.stop();
  });

  test("rejects ready with the error event's message when it exits first", async () => {
    const port = await freePort();
    const { launched } = fakeLaunch("fail", port);
    await expect(launched.ready).rejects.toThrow("sanoma.config.ts: no workflows");
    await expect(launched.exited).resolves.toEqual({
      code: USAGE_EXIT,
      signal: null,
      error: "sanoma.config.ts: no workflows",
    });
  });

  test("stop closes stdin and takes the whole process group down", async () => {
    const port = await freePort();
    const stdin = join(temp(), "stdin");
    const { launched, pids } = fakeLaunch("event", port, { stdin });
    await launched.ready;
    const [launcher, grandchild] = await pids();
    expect(alive(launcher!) && alive(grandchild!)).toBe(true);
    await launched.stop();
    await until(() => !alive(grandchild!));
    expect(alive(launcher!)).toBe(false);
    expect(readFileSync(stdin, "utf8")).toBe("closed\n");
    await expect(launched.exited).resolves.toEqual({ code: 143, signal: null });
  });

  test("a launcher that dies takes what it left in its group with it", async () => {
    const port = await freePort();
    const { launched, pids } = fakeLaunch("crash", port);
    const [, grandchild] = await pids();
    await expect(launched.ready).rejects.toThrow("exited with code 1");
    await expect(launched.exited).resolves.toEqual({ code: 1, signal: null });
    expect(alive(grandchild!)).toBe(false);
  });

  test("stop kills a launcher that ignores SIGTERM", async () => {
    const port = await freePort();
    const { launched, lines } = fakeLaunch("stubborn", port, { killAfterMs: 300 });
    await launched.ready;
    await launched.stop();
    expect(lines).toContainEqual(["stdout", "ignoring SIGTERM"]);
    await expect(launched.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  test("finds the launcher from the install's package.json", () => {
    const repo = temp();
    mkdirSync(join(repo, "node_modules", "sanoma"), { recursive: true });
    expect(() => launcherOf(repo)).toThrow("has no node_modules/sanoma");
    writeFileSync(
      join(repo, "node_modules", "sanoma", "package.json"),
      JSON.stringify({ bin: { sanoma: "./dist/cli.js" } }),
    );
    expect(launcherOf(repo)).toBe(join(repo, "node_modules", "sanoma", "dist", "cli.js"));
  });

  test("the environment's PATH: shims, the system's, then Homebrew's, once each", () => {
    const env = launcherEnv({ PATH: "/usr/bin:/opt/homebrew/bin", HOME: "/h" }, "/s/bin", 3100);
    expect(env).toMatchObject({ HOME: "/h", SANOMA_EVENTS: "1", SANOMA_APP_PORT: "3100" });
    expect(env.PATH).toBe("/s/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin");
  });
});

/** A company folder whose installed sanoma is the fake launcher. */
function company() {
  const repo = temp();
  mkdirSync(join(repo, "node_modules", "sanoma"), { recursive: true });
  cpSync(fixture("launcher.mjs"), join(repo, "node_modules", "sanoma", "cli.mjs"));
  writeFileSync(join(repo, "node_modules", "sanoma", "package.json"), JSON.stringify({ bin: { sanoma: "cli.mjs" } }));
  return repo;
}

async function run(repo: string, env: NodeJS.ProcessEnv) {
  const bin = join(temp(), "bin");
  const progress: string[] = [];
  const lines: string[] = [];
  const session = startSession({
    repo,
    port: await freePort(),
    node: process.execPath,
    pnpm: fixture("pnpm.mjs"),
    bin,
    env: { ...process.env, FAKE_MODE: "event", ...env },
    pollMs: 50,
    onLine: (_stream, line) => lines.push(line),
    onProgress: (step) => progress.push(step),
  });
  return { session, progress, lines, bin };
}

describe("a session", () => {
  test("installs with the staged pnpm through its shim, then starts the company's own launcher", async () => {
    const repo = company();
    const calls = join(temp(), "calls");
    const { session, progress, bin } = await run(repo, { FAKE_PNPM_LOG: calls });
    await session.ready;
    expect(readFileSync(calls, "utf8")).toBe("install --prefer-offline\n");
    expect(progress).toEqual(["Installing packages", "Starting the company"]);
    expect(existsSync(join(bin, "node")) && existsSync(join(bin, "pnpm"))).toBe(true);
    await session.stop();
    await expect(session.ended).resolves.toMatchObject({ code: 143 });
  });

  test("starts anyway when the install fails but sanoma is installed", async () => {
    const { session, lines } = await run(company(), { FAKE_PNPM_EXIT: "1" });
    await session.ready;
    expect(lines).toContain("warning: pnpm install failed; starting with the packages already installed");
    await session.stop();
  });

  test("ends with an error when the install fails and sanoma is not installed", async () => {
    const { session } = await run(temp(), { FAKE_PNPM_EXIT: "1" });
    await expect(session.ready).rejects.toThrow("pnpm install failed");
    await expect(session.ended).resolves.toMatchObject({ error: expect.stringContaining("pnpm install failed") });
  });
});

describe("the shims", () => {
  test("run the shipped Node, and pnpm's script with it, quoting their paths", () => {
    expect(shims("/Apps/Sanoma.app/node/node", "/r/pnpm/bin/pnpm.mjs")).toEqual({
      node: `#!/bin/sh\nexec '/Apps/Sanoma.app/node/node' "$@"\n`,
      pnpm: `#!/bin/sh\nexec '/Apps/Sanoma.app/node/node' '/r/pnpm/bin/pnpm.mjs' "$@"\n`,
    });
    expect(shims("/it's/node", "p").node).toBe(`#!/bin/sh\nexec '/it'\\''s/node' "$@"\n`);
  });

  test("are executable and run", () => {
    const dir = join(temp(), "bin");
    writeShims(dir, process.execPath, fixture("pnpm.mjs"));
    expect(execFileSync(join(dir, "node"), ["-p", "1 + 1"], { encoding: "utf8" })).toBe("2\n");
    expect(execFileSync(join(dir, "pnpm"), ["install"], { encoding: "utf8" })).toBe("Done in 0.1s\n");
  });
});

const at = (path: string, port: number, lastOpened: string): Company => ({ path, name: path, port, lastOpened });

describe("companies.json", () => {
  test("remembers each company once, most recently opened first, and survives a bad file", () => {
    const file = join(temp(), "companies.json");
    expect(readCompanies(file)).toEqual([]);
    let list = remember([], at("/a", 3100, "2026-10-01T00:00:00Z"));
    list = remember(list, at("/b", 3101, "2026-10-02T00:00:00Z"));
    list = remember(list, at("/a", 3100, "2026-10-03T00:00:00Z"));
    writeCompanies(file, list);
    expect(readCompanies(file).map((c) => c.path)).toEqual(["/a", "/b"]);
    writeFileSync(file, "{");
    expect(readCompanies(file)).toEqual([]);
    writeFileSync(file, JSON.stringify([{ path: "/a" }, at("/c", 3102, "x")]));
    expect(readCompanies(file).map((c) => c.path)).toEqual(["/c"]);
  });

  test("keeps a company's port while it is free, else takes a free one no other company has", async () => {
    const list = [at("/a", 3100, "1"), at("/b", 3101, "2")];
    const taken = new Set<number>();
    const isFree = async (port: number) => !taken.has(port);
    expect(await portFor(list, "/a", isFree)).toEqual({ port: 3100, moved: false });
    expect(await portFor(list, "/new", isFree)).toEqual({ port: 3102, moved: false });
    taken.add(3100).add(3102);
    expect(await portFor(list, "/a", isFree)).toEqual({ port: 3103, moved: true });
  });

  test("names, partitions and log names", () => {
    const repo = temp();
    expect(companyName(repo)).toMatch(/^sanoma-desktop-/);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "acme" }));
    expect(companyName(repo)).toBe("acme");
    expect(partitionOf("/x/acme")).toMatch(/^persist:company-[0-9a-f]{40}$/);
    expect(partitionOf("/x/acme")).not.toBe(partitionOf("/y/acme"));
    expect(slugOf("/x/Acme Co")).toMatch(/^acme-co-[0-9a-f]{6}$/);
  });
});

describe("the link rule", () => {
  const app = "http://127.0.0.1:3100";
  test.each([
    ["http://127.0.0.1:3100/workflows", "window"],
    ["http://www.localhost:3100/", "window"],
    ["https://github.com/settings/apps/new?state=x", "window"],
    ["http://127.0.0.1:3101/", "browser"],
    ["http://www.localhost:3101/", "browser"],
    ["https://api.github.com/", "browser"],
    ["https://docs.sanoma.ai/", "browser"],
    ["mailto:hi@example.com", "browser"],
    ["file:///etc/passwd", "deny"],
    ["javascript:alert(1)", "deny"],
    ["not a url", "deny"],
  ])("%s: %s", (url, target) => {
    expect(linkTarget(url, app)).toBe(target);
  });
});

describe("logs", () => {
  test("hide the password in any URL before a line is logged", () => {
    const database =
      '{"sanoma":1,"event":"database","how":"started","url":"postgresql://postgres:s3cret@127.0.0.1:54321/sanoma","place":"this-computer"}';
    expect(hidePasswords(database)).toBe(
      '{"sanoma":1,"event":"database","how":"started","url":"postgresql://***@127.0.0.1:54321/sanoma","place":"this-computer"}',
    );
    expect(hidePasswords("connect failed for postgresql://u:pa/ss@host/db")).toBe(
      "connect failed for postgresql://***@host/db",
    );
    expect(hidePasswords("git clone https://ghp_token@github.com/acme/co")).toBe(
      "git clone https://***@github.com/acme/co",
    );
    for (const kept of [
      '{"sanoma":1,"event":"ready","url":"http://127.0.0.1:3100","sites":{}}',
      "GET https://registry.npmjs.org/@sanoma%2Fconnector-resend: Not Found - 404",
      "git@github.com:acme/co.git",
    ]) {
      expect(hidePasswords(kept)).toBe(kept);
    }
    const log = openLog(temp(), "acme");
    log.write("stdout", database);
    expect(readFileSync(log.file, "utf8")).not.toContain("s3cret");
    expect(log.tail().join("\n")).not.toContain("s3cret");
  });

  test("timestamps each line, keeps the previous start's log as .1.log, and the last lines", () => {
    const dir = temp();
    const first = openLog(dir, "acme");
    first.write("stdout", "first start");
    const second = openLog(dir, "acme");
    for (let i = 0; i < TAIL_LINES + 5; i++) second.write("stderr", `line ${i}`);
    expect(readFileSync(join(dir, "acme.1.log"), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z stdout first start\n$/);
    expect(readFileSync(second.file, "utf8").split("\n")).toHaveLength(TAIL_LINES + 6);
    expect(second.tail()).toHaveLength(TAIL_LINES);
    expect(second.tail().at(-1)).toMatch(/stderr line 204$/);
    second.close();
    second.write("stdout", "after the end");
    expect(readFileSync(second.file, "utf8")).not.toContain("after the end");
  });
});

describe("places", () => {
  test("the folder on a command line: the last directory, flags skipped", () => {
    const dir = temp();
    expect(folderArgument(["--inspect", "-psn_0_123", dir], "/")).toBe(dir);
    expect(folderArgument(["missing"], dir)).toBeUndefined();
    expect(folderArgument(["."], dir)).toBe(dir);
  });

  test("warns about folders iCloud syncs", () => {
    const home = "/Users/a";
    const syncs = (dir: string) => (path: string) =>
      path === `${home}/Library/Mobile Documents/com~apple~CloudDocs/${dir}`;
    expect(syncedFolderWarning(`${home}/Library/Mobile Documents/com~apple~CloudDocs/acme`, home)).toMatch(/iCloud/);
    expect(syncedFolderWarning(`${home}/Documents/acme`, home, syncs("Documents"))).toMatch(/iCloud/);
    expect(syncedFolderWarning(`${home}/Documents/acme`, home, syncs("Desktop"))).toBeUndefined();
    expect(syncedFolderWarning(`${home}/Companies/acme`, home, () => true)).toBeUndefined();
  });
});
