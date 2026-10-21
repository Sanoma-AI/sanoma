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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser } from "puppeteer-core";
import { ensureBuilt, waitFor } from "../../packages/testing/src/build.ts";
import type { SanomaConfig } from "../../packages/workflows/src/index.ts";
import { launchChrome, recordDemo, ServerFailure, still } from "./capture.ts";

type Workflows = typeof import("../../packages/workflows/src/index.ts");

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
const CONFIG = `import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { withFake } from "@sanoma-ai/testing";
import { defineConfig } from "sanoma";
import announce from "./workflows/announce.ts";

export default defineConfig({ workflows: [announce], connectors: [withFake(ghost, fakeGhost())] });
`;

// The site still's site: its site.ts here, its page the packages/app README's (`writeRepo`).
const SITE_TS = `import { defineSite } from "sanoma/site";

export default defineSite({ title: "Launch desk" });
`;

// The data still's collection: the outbound fixture's resources/data.ts (which the launcher
// imports), importing from sanoma as a company's does; and its records, saved as their owners.
const DATA_TS = join(repo, "packages/workflows/test/fixtures/outbound/resources/data.ts");
const LEADS = [
  ["Acme Corp", "ada@acme.test", "meeting", "dana", "2027-05-28", 40],
  ["Globex", "hank@globex.test", "contacted", "dana", "2027-05-20", 12],
  ["Hooli", "gavin@hooli.test", "won", "marketing-lead", "2027-05-30", 120],
  ["Initech", "peter@initech.test", "replied", "marketing-lead", "2027-05-26", 25],
  ["Stark Industries", "pepper@stark.test", "researched", "marketing-lead", undefined, undefined],
  ["Umbrella", "alice@umbrella.test", "researched", "dana", undefined, undefined],
] as const;

const started = Date.now();
const say = (line: string) => console.log(`readme:shots ${((Date.now() - started) / 1000).toFixed(0)}s: ${line}`);

// The two runs seeded for the Inbox still, as dana: title, body and launch time.
const SEEDED = [
  ["Summer sale", "<p>Everything is 20% off until Sunday.</p>", new Date(2027, 5, 1, 9)],
  ["Pricing update", "<p>New plans for teams, from next month.</p>", new Date(2027, 5, 15, 10)],
] as const;

// The packages' own requires: `pg` and `@sanoma-ai/workflows` (its dist/, as the company repo loads it).
const fromSanoma = createRequire(join(repo, "packages/sanoma/package.json"));

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const exitCodeOf = (signal: (typeof SIGNALS)[number]) => 128 + constants.signals[signal];

// What one run holds, each released by `cleanup`: the work directory, the server's log beside it
// (kept after a failure), Chrome, ffmpeg, the server and its database.
const work = mkdtempSync(join(tmpdir(), "readme-shots-"));
const serverLog = `${work}.log`;
let keepLog = false;
let databaseUrl: URL;
let chrome: Promise<Browser> | undefined;
let server: ChildProcess | undefined;
let ffmpeg: ChildProcess | undefined;
let database = false;
let interrupted: (typeof SIGNALS)[number] | undefined;
let cleaning: Promise<void> | undefined;

// Ctrl-C or a kill: the same cleanup as `finally`, then out with the signal's code (130 for SIGINT).
// A signal during the cleanup (pnpm passes Ctrl-C on as well) waits for it rather than cutting it short.
for (const signal of SIGNALS) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = signal;
    say(`${signal}: cleaning up`);
    void cleanup().then(() => process.exit(exitCodeOf(signal)));
  });
}

