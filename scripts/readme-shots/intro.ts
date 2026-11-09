// Launch-desk storyboard. `shots.ts --intro` builds first, then imports this module.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { testDatabaseUrl, waitFor } from "sanoma/testing";
import { writeDeploymentKeys } from "../../packages/sanoma/src/key.ts";
import { launchChrome } from "./capture.ts";
import { captureIntro } from "./intro-capture.ts";
import { videoInfo } from "./motion.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "sanoma-intro-"));
const root = join(work, "paperplane");
const origin = join(work, "origin.git");
const logFile = `${work}.log`;
const databaseUrl = testDatabaseUrl(`readme_intro_${work.slice(-6).toLowerCase()}`);
const say = (line: string) => console.log(`readme:intro: ${line}`);
const fromSanoma = createRequire(join(repo, "packages/sanoma/package.json"));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Demo engineer",
  GIT_AUTHOR_EMAIL: "engineer@example.com",
  GIT_COMMITTER_NAME: "Demo engineer",
  GIT_COMMITTER_EMAIL: "engineer@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
let server: ChildProcess | undefined;
let browser: Promise<Awaited<ReturnType<typeof launchChrome>>> | undefined;
let interrupted = false;
function active() {
  if (interrupted) throw new Error("Recording interrupted");
}
let encoder: ChildProcess | undefined;
let succeeded = false;
let cleaning: Promise<void> | undefined;
let requestId = 0;

function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" });
function fixture() {
  write("package.json", JSON.stringify({ name: "paperplane-studio", private: true, type: "module" }));
  write(".gitignore", "node_modules/\n.sanoma/\n.env\n");
  write(
    "tsconfig.json",
    JSON.stringify({ extends: "sanoma/tsconfig.json", include: ["sanoma.config.ts", "workflows", "resources"] }),
  );
  write(
    "sanoma.config.ts",
    `import { defineConfig } from "sanoma";
import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { resend } from "@sanoma-ai/connector-resend";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";
import { withFake } from "sanoma/testing";
export const ghostFake = fakeGhost();
export const resendFake = fakeResend();
export default defineConfig({ workflows: [], connectors: [withFake(ghost, ghostFake), withFake(resend, resendFake)] });
`,
  );
  write(
    "resources/people.ts",
    `import { sanoma } from "sanoma/resources";
export const dana = sanoma.person({ id: "dana", name: "Dana · Marketing" });
export const engineer = sanoma.person({ id: "engineer", name: "Alex · Engineer" });
export const lead = sanoma.person({ id: "marketing-lead", name: "Sam · Marketing lead" });
export const admin = sanoma.group({ name: "admin", members: [engineer] });
export const marketing = sanoma.group({ name: "marketing", members: [dana, lead] });
`,
  );
  // The initial policy is empty; the draft adds the hold visible in the permission comparison.
  write("policies/marketing.cedar", "// Marketing's publishing policy will be reviewed with the launch desk.\n");
  write(
    "AGENTS.md",
    "# Paperplane Studio demo\nUse the existing Ghost and Resend connections. Send only to reader@example.com from news@paperplane.example. This fixture simulates all services.\n",
  );
  for (const [name, target] of [
    ["sanoma", "packages/sanoma"],
    ["@sanoma-ai/connector-ghost", "connectors/ghost"],
    ["@sanoma-ai/connector-resend", "connectors/resend"],
  ]) {
    const at = join(root, "node_modules", name!);
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(join(repo, target!), at);
  }
  writeDeploymentKeys(join(root, ".env"));
  mkdirSync(origin);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Demo company with existing connections");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(root, "remote", "add", "origin", pathToFileURL(origin).href);
  git(root, "push", "--quiet", "origin", "main");
}

