import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { IngressRoute } from "sanoma/app";
import { envWakeup, errorMessage, isLoopback, type SanomaConfig, startWorker, superviseWorker } from "sanoma/workflows";
import { APP_BUNDLE_HEADER, APP_BUNDLE_PATH } from "sanoma/workflows/shared";
import { listenRoutes } from "./listen.ts";
import { rootOf, type Stoppable, wakeRoute, workerOptions } from "./serve.ts";

/** Runs `command` with `args` in `cwd`, resolving once it exits 0; rejects with why otherwise. */
export type Run = (command: string, args: string[], cwd: string) => Promise<void>;

/** The last part of what a command printed that a failure carries. */
const TAIL = 4_000;
/** How long one command may take: a checkout, install or build that hangs would hold every later build. */
const TIMEOUT_MS = 20 * 60_000;

/** `Run` as a child process, its output passed on to this process's stderr and the end of it kept for a failure. */
const runChild: Run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS });
    let tail = "";
    const keep = (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      const said = tail.trim();
      reject(
        new Error(
          `${command} ${args.join(" ")} ${signal ? `ended by ${signal}` : `exited ${code}`}${said ? `: ${said}` : ""}`,
        ),
      );
    });
  });

export interface AppBundleOptions {
  /** The checkout the worker runs: a revision's own is made beside it. */
  root: string;
  /** The instance token (`SANOMA_WAKEUP_TOKEN`) the route takes as a bearer; unset, it refuses every request. */
  token: string | undefined;
  /**
   * The command that checks a revision of the source out into a directory and installs it, as
   * `<checkout> <dir> <revision>` (`SANOMA_CHECKOUT`: the runtime image's `sanoma-checkout`).
   */
  checkout: string | undefined;
  log: (line: string) => void;
  /** Default: a child process. */
  run?: Run;
  /** Told when a build is queued with none under way (true), and when the last one queued ends (false). */
  onBuilding?: (building: boolean) => void;
}

/** A commit id, short or full (SHA-1 or SHA-256). */
const REVISION = /^[0-9a-f]{7,64}$/;

const digest = (text: string) => createHash("sha256").update(text).digest();

/** A built revision's answer: its status, and the body, or the file beside the root that holds it (a bundle is megabytes). */
type Answer = { status: number; body: string } | { status: 200; file: string };

/** An answer of the route, as JSON, never cached, and marked as the route's (`APP_BUNDLE_HEADER`). */
const answered = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", [APP_BUNDLE_HEADER]: "1" },
  });

/**
 * `GET /__sanoma/app-bundle?revision=R` with the instance token: the app bundle the Cloudflare
 * host's Worker script runs at R, which a deploy downloads before it uploads the script. Built on
 * the first ask, in the background and one revision at a time: R checked out and installed beside
 * the worker's checkout (`checkout`), and built there by its own `sanoma app-bundle`
 * (`buildAppBundle`) into a file beside it, the checkout removed after. 202 while it builds, then
 * 200 with the bundle (`AppBundle`) as JSON, the file kept for the process's lifetime. A failed
 * build answers 500 with why, once, and the next ask builds again.
 */
