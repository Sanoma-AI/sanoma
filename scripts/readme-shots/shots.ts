// `pnpm readme:shots`: retakes the README's pictures in .github/assets from a running app. See README.md here.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const browser = await launchChrome();
const work = mkdtempSync(join(tmpdir(), "readme-shots-"));
let server: ChildProcess | undefined;
let database = false;
try {
  await resetDatabase();
  database = true;
  const acme = join(work, "acme");
  writeRepo(acme);
  server = spawn(process.execPath, [join(repo, "packages/sanoma/dist/cli.js"), "serve"], {
    cwd: acme,
    env: { ...process.env, SANOMA_DATABASE_URL: databaseUrl.href, SANOMA_APP_PORT: "0" },
  });
  const base = await appUrl(server);
  say(`app at ${base}`);

  const frames = join(work, "frames");
  const runPath = await recordDemo(browser, base, frames);
  say("demo recorded; seeding two more runs that wait on marketing-lead");
  await seedPendingRuns(browser, base);

  await still(browser, base, "/workflows/announce", join(assets, "workflow.png"), {
    sidebar: false,
    select: "ghost.post.publish",
    fullPage: true,
  });
  await still(browser, base, "/inbox", join(assets, "inbox.png"), { sidebar: true, height: 720 });
  await still(browser, base, runPath, join(assets, "run.png"), {
    sidebar: false,
    select: "Review launch copy",
    tab: "Ledger",
    fullPage: true,
  });
  say("stills taken; making demo.gif");
  makeGif(frames, join(assets, "demo.gif"));
  say("wrote .github/assets: demo.gif, workflow.png, inbox.png, run.png");
} finally {
  await browser.close();
  if (server) await stop(server);
  if (database)
    await dropDatabase().catch((err: unknown) =>
      console.error(`readme:shots: could not drop the database: ${String(err)}`),
    );
  rmSync(work, { recursive: true, force: true });
}

/** A company repo named acme: the README's workflow, the config above, and `node_modules` reaching this checkout. */
function writeRepo(dir: string): void {
  const readme = readFileSync(join(repo, "README.md"), "utf8");
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

/** The app's URL, once `sanoma serve` prints it; throws with its output when it exits first or takes 60 s. */
async function appUrl(child: ChildProcess): Promise<string> {
  let output = "";
  const read = (chunk: Buffer) => (output += chunk.toString());
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  try {
    const url = await waitFor(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("sanoma serve exited");
        return /^acme at (\S+);/m.exec(output)?.[1];
      },
      Boolean,
      60_000,
    );
    return url!;
  } catch (err) {
    fail(`the app did not start (${(err as Error).message}):\n${output}`);
  }
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