async function start(): Promise<string> {
  active();
  const log = openSync(logFile, "a");
  server = spawn(process.execPath, [join(repo, "scripts/readme-shots/intro-server.ts"), root, origin], {
    cwd: root,
    env: { ...gitEnv, SANOMA_DATABASE_URL: databaseUrl },
    stdio: ["ignore", log, log, "ipc"],
    detached: true,
  });
  closeSync(log);
  let base: string | undefined;
  server.on("message", (message: { ready?: string }) => {
    if (message.ready) base = message.ready;
  });
  return (await waitFor(
    () => {
      if (server!.exitCode !== null) throw new Error(`Demo server exited; see ${logFile}`);
      return base;
    },
    Boolean,
    120_000,
  ))!;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  // Stop the server's check/build children as well as the server.
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child === server && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  kill("SIGTERM");
  const timer = setTimeout(() => kill("SIGKILL"), 10_000);
  await ended;
  clearTimeout(timer);
}
function command<T>(operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const child = server!;
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`Timed out: ${operation}`));
    }, 60_000);
    function onMessage(message: { id?: number; result: T; error?: string }) {
      if (message.id !== id) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    }
    child.on("message", onMessage);
    child.send({ id, command: operation });
  });
}
type Calls = { ghost: { op: string }[]; resend: { op: string }[] };
const counts = (calls: Calls) => [
  calls.ghost.filter((c) => c.op === "ghost.post.publish").length,
  calls.resend.filter((c) => c.op === "resend.emails.send").length,
];
async function dropDatabases() {
  const { Client } = fromSanoma("pg") as {
    Client: new (options: { connectionString: string; connectionTimeoutMillis: number; query_timeout: number }) => {
      connect(): Promise<void>;
      query(sql: string): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10_000, query_timeout: 120_000 });
  await client.connect();
  try {
    for (const db of [name, `${name}_check`])
      await client.query(`DROP DATABASE IF EXISTS "${db.replaceAll('"', '""')}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
function cleanup() {
  cleaning ??= (async () => {
    for (const action of [
      () =>
        browser?.then(
          (chrome) => chrome.close(),
          () => {},
        ),
      () => stop(encoder),
      () => stop(server),
      dropDatabases,
      () => rmSync(work, { recursive: true, force: true }),
    ]) {
      try {
        await action();
      } catch (error) {
        console.error("Intro cleanup:", error);
        process.exitCode = 1;
      }
    }
    if (succeeded) rmSync(logFile, { force: true });
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    void cleanup().then(() => process.exit(128 + constants.signals[signal]));
  });
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  await dropDatabases();
  active();
  fixture();
  say(`isolated fixture at ${root}; log ${logFile}`);
  const base = await start();
  active();
  browser = launchChrome();
  const chrome = await browser;
  active();
  const frames = join(work, "frames");
  const duration = await captureIntro(chrome, base, frames, {
    say,
    diff: (id) =>
      execFileSync("git", ["diff", "main", `draft/${id}`, "--", "workflows/announce.ts", "policies/marketing.cedar"], {
        cwd: root,
        encoding: "utf8",
      }),
    restart: async () => {
      // Published is shown before the local follow finishes. Wait for the actual checkout.
      await waitFor(
        () =>
          existsSync(join(root, "workflows/announce.ts")) &&
          git(root, "rev-parse", "HEAD").equals(git(origin, "rev-parse", "main")),
        Boolean,
        30_000,
      );
      await stop(server);
      return start();
    },
    waiting: async () =>
      assert.deepEqual(counts(await command<Calls>("calls")), [0, 0], "No publish/send before approval"),
    finished: async () => {
      assert.deepEqual(counts(await command<Calls>("calls")), [1, 1], "Approval must publish and send exactly once");
      assert.deepEqual(counts(await command<Calls>("reject")), [1, 1], "Rejecting must not publish or send");
      say("verified: pending and rejected announcements make no publish/send calls; approval makes one of each");
    },
  });
  active();
  const out = join(work, "demo.gif");
  encoder = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-i",
      "clips.txt",
      "-vf",
      "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      "-loop",
      "0",
      out,
    ],
    { cwd: frames, stdio: "inherit" },
  );
  const [code] = await once(encoder, "close");
  assert.equal(code, 0, "ffmpeg failed");
  assert(Math.abs(videoInfo(out).duration - duration) < 0.2, "GIF export lost recorded footage");
  active();
  const temporary = join(repo, ".github/assets/.demo.gif.new");
  copyFileSync(out, temporary);
  renameSync(temporary, join(repo, ".github/assets/demo.gif"));
  say("wrote .github/assets/demo.gif");
  succeeded = true;
} catch (error) {
  console.error(error);
  if (existsSync(logFile)) console.error(readFileSync(logFile, "utf8").split("\n").slice(-35).join("\n"));
  console.error(`Full log: ${logFile}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