try {
  if (!hasFfmpeg()) fail("ffmpeg is not on PATH; it makes demo.gif (brew install ffmpeg)");
  say("building what is stale (pnpm run build in each package whose dist/ is older than its src/)");
  for (const [dir, outputs] of BUILT) ensureBuilt(join(repo, dir), outputs, ["pnpm", "run", "build"]);
  // Loaded once built: @sanoma-ai/testing's index imports @sanoma-ai/workflows from its dist/.
  const { testDatabaseUrl } = await import("../../packages/testing/src/index.ts");
  // `SANOMA_TEST_DATABASE_URL`'s name plus `_readme_shots`: a worktree's own when that is set per worktree.
  databaseUrl = new URL(testDatabaseUrl("readme_shots"));

  stopIfInterrupted();
  chrome = launchChrome();
  const browser = await chrome;
  await resetDatabase();
  const acme = join(work, "acme");
  writeRepo(acme);
  stopIfInterrupted();
  // The server creates the database, and writes its output to the log, read for its URL.
  database = true;
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
  say("demo recorded; seeding two more runs that wait on marketing-lead, and the outbound leads");
  await seed(acme);

  const captured = join(work, "assets");
  mkdirSync(captured);
  // With the sidebar's panel open: the workflow's runs beside its page.
  await still(browser, base, "/workflows/announce", join(captured, "workflow.png"), {
    sidebar: true,
    select: "ghost.post.publish",
    fullPage: true,
  });
  await still(browser, base, "/inbox", join(captured, "inbox.png"), { sidebar: true, height: 720 });
  await still(browser, base, runPath, join(captured, "run.png"), {
    sidebar: true,
    select: "Review launch copy",
    tab: "Ledger",
    fullPage: true,
  });
  await still(browser, base, "/sites/launches", join(captured, "site.png"), { sidebar: true, fullPage: true });
  // The grid sorted by stage, a record open in the form beside it.
  await still(browser, base, "/data/outbound?order=stage&record=Initech", join(captured, "data.png"), {
    sidebar: true,
    fullPage: true,
  });
  say("stills taken; making demo.gif");
  stopIfInterrupted();
  await makeGif(frames, join(captured, "demo.gif"));
  stopIfInterrupted();
  const files = ["demo.gif", "workflow.png", "inbox.png", "run.png", "site.png", "data.png"];
  replaceAssets(captured, files);
  say(`wrote .github/assets: ${files.join(", ")}`);
} catch (err) {
  // A signal's handler runs on the event loop: let one that came during a blocking call (a build)
  // run before telling a failure from an interruption. One setImmediate can fire in the same turn,
  // before the loop polls for the signal; the second comes after that poll.
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  if (!interrupted) {
    keepLog = existsSync(serverLog);
    report(err);
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}

/** Throws once a signal has come, so nothing is acquired after the cleanup has begun. */
function stopIfInterrupted(): void {
  if (interrupted) throw new Error(`readme:shots: stopped by ${interrupted}`);
}

/**
 * Closes Chrome (once launched, if it is launching), stops ffmpeg and the server, drops the
 * database and removes the work directory (after ffmpeg, which reads from it) and, unless a failure keeps it, the server's log: each whatever the
 * others do, and once, for `finally` and a signal alike.
 */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    const steps: [what: string, step: () => unknown][] = [
      [
        "close Chrome",
        () =>
          chrome?.then(
            (browser) => browser.close(),
            () => {},
          ),
      ],
      ["stop ffmpeg", () => ffmpeg && stop(ffmpeg)],
      ["stop the server", () => server && stop(server)],
      ["drop the database", () => database && dropDatabase()],
      [`remove ${work}`, () => rmSync(work, { recursive: true, force: true })],
      [`remove ${serverLog}`, () => keepLog || rmSync(serverLog, { force: true })],
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

/** The error, then the server's log: its last 40 lines when the failure likely starts there, else its path. */
function report(err: unknown): void {
  console.error(err);
  if (!keepLog) return;
  if (err instanceof ServerFailure) {
    const tail = readFileSync(serverLog, "utf8").trimEnd().split("\n").slice(-40).join("\n");
    console.error(`readme:shots: the server's last lines:\n${tail}`);
  }
  console.error(`readme:shots: the server's log is ${serverLog}`);
}

/** A file's temporary name in .github/assets while `replaceAssets` copies it in. */
function temporary(file: string): string {
  return join(assets, `.${file}.new`);
}

/**
 * Copies `files` from `dir` into .github/assets under temporary names, then renames each into
 * place, so a failure leaves the committed set as it was; the temporary names go either way.
 */
function replaceAssets(dir: string, files: string[]): void {
  try {
    for (const file of files) copyFileSync(join(dir, file), temporary(file));
    for (const file of files) renameSync(temporary(file), join(assets, file));
  } finally {
    for (const file of files) rmSync(temporary(file), { force: true });
  }
}

/**
 * Two more runs of announce from dana, waiting on marketing-lead, for the Inbox still, and the
 * outbound leads for the data still: through the runtime's client, as the app starts a run and
 * saves a record, with acme's config and the collection its resources/data.ts declares (as the
 * launcher adds it).
 */
async function seed(acme: string): Promise<void> {
  const { SanomaClient } = (await import(pathToFileURL(fromSanoma.resolve("@sanoma-ai/workflows")).href)) as Workflows;
  const { default: config } = (await import(pathToFileURL(join(acme, "sanoma.config.ts")).href)) as {
    default: SanomaConfig;
  };
  const { outbound } = (await import(pathToFileURL(join(acme, "resources/data.ts")).href)) as {
    outbound: NonNullable<SanomaConfig["collections"]>[number];
  };
  const client = await SanomaClient.connect({
    ...config,
    collections: [outbound],
    root: acme,
    databaseUrl: databaseUrl.href,
  });
  try {
    for (const [company, contact, stage, owner, lastTouched, seats] of LEADS) {
      const record = { company, contact, stage, owner, ...(lastTouched && { lastTouched }), ...(seats && { seats }) };
      await client.call("data.outbound.save", { record }, { actor: { id: owner }, id: crypto.randomUUID() });
    }
    for (const [title, body, launchAt] of SEEDED) {
      const input = { title, body, launchAt: launchAt.toISOString() };
      const runId = await client.start("announce", input, { startedBy: { id: "dana" } });
      await waitFor(
        async () => (await client.run(runId))?.status,
        (status) => status === "waiting",
        30_000,
      ).catch((err: unknown) => {
        throw new ServerFailure(`readme:shots: seeded run ${runId} did not come to wait on its approval`, {
          cause: err,
        });
      });
    }
  } finally {
    await client.close();
  }
}

/** A company repo named acme: the README's workflow, the config above, the packages/app README's site page, the outbound collection, and `node_modules` reaching this checkout. */
function writeRepo(dir: string): void {
  const readme = readFileSync(join(repo, "README.md"), "utf8").replaceAll("\r\n", "\n");
  const block = /^```ts\n\/\/ workflows\/announce\.ts\n([\s\S]*?)^```$/m.exec(readme);
  if (!block?.[1]) fail("README.md has no ```ts block that starts with `// workflows/announce.ts`");
  mkdirSync(join(dir, "workflows"), { recursive: true });
  writeFileSync(join(dir, "workflows/announce.ts"), block[1]);
  writeFileSync(join(dir, "sanoma.config.ts"), CONFIG);
  const appReadme = readFileSync(join(repo, "packages/app/README.md"), "utf8").replaceAll("\r\n", "\n");
  const page = /^```tsx\n\/\/ sites\/launches\/routes\/index\.tsx\n([\s\S]*?)^```$/m.exec(appReadme);
  if (!page?.[1])
    fail("packages/app/README.md has no ```tsx block that starts with `// sites/launches/routes/index.tsx`");
  mkdirSync(join(dir, "sites/launches/routes"), { recursive: true });
  writeFileSync(join(dir, "sites/launches/site.ts"), SITE_TS);
  writeFileSync(join(dir, "sites/launches/routes/index.tsx"), page[1]);
  mkdirSync(join(dir, "resources"));
  writeFileSync(
    join(dir, "resources/data.ts"),
    readFileSync(DATA_TS, "utf8").replace('"@sanoma-ai/workflows/data"', '"sanoma/data"'),
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme", private: true, type: "module" }));
  for (const [name, target] of [
    ["sanoma", "packages/sanoma"],
    ["@sanoma-ai/connector-ghost", "connectors/ghost"],
    ["@sanoma-ai/testing", "packages/testing"],
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
  ).catch((err: unknown) => {
    throw new ServerFailure(`readme:shots: the app did not start: ${(err as Error).message}`, { cause: err });
  });
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
  const { Client } = fromSanoma("pg") as {
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

/**
 * The frames at their durations (ffmpeg's concat list), one palette for the whole GIF, looping.
 * ffmpeg runs without blocking the event loop, so a signal's handler runs while it works, and
 * the cleanup stops it.
 */
async function makeGif(frames: string, out: string): Promise<void> {
  const filter =
    "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  ffmpeg = spawn(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "concat", "-i", "frames.txt", "-vf", filter, "-loop", "0", out],
    { cwd: frames, stdio: "inherit" },
  );
  const [code, signal] = (await once(ffmpeg, "close")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`readme:shots: ffmpeg failed (${signal ?? `exit ${code}`})`);
}

function fail(message: string): never {
  throw new Error(`readme:shots: ${message}`);
}
