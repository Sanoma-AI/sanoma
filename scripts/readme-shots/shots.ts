// `pnpm readme:shots`: retakes the README's pictures in .github/assets from a running app. See README.md here.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "puppeteer-core";
import { ensureBuilt, waitFor } from "../../packages/testing/src/build.ts";
import { launchChrome, recordDemo, seedPendingRuns, still } from "./capture.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const assets = join(repo, ".github/assets");

// What the preview loads, each from its dist/ (as a company repo would), in dependency order.
const BUILT: [dir: string, outputs: string[]][] = [
  ["packages/workflows", ["dist/index.js"]],
  ["connectors/ghost", ["dist/index.js", "dist/fake.js"]],
  ["packages/testing", ["dist/index.js"]],
  ["packages/app", ["dist/server/server.js"]],
  ["packages/sanoma", ["dist/cli.js", "dist/index.js"]],
];

// The preview's config: the README's workflow, with Ghost answered by its in-memory fake behind the
// live connector, so the form still shows Live vendors.
const CONFIG = `import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { withFake } from "@sanoma/testing";
import { allowAll, defineConfig } from "sanoma";
import announce from "./workflows/announce.ts";

export default defineConfig({ workflows: [announce], connectors: [withFake(ghost, fakeGhost())], policy: allowAll });
`;

const started = Date.now();
const say = (line: string) => console.log(`readme:shots ${((Date.now() - started) / 1000).toFixed(0)}s: ${line}`);

if (!hasFfmpeg()) fail("ffmpeg is not on PATH; it makes demo.gif (brew install ffmpeg)");
say("building what is stale (pnpm run build in each package whose dist/ is older than its src/)");
for (const [dir, outputs] of BUILT) ensureBuilt(join(repo, dir), outputs, ["pnpm", "run", "build"]);
// Loaded once built: @sanoma/testing's index imports @sanoma/workflows from its dist/.
const { testDatabaseUrl } = await import("../../packages/testing/src/index.ts");
// `SANOMA_TEST_DATABASE_URL`'s name plus `_readme_shots`: a worktree's own when that is set per worktree.
const databaseUrl = new URL(testDatabaseUrl("readme_shots"));

const work = mkdtempSync(join(tmpdir(), "readme-shots-"));
const captured = join(work, "assets");
const serverLog = join(work, "server.log");
let browser: Browser | undefined;
let server: ChildProcess | undefined;
let database = false;
let interrupted = false;
let cleaning: Promise<void> | undefined;

// Ctrl-C or a kill: the same cleanup as `finally`, then out with the signal's code (130 for SIGINT).
// A signal during the cleanup (pnpm passes Ctrl-C on as well) waits for it rather than cutting it short.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    say(`${signal}: cleaning up`);
    void cleanup().then(() => process.exit(128 + constants.signals[signal]));
  });
}

try {
  browser = await launchChrome();
  await resetDatabase();
  database = true;
  const acme = join(work, "acme");
  writeRepo(acme);
  // The server's output goes to a log file, read for its URL and, on a failure, for its last lines.
  const log = openSync(serverLog, "a");
  server = spawn(process.execPath, [join(repo, "packages/sanoma/dist/cli.js"), "serve"], {
    cwd: acme,
    env: { ...process.env, SANOMA_DATABASE_URL: databaseUrl.href, SANOMA_APP_PORT: "0" },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const base = await appUrl(server);
  say(`app at ${base}`);

  const frames = join(work, "frames");
  const runPath = await recordDemo(browser, base, frames);
  say("demo recorded; seeding two more runs that wait on marketing-lead");
  await seedPendingRuns(browser, base);

  mkdirSync(captured);
  await still(browser, base, "/workflows/announce", join(captured, "workflow.png"), {
    sidebar: false,
    select: "ghost.post.publish",
    fullPage: true,
  });
  await still(browser, base, "/inbox", join(captured, "inbox.png"), { sidebar: true, height: 720 });
  await still(browser, base, runPath, join(captured, "run.png"), {
    sidebar: false,
    select: "Review launch copy",
    tab: "Ledger",
    fullPage: true,
  });
  say("stills taken; making demo.gif");
  makeGif(frames, join(captured, "demo.gif"));
  // Only once all four are made, so a failure leaves the committed ones as they are.
  for (const file of ["demo.gif", "workflow.png", "inbox.png", "run.png"]) {
    copyFileSync(join(captured, file), join(assets, file));
  }
  say("wrote .github/assets: demo.gif, workflow.png, inbox.png, run.png");
} catch (err) {
  if (!interrupted && existsSync(serverLog)) {
    const tail = readFileSync(serverLog, "utf8").trimEnd().split("\n").slice(-40).join("\n");
    console.error(`readme:shots: the server's last lines:\n${tail}`);
  }
  throw err;
} finally {
  await cleanup();
}

/**
 * Closes Chrome, stops the server, drops the database and removes the work directory, each
 * whatever the others do; once, for `finally` and a signal alike.
 */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    const steps: [what: string, step: () => unknown][] = [
      ["close Chrome", () => browser?.close()],
      ["stop the server", () => server && stop(server)],
      ["drop the database", () => database && dropDatabase()],
      [`remove ${work}`, () => rmSync(work, { recursive: true, force: true })],
    ];
    for (const [what, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.error(`readme:shots: could not ${what}: ${String(err)}`);
      }
    }
  })();
  return cleaning;
}