export function appBundleRoute({
  root,
  token,
  checkout,
  log,
  run = runChild,
  onBuilding,
}: AppBundleOptions): IngressRoute {
  const expected = token && digest(`Bearer ${token}`);
  const answers = new Map<string, Answer | "building">();
  // One build at a time: each is a Vite build of the whole app, on a container's memory.
  let queue = Promise.resolve();
  let queued = 0;

  const build = async (revision: string): Promise<Answer> => {
    if (!checkout) throw new Error("SANOMA_CHECKOUT is not set: the app bundle is built in the runtime image");
    const dir = join(dirname(root), `${basename(root)}-${revision}`);
    const file = `${dir}.json`;
    try {
      await run(checkout, [dir, revision], root);
      await run("pnpm", ["exec", "sanoma", "app-bundle", "--out", file], dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    log(`built the app bundle at ${revision}`);
    return { status: 200, file };
  };

  return {
    method: "GET",
    path: APP_BUNDLE_PATH,
    async handle(request) {
      if (!expected || !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), expected)) {
        return answered(401, { error: "the token is not this instance's SANOMA_WAKEUP_TOKEN" });
      }
      const revision = new URL(request.url).searchParams.get("revision") ?? "";
      if (!REVISION.test(revision)) return answered(400, { error: "revision must be a commit id (?revision=<sha>)" });
      const answer = answers.get(revision);
      if (answer === undefined) {
        answers.set(revision, "building");
        if (queued++ === 0) onBuilding?.(true);
        queue = queue
          .then(() => build(revision))
          .catch((err: unknown): Answer => {
            log(`building the app bundle at ${revision} failed: ${errorMessage(err)}`);
            return { status: 500, body: JSON.stringify({ error: errorMessage(err) }) };
          })
          .then((built) => {
            answers.set(revision, built);
            if (--queued === 0) onBuilding?.(false);
          });
      }
      if (answer === undefined || answer === "building") return answered(202, { building: revision });
      if (answer.status === 500) answers.delete(revision);
      return answered(answer.status, "file" in answer ? await readFile(answer.file, "utf8") : answer.body);
    },
  };
}

export interface WorkerPortOptions extends Omit<AppBundleOptions, "root"> {
  host: string;
  port: number;
  /** What `GET /wake` hands each wake to: the supervised worker's `wake`. */
  onWake: () => void | Promise<void>;
}

/**
 * The worker's internal port, for its host: `GET /healthz` (200: it listens once the worker
 * runs), `GET /wake` (`wakeRoute`) and the app bundle (`appBundleRoute`).
 */
export function listenWorkerPort(root: string, { host, port, onWake, ...bundle }: WorkerPortOptions) {
  return listenRoutes([wakeRoute({ onWake, log: bundle.log }), appBundleRoute({ root, ...bundle })], {
    host,
    port,
    log: bundle.log,
    name: "sanoma worker",
  });
}

/**
 * `sanoma worker`. With `PORT` set (a host's container port), the worker under a supervisor
 * (`superviseWorker`: beyond loopback, it stops itself when nothing can run soon and a wake starts
 * it again) and its port on `SANOMA_APP_HOST` (default 127.0.0.1) and `PORT` once it runs. Without
 * one, a worker that never stops itself, since nothing in this process would start it again.
 *
 * On a host that starts the process again on a wake (its own wake route in the environment,
 * `envWakeup`), being done means ending: once the worker stopped itself and no app bundle is
 * building, `exit` is called, as a signal's stop, and the container ends with the process. A wake
 * before that wins (the supervisor starts a fresh worker); one after it finds the port closed, so
 * the host starts a fresh process. A build that ends while the worker is stopped starts a fresh
 * one, which ends the process on its own check, once the deploy that asked had time to take it.
 */
export async function runWorker(
  config: SanomaConfig,
  log: (line: string) => void,
  exit: () => void,
): Promise<Stoppable> {
  const port = process.env.PORT;
  if (!port) {
    const worker = await startWorker(config, workerOptions(config));
    return { stop: () => worker.stop() };
  }
  const host = process.env.SANOMA_APP_HOST || "127.0.0.1";
  const exits = envWakeup(process.env) !== undefined;
  let building = false;
  // Synchronous up to the port's close (`exit` stops it first), so no wake is answered after this.
  const done = () => {
    if (exits && supervised.stopped && !building) exit();
  };
  const supervised = await superviseWorker(config, {
    ...workerOptions(config),
    selfStop: !isLoopback(host),
    onStopped: done,
  });
  try {
    const listening = await listenWorkerPort(rootOf(config), {
      host,
      port: Number(port),
      onWake: () => supervised.wake(),
      token: process.env.SANOMA_WAKEUP_TOKEN,
      checkout: process.env.SANOMA_CHECKOUT,
      log,
      onBuilding(now) {
        building = now;
        if (!now && exits && supervised.stopped) void supervised.wake();
      },
    });
    log(`the worker's port at ${listening.url}`);
    return {
      async stop() {
        try {
          await listening.stop();
        } finally {
          await supervised.stop();
        }
      },
    };
  } catch (err) {
    await supervised.stop().catch(() => {});
    throw err;
  }
}
