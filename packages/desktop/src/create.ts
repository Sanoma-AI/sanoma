import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDatabaseEvent, startedStage } from "./events.ts";
import type { Company } from "./companies.ts";
import { gitEnv, gitFailure } from "./git.ts";
import { launch, launcherEnv, spawnGroup, type Stream } from "./launcher.ts";
import { ADDING_YOU, CLONING, FROM_TEMPLATE, folderNameOf, INSTALLING, OPENING, STARTING } from "./pages.ts";
import { isCompanyFolder } from "./places.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { writeShims } from "./shims.ts";

/**
 * Where a new or cloned company goes first: the folder the most recently opened company is in,
 * while it is there, else `~/Companies`, clear of the Desktop and Documents that iCloud often keeps.
 */
export function defaultParent(
  companies: readonly Company[],
  home: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const last = companies[0] && dirname(companies[0].path);
  return last && exists(last) ? last : join(home, "Companies");
}

/** Whether `dir` holds anything but dotfiles: the launcher's init starts only where it does not. */
export const hasFiles = (dir: string) => readdirSync(dir).some((name) => !name.startsWith("."));

/**
 * The folder a new company called `name` goes in, under `parent` (made by whoever starts it), or
 * why not, in one line.
 */
export function newCompanyTarget(name: string, parent: string): { dir: string } | { problem: string } {
  const folder = folderNameOf(name);
  if (!folder) return { problem: "Give the company a name, with a letter or a number in it." };
  const dir = join(parent, folder);
  try {
    if (!existsSync(dir)) return { dir };
    if (!statSync(dir).isDirectory()) return { problem: `${dir} is a file: give the company another name.` };
    if (isCompanyFolder(dir)) return { problem: `${dir} holds a company already: open it instead.` };
    return hasFiles(dir)
      ? { problem: `${dir} has files in it already: give the company another name, or choose another place.` }
      : { dir };
  } catch (err) {
    return { problem: `Sanoma could not read ${dir}: ${(err as Error).message}` };
  }
}

/** What the new company form asks: the company's name, and the name and email of whoever starts it. */
export interface NewCompany {
  name: string;
  you: string;
  email: string;
}

/** The step each stage of `sanoma init` begins (`startedStage`): its `git` stage is part of adding you. */
const STAGE_STEPS: Record<string, string> = {
  template: FROM_TEMPLATE,
  people: ADDING_YOU,
  install: INSTALLING,
  database: STARTING,
};

/**
 * The step a line of a new company's start reports: each stage of `sanoma init` as it begins, and
 * the app opening once the company's database answers (the `database` event). Undefined for any
 * other line.
 */
export function stepOf(line: string): string | undefined {
  const stage = startedStage(line);
  return stage ? STAGE_STEPS[stage] : isDatabaseEvent(line) ? OPENING : undefined;
}

/** `pnpm dlx sanoma` with `args` in the company's folder, with the shell's Node and pnpm shims and the environment of a run (`launcherEnv`). */
function dlxSanoma(options: SessionOptions, args: readonly string[]): Session {
  const { repo, port, node, pnpm, bin, onLine, killAfterMs, pollMs } = options;
  const launched = launch({
    cwd: repo,
    env: launcherEnv(options.env, writeShims(bin, node, pnpm), port),
    onLine,
    killAfterMs,
    node,
    cli: pnpm,
    // The newest sanoma, today's release too: the template's exclusions, which leave third-party
    // packages under pnpm's minimum release age.
    args: [
      "--config.minimumReleaseAgeExclude=sanoma",
      "--config.minimumReleaseAgeExclude=@sanoma-ai/*",
      "dlx",
      "sanoma",
      ...args,
    ],
    port,
    pollMs,
  });
  return { ready: launched.ready, ended: launched.exited, stop: launched.stop };
}

/**
 * Starts a company in an empty folder: the launcher's own init, `pnpm dlx sanoma init` with the
 * form's answers (sanoma from npm), which copies the template, declares whoever starts it, commits
 * and installs, then serves the company it started from that company's own `node_modules/sanoma`,
 * so its window opens as an opened company's does. A folder that holds files (an init that got
 * that far, retried) is opened as any other. Its progress: init's stages, then the database
 * answering (`stepOf`).
 */
export const createSession =
  ({ name, you, email }: NewCompany) =>
  (options: SessionOptions): Session => {
    // Start again, after the person removed the empty folder a failed start left.
    mkdirSync(options.repo, { recursive: true });
    let last: string | undefined;
    const report = (step: string) => {
      if (step !== last) options.onProgress((last = step));
    };
    const reporting: SessionOptions = {
      ...options,
      onLine(stream, line) {
        options.onLine(stream, line);
        const step = stream === "stdout" ? stepOf(line) : undefined;
        if (step) report(step);
      },
      onProgress: report,
    };
    if (hasFiles(options.repo)) return startSession(reporting);
    report("Starting a new company with sanoma from npm");
    // Each value joined to its flag: one that starts with "-" is still its value.
    return dlxSanoma(reporting, ["init", `--name=${name}`, `--you=${you}`, `--email=${email}`]);
  };

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
    ? { problem: `${parent} has a ${name} already: choose another folder to copy it into.` }
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
  new Error(`${dir} holds no company (no sanoma.config.ts): remove it, then copy a company from GitHub.`);

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
      options.onProgress(CLONING);
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
