import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Company } from "./companies.ts";
import { AUTH_MESSAGE, isAuthFailure } from "./git.ts";
import { launch, launcherEnv, spawnGroup, type Stream } from "./launcher.ts";
import type { Session, SessionOptions } from "./session.ts";
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
 * company's own `node_modules/sanoma`, so its window opens as an opened company's does.
 */
export function createSession(options: SessionOptions): Session {
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

/** Where a clone of `url` goes in `parent`, or why it cannot, in one line. */
export function cloneTarget(url: string, parent: string): { dir: string } | { problem: string } {
  const problem = addressProblem(url);
  if (problem) return { problem };
  const name = repoNameOf(url)!;
  const dir = join(parent, name);
  if (existsSync(dir)) return { problem: `${parent} has a ${name} already: choose another folder to clone into.` };
  return { dir };
}

/** A clone running: `done` resolves with why it failed, in one line, or undefined once it is there. */
export interface Cloning {
  done: Promise<string | undefined>;
  stop(): Promise<void>;
}

/**
 * Clones `url` into `dir` with the system git, each line it prints going to `onLine`. `env` is
 * git's (`gitEnv`): it never prompts, so a repository that needs a sign-in the OS does not have
 * fails at once, and says so (`AUTH_MESSAGE`).
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
    const stderr = said.join("\n");
    if (isAuthFailure(stderr)) return AUTH_MESSAGE;
    const last = said.findLast((line) => line.trim()) ?? (signal ? `stopped (${signal})` : `exit code ${code}`);
    return `git could not clone ${url}: ${last.replace(/^fatal: /, "")}`;
  });
  return { done, stop: group.stop };
}
