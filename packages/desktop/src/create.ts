import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Company } from "./companies.ts";
import { gitEnv, gitFailure } from "./git.ts";
import { launch, launcherEnv, spawnGroup, type Stream } from "./launcher.ts";
import { isCompanyFolder } from "./places.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { writeShims } from "./shims.ts";

/**
 * Where the folder dialogs for a new or cloned company start: the folder the most recently opened
 * company is in, while it is there, else the home folder.
 */
export function defaultParent(
  companies: readonly Company[],
  home: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const last = companies[0] && dirname(companies[0].path);
  return last && exists(last) ? last : home;
}

/**
 * Why a new company cannot start in `dir`, in one line; undefined when it can: the folder is
 * empty, dotfiles aside, as the launcher's init requires (anywhere else it does nothing).
 */
export function newCompanyProblem(dir: string): string | undefined {
  const files = readdirSync(dir).filter((name) => !name.startsWith("."));
  return files.length ? `${dir} has files in it already: a new company starts in an empty folder.` : undefined;
}

/**
 * Starts a company in an empty folder: the launcher's own init (`pnpm dlx sanoma`, sanoma from
 * npm) with the shell's Node and pnpm shims and the environment of a run (`launcherEnv`). It
 * copies the template, commits and installs, then serves the company it started from that
 * company's own `node_modules/sanoma`, so its window opens as an opened company's does. A folder
 * that holds files (an init that got that far, retried) is opened as any other (`startSession`).
 */
export function createSession(options: SessionOptions): Session {
  if (newCompanyProblem(options.repo)) return startSession(options);
  const { repo, port, node, pnpm, bin, onLine, onProgress, killAfterMs, pollMs } = options;
  writeShims(bin, node, pnpm);
  onProgress("Starting a new company with sanoma from npm");
  const env = launcherEnv(options.env, bin, port);
  const launched = launch({
    cwd: repo,
    env,
    onLine,
    killAfterMs,
    node,
    cli: pnpm,
    args: ["dlx", "sanoma"],
    port,
    pollMs,
  });
  return { ready: launched.ready, ended: launched.exited, stop: launched.stop };
}

/** An address git clones from: a web, ssh, git or file URL, or ssh's `user@host:path`. */
export const isCloneUrl = (url: string) => /^(https?|ssh|git|file):\/\/\S+$|^[\w.-]+@[\w.-]+:\S+$/.test(url);

/** The folder name a clone of `url` gets, as git names it: the last part of the path, without `.git`. */
export function repoNameOf(url: string): string | undefined {
  const name = url
    .replace(/[/\\]+$/, "")
    .split(/[/:]/)
    .at(-1)
    ?.replace(/\.git$/, "");
  return name && /^[\w.-]+$/.test(name) && name !== "." && name !== ".." ? name : undefined;
}

/** Why `url` is not an address to clone, in one line; undefined when git can try it. */
export function addressProblem(url: string): string | undefined {
  if (!isCloneUrl(url)) return "That is not a repository's address: paste one such as https://github.com/acme/company.";
  if (!repoNameOf(url)) return `Sanoma cannot tell what to name the folder for ${url}.`;
  return undefined;
}

/** Where a clone of `url` (an address `addressProblem` accepts) goes in `parent`, or why not there, in one line. */
export function cloneTarget(url: string, parent: string): { dir: string } | { problem: string } {
  const name = repoNameOf(url)!;
  const dir = join(parent, name);
  return existsSync(dir)
    ? { problem: `${parent} has a ${name} already: choose another folder to clone into.` }
    : { dir };
}

/** A clone running: `done` resolves with why it failed, in one line, or undefined once it is there. */
export interface Cloning {
  done: Promise<string | undefined>;
  stop(): Promise<void>;
}

/**
 * Clones `url` into `dir` with the system git, each line it prints going to `onLine`. `env` is
 * git's (`gitEnv`): it never prompts, so a repository that needs a sign-in the OS does not have
 * fails at once, and says so (`gitFailure`).
 */
export function cloneCompany(
  url: string,
  dir: string,
  { env, onLine }: { env: NodeJS.ProcessEnv; onLine: (stream: Stream, line: string) => void },
): Cloning {
  const said: string[] = [];
  const group = spawnGroup("git", ["clone", "--", url, dir], {
    cwd: dirname(dir),
    env,
    onLine(stream, line) {
      if (stream === "stderr") said.push(line);
      onLine(stream, line);
    },
  });
  const done = group.exited.then(({ code, signal }) => {
    if (code === 0) return undefined;
    const stderr = said.join("\n") || (signal ? `stopped (${signal})` : `exit code ${code}`);
    return gitFailure(stderr, `git could not clone ${url}`);
  });
  return { done, stop: group.stop };
}

/** Why a cloned folder cannot be opened: it holds no company. */
const notACompany = (dir: string) =>
  new Error(`${dir} holds no company (no sanoma.config.ts): remove it, then clone a company's repository.`);

/**
 * The session of a company cloned from `url`: `git clone` into its folder (`cloneCompany`, with
 * `gitEnv`), then the company opened there (`startSession`), or opened at once when the folder is
 * a company already (a clone that finished, retried). A failed clone ends it with git's one line,
 * and a folder that holds no company with that.
 */
export const cloneSession =
  (url: string) =>
  (options: SessionOptions): Session => {
    if (isCompanyFolder(options.repo)) return startSession(options);
    let opened: Session | undefined;
    let stopped = false;
    let cloning: Cloning | undefined;
    if (!existsSync(options.repo)) {
      options.onProgress("Cloning");
      cloning = cloneCompany(url, options.repo, { env: gitEnv(options.env), onLine: options.onLine });
    }
    const started = (cloning?.done ?? Promise.resolve(undefined)).then((failed) => {
      if (failed) throw new Error(failed);
      if (!isCompanyFolder(options.repo)) throw notACompany(options.repo);
      if (!stopped) opened = startSession(options);
      return opened;
    });
    const ready = started.then((session) => session?.ready ?? Promise.reject(new Error("stopped")));
    ready.catch(() => {});
    const ended = started.then(
      async (session) => (session ? await session.ended : { code: null, signal: null }),
      (err: unknown) => ({ code: null, signal: null, error: (err as Error).message }),
    );
    return {
      ready,
      ended,
      async stop() {
        stopped = true;
        await cloning?.stop();
        await opened?.stop();
        await ended;
      },
    };
  };
