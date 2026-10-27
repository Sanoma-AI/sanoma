import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  afterFailure,
  type Company,
  companyName,
  partitionOf,
  portFor,
  readCompanies,
  recentOf,
  remember,
  slugOf,
  toReopen,
  updated,
  writeCompanies,
} from "../src/companies.ts";
import { eventOf, listeningUrlOf } from "../src/events.ts";
import { launch, launcherEnv, launcherOf, type Stream, USAGE_EXIT } from "../src/launcher.ts";
import { linkTarget } from "../src/links.ts";
import { hidePasswords, openLog, TAIL_LINES } from "../src/logs.ts";
import { folderArgument, realPathOf, syncedFolderWarning } from "../src/places.ts";
import { archWarnings, runtimeOf } from "../src/runtime.ts";
import { startSession } from "../src/session.ts";
import { shims, writeShims } from "../src/shims.ts";
import { DEFAULT_SIZE, windowBounds } from "../src/window-state.ts";

/** Windows has no process groups and no SIGTERM: the shell stops a launcher there by stdin and `taskkill`. */
const windows = process.platform === "win32";
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
  const env = { ...launcherEnv(process.env, ["/shims"], port), FAKE_MODE: mode, FAKE_STDIN: extra.stdin ?? "" };
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
      // Windows' Node needs SystemRoot for its sockets.
      env: {
        ...launcherEnv(
          { SystemRoot: process.env.SystemRoot, PATH: ["/usr/bin", "/bin"].join(delimiter) },
          ["/shims"],
          port,
        ),
        FAKE_MODE: "event",
      },
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

  test.runIf(windows)(
    "on Windows, stop kills the launcher's tree at the deadline when stdin's end does not stop it",
    async () => {
      const port = await freePort();
      const { launched, pids, lines } = fakeLaunch("stubborn", port, { killAfterMs: 300 });
      await launched.ready;
      const [launcher, grandchild] = await pids();
      await launched.stop();
      expect(lines).toContainEqual(["stdout", "ignoring the stop"]);
      await until(() => !alive(grandchild!));
      expect(alive(launcher!)).toBe(false);
      // taskkill /F ends a process with exit code 1.
      await expect(launched.exited).resolves.toEqual({ code: 1, signal: null });
    },
  );

  // Windows no longer links what a launcher left to it once it exited (`processTree`).
  test.skipIf(windows)("a launcher that dies takes what it left in its group with it", async () => {
    const port = await freePort();
    const { launched, pids } = fakeLaunch("crash", port);
    const [, grandchild] = await pids();
    await expect(launched.ready).rejects.toThrow("exited with code 1");
    await expect(launched.exited).resolves.toEqual({ code: 1, signal: null });
    expect(alive(grandchild!)).toBe(false);
  });

  test.skipIf(windows)("stop kills a launcher that ignores SIGTERM", async () => {
    const port = await freePort();
    const { launched, lines } = fakeLaunch("stubborn", port, { killAfterMs: 300 });
    await launched.ready;
    await launched.stop();
    expect(lines).toContainEqual(["stdout", "ignoring the stop"]);
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
    const env = launcherEnv({ PATH: "/usr/bin:/opt/homebrew/bin", HOME: "/h" }, ["/s/bin"], 3100, "darwin");
    expect(env).toMatchObject({ HOME: "/h", SANOMA_EVENTS: "1", SANOMA_APP_PORT: "3100" });
    expect(env.PATH).toBe("/s/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  test("on Windows, PATH under the key it has (Path), with ; and no Homebrew", () => {
    const system = "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd";
    const first = ["C:\\Users\\a\\AppData\\Roaming\\Sanoma\\bin", "C:\\Program Files\\Sanoma\\resources\\node"];
    const env = launcherEnv({ Path: system, SystemRoot: "C:\\Windows" }, first, 3100, "win32");
    expect(env).toEqual({
      Path: `${first.join(";")};${system}`,
      SystemRoot: "C:\\Windows",
      SANOMA_EVENTS: "1",
      SANOMA_APP_PORT: "3100",
    });
    // One key, whatever case the others were in.
    expect(
      Object.keys(launcherEnv({ PATH: "a", Path: "b" }, ["s"], 3100, "win32")).filter((k) => /^path$/i.test(k)),
    ).toEqual(["PATH"]);
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
  test("writes the shims, installs with the staged pnpm, then starts the company's own launcher", async () => {
    const repo = company();
    const calls = join(temp(), "calls");
    const { session, progress, bin } = await run(repo, { FAKE_PNPM_LOG: calls });
    await session.ready;
    expect(readFileSync(calls, "utf8")).toBe("install --prefer-offline\n");
    expect(progress).toEqual(["Installing packages", "Starting the company"]);
    expect(Object.keys(shims("node", "pnpm")).every((name) => existsSync(join(bin, name)))).toBe(true);
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
    expect(shims("/Apps/Sanoma.app/node/node", "/r/pnpm/bin/pnpm.mjs", "darwin")).toEqual({
      node: `#!/bin/sh\nexec '/Apps/Sanoma.app/node/node' "$@"\n`,
      pnpm: `#!/bin/sh\nexec '/Apps/Sanoma.app/node/node' '/r/pnpm/bin/pnpm.mjs' "$@"\n`,
    });
    expect(shims("/it's/node", "p", "darwin").node).toBe(`#!/bin/sh\nexec '/it'\\''s/node' "$@"\n`);
  });

  test("on Windows, pnpm.cmd, and the Node's own folder on PATH in place of a node shim", () => {
    const node = "C:\\Program Files\\Sanoma\\resources\\node\\node.exe";
    expect(shims(node, "C:\\100%\\pnpm\\bin\\pnpm.mjs", "win32")).toEqual({
      "pnpm.cmd": `@echo off\r\nchcp 65001 >nul 2>&1\r\n"${node}" "C:\\100%%\\pnpm\\bin\\pnpm.mjs" %*\r\n`,
    });
    const dir = join(temp(), "bin");
    expect(writeShims(dir, join("C:", "node", "node.exe"), "p", "win32")).toEqual([dir, join("C:", "node")]);
    expect(existsSync(join(dir, "pnpm.cmd")) && !existsSync(join(dir, "node"))).toBe(true);
  });

  test("put this platform's Node first on PATH, and run pnpm's script with it, from a path that is not ASCII", () => {
    const dir = join(temp(), "José", "bin");
    const script = join(temp(), "José", "pnpm.mjs");
    cpSync(fixture("pnpm.mjs"), script);
    const env = launcherEnv(process.env, writeShims(dir, process.execPath, script), 3100);
    // What a company's script, or a program without a shell, runs as `node`.
    expect(execFileSync("node", ["-p", "process.execPath"], { env, encoding: "utf8" }).trim()).toBe(process.execPath);
    // A .cmd runs only through a shell.
    const install = windows ? `"${join(dir, "pnpm.cmd")}" install` : `'${join(dir, "pnpm")}' install`;
    expect(execSync(install, { encoding: "utf8" })).toBe("Done in 0.1s\n");
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

  test("keeps each window's bounds and whether it is open, dropping either when it is not of its kind", () => {
    const file = join(temp(), "companies.json");
    const bounds = { x: 10, y: 20, width: 900, height: 700 };
    let list = [at("/a", 3100, "2"), at("/b", 3101, "1")];
    list = updated(list, "/a", { bounds, open: true });
    list = updated(list, "/missing", { open: true });
    writeCompanies(file, list);
    expect(readCompanies(file)).toEqual([{ ...at("/a", 3100, "2"), bounds, open: true }, at("/b", 3101, "1")]);
    writeFileSync(file, JSON.stringify([{ ...at("/a", 3100, "2"), bounds: { x: 1 }, open: "yes" }]));
    expect(readCompanies(file)).toEqual([at("/a", 3100, "2")]);
  });

  test("opens at launch the companies open at the last Quit whose folders hold one", () => {
    const list = [
      { ...at("/a", 3100, "3"), open: true },
      at("/b", 3101, "2"),
      { ...at("/gone", 3102, "1"), open: true },
    ];
    expect(toReopen(list, (dir) => dir !== "/gone")).toEqual(["/a"]);
    expect(toReopen(updated(list, "/a", { open: false }), () => true)).toEqual(["/gone"]);
  });

  test("marks the running companies in Recent", () => {
    const list = [at("/a", 3100, "2"), at("/b", 3101, "1")];
    expect(recentOf(list, new Set(["/b"])).map((c) => [c.path, c.running])).toEqual([
      ["/a", false],
      ["/b", true],
    ]);
  });

  test("forgets a failed start whose folder holds no company, such as a failed clone, and keeps any other", () => {
    const list = [at("/clone", 3100, "2"), at("/a", 3101, "1")];
    expect(afterFailure(list, "/clone", (dir) => dir !== "/clone").map((c) => c.path)).toEqual(["/a"]);
    expect(afterFailure(list, "/a", (dir) => dir !== "/clone")).toEqual(list);
    const real = temp();
    expect(afterFailure([at(real, 3100, "1")], real)).toEqual([]);
    writeFileSync(join(real, "sanoma.config.ts"), "export default {};\n");
    expect(afterFailure([at(real, 3100, "1")], real)).toHaveLength(1);
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

describe("window state", () => {
  const screen = { x: 0, y: 25, width: 1440, height: 875 };
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };

  test("opens a window at its saved bounds while enough of it is on a display", () => {
    const saved = { x: 100, y: 80, width: 900, height: 700 };
    expect(windowBounds(saved, [screen])).toEqual(saved);
    expect(windowBounds({ ...saved, x: 2000 }, [screen, second])).toEqual({ ...saved, x: 2000 });
    // Half off the edge: moved onto the display whole.
    expect(windowBounds({ ...saved, x: 1000 }, [screen])).toEqual({ ...saved, x: 540 });
  });

  test("at the default size the first time, or when its display is gone", () => {
    expect(windowBounds(undefined, [screen])).toEqual(DEFAULT_SIZE);
    expect(windowBounds({ x: 2000, y: 80, width: 900, height: 700 }, [screen])).toEqual(DEFAULT_SIZE);
    expect(windowBounds({ x: 1400, y: 80, width: 900, height: 700 }, [screen])).toEqual(DEFAULT_SIZE);
  });

  test("no larger than its display, and on it whole", () => {
    expect(windowBounds({ x: 300, y: 300, width: 1920, height: 1080 }, [screen])).toEqual({
      x: 0,
      y: 25,
      width: 1440,
      height: 875,
    });
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
    expect(hidePasswords("connect failed for postgresql://u:p%2Fss@host/db")).toBe(
      "connect failed for postgresql://***@host/db",
    );
    expect(hidePasswords("git clone https://ghp_token@github.com/acme/co")).toBe(
      "git clone https://***@github.com/acme/co",
    );
    for (const kept of [
      '{"sanoma":1,"event":"ready","url":"http://127.0.0.1:3100","sites":{}}',
      "GET https://registry.npmjs.org/@sanoma%2Fconnector-resend: Not Found - 404",
      "git@github.com:acme/co.git",
      "GET http://localhost:5173/@fs/Users/me/acme/src/x.ts 500",
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
  test("the folder on a command line: the last directory, flags and the app's own folder skipped", () => {
    const dir = temp();
    expect(folderArgument(["--inspect", "-psn_0_123", dir], "/")).toBe(dir);
    expect(folderArgument(["missing"], dir)).toBeUndefined();
    expect(folderArgument(["."], dir)).toBe(dir);
    // A checkout's shell: `electron --flags <app path> [folder]`; the app's own folder is no company.
    const app = temp();
    expect(folderArgument(["--inspect=0", app, "--user-data-dir=/x"], "/", app)).toBeUndefined();
    expect(folderArgument([app, dir], "/", app)).toBe(dir);
  });

  test.runIf(windows)("on Windows, a folder is known by the case its disk has", () => {
    const dir = join(temp(), "Acme");
    mkdirSync(dir);
    expect(realPathOf(dir.toUpperCase())).toBe(realPathOf(dir));
    expect(realPathOf(dir).endsWith("Acme")).toBe(true);
  });

  test("warns about folders iCloud syncs", () => {
    const home = join("/", "Users", "a");
    const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    const syncs = (dir: string) => (path: string) => path === join(icloud, dir);
    const mac = (path: string, exists?: (path: string) => boolean) => syncedFolderWarning(path, home, exists, "darwin");
    expect(mac(join(icloud, "acme"))).toMatch(/iCloud/);
    expect(mac(join(home, "Documents", "acme"), syncs("Documents"))).toMatch(/iCloud/);
    expect(mac(join(home, "Documents", "acme"), syncs("Desktop"))).toBeUndefined();
    expect(mac(join(home, "Companies", "acme"), () => true)).toBeUndefined();
  });

  test("on Windows, warns about folders OneDrive or iCloud syncs", () => {
    const home = join("/", "Users", "a");
    const env = { OneDrive: join(home, "OneDrive"), OneDriveCommercial: join(home, "OneDrive - Acme") };
    const onWindows = (path: string) => syncedFolderWarning(path, home, () => true, "win32", env);
    expect(onWindows(join(home, "OneDrive", "Documents", "acme"))).toMatch(/OneDrive syncs/);
    expect(onWindows(join(home, "OneDrive - Acme", "acme"))).toMatch(/OneDrive syncs/);
    expect(onWindows(join(home, "iCloudDrive", "acme"))).toMatch(/iCloud syncs/);
    // Desktop and Documents sync only when OneDrive keeps them, and then they are in its folder.
    expect(onWindows(join(home, "Documents", "acme"))).toBeUndefined();
    expect(onWindows(join(home, "Companies", "acme"))).toBeUndefined();
  });
});

describe("the runtime", () => {
  test("the shipped Node, node.exe on Windows, and the staged pnpm's script", () => {
    const resources = temp();
    mkdirSync(join(resources, "pnpm"));
    writeFileSync(
      join(resources, "pnpm", "package.json"),
      JSON.stringify({ bin: { pnpm: "bin/pnpm.mjs", pnpx: "bin/pnpx.mjs" } }),
    );
    const where = { packaged: true, appPath: "/app", resourcesPath: resources };
    expect(runtimeOf(where, "darwin")).toEqual({
      node: join(resources, "node", "node"),
      pnpm: join(resources, "pnpm", "bin", "pnpm.mjs"),
    });
    expect(runtimeOf(where, "win32").node).toBe(join(resources, "node", "node.exe"));
  });

  test("an x64 build translated on Arm is told so, in its platform's words", () => {
    expect(archWarnings(false, "win32")).toEqual([]);
    expect(archWarnings(true, "darwin")).toEqual([expect.stringMatching(/Apple silicon Mac/)]);
    expect(archWarnings(true, "win32")).toEqual([expect.stringMatching(/Arm PC/)]);
  });
});