/** A company repo named acme: the README's workflow, the config above, and `node_modules` reaching this checkout. */
function writeRepo(dir: string): void {
  const readme = readFileSync(join(repo, "README.md"), "utf8").replaceAll("\r\n", "\n");
  const block = /^```ts\n\/\/ workflows\/announce\.ts\n([\s\S]*?)^```$/m.exec(readme);
  if (!block?.[1]) fail("README.md has no ```ts block that starts with `// workflows/announce.ts`");
  mkdirSync(join(dir, "workflows"), { recursive: true });
  writeFileSync(join(dir, "workflows/announce.ts"), block[1]);
  writeFileSync(join(dir, "sanoma.config.ts"), CONFIG);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme", private: true, type: "module" }));
  for (const [name, target] of [
    ["sanoma", "packages/sanoma"],
    ["@sanoma/connector-ghost", "connectors/ghost"],
    ["@sanoma/testing", "packages/testing"],
  ] as const) {
    const at = join(dir, "node_modules", name);
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(join(repo, target), at);
  }
}

/** The app's URL, once `sanoma serve` writes it to its log; fails when the server exits first or takes 60 s. */
async function appUrl(child: ChildProcess): Promise<string> {
  const url = await waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("sanoma serve exited first");
      return /^acme at (\S+);/m.exec(readFileSync(serverLog, "utf8"))?.[1];
    },
    Boolean,
    60_000,
  ).catch((err: unknown) => fail(`the app did not start: ${(err as Error).message}`));
  return url!;
}

/** SIGTERM, then SIGKILL after 10 s. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Runs `sql` on the server's `postgres` database. `pg` comes from the `sanoma` package, which depends on it. */
async function onServer(sql: string): Promise<void> {
  const { Client } = createRequire(join(repo, "packages/sanoma/package.json"))("pg") as {
    Client: new (options: { connectionString: string }) => PgClient;
  };
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
  } catch (err) {
    fail(`Postgres does not answer at ${url.host} (${String(err)}); start it with \`pnpm db:up\``);
  }
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Drops what an earlier, killed run may have left; DBOS creates the database when the worker starts. */
async function resetDatabase(): Promise<void> {
  await dropDatabase();
  say(`database ${databaseName()} on ${databaseUrl.host}`);
}

/** The database's name, quoted for SQL. */
function databaseName(): string {
  return `"${decodeURIComponent(databaseUrl.pathname.slice(1)).replaceAll('"', '""')}"`;
}

function dropDatabase(): Promise<void> {
  return onServer(`drop database if exists ${databaseName()} with (force)`);
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The frames at their durations (ffmpeg's concat list), one palette for the whole GIF, looping. */
function makeGif(frames: string, out: string): void {
  const filter =
    "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-i", "frames.txt", "-vf", filter, "-loop", "0", out], {
    cwd: frames,
    stdio: "inherit",
  });
}

function fail(message: string): never {
  throw new Error(`readme:shots: ${message}`);
}
