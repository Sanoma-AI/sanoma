import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { PermissionsGrid } from "./grid.ts";
import { defineConnector, defineDriver, DriverError } from "./op.ts";

// Where a company's files live, and how a change to them is recorded: a git repository on this
// machine, or one a host cloned. The runtime's writers (the app's Adopt, apply's lockfile) change
// files under `root`, then commit them through it. The launcher makes one; a config without one
// writes the files and commits nothing. A writer that must leave the live checkout alone writes
// in a draft instead: a checkout of its own, on a branch of its own.

/** A company's repository, as the runtime writes to it. */
export interface Source {
  /** The repository's root directory. */
  root: string;
  /**
   * Records the files at `paths`, relative to `root`, as one change by `author` (who made it, as
   * the app names them: a login or a typed name). Its revision; undefined when nothing changed.
   */
  commit(change: {
    paths: string[];
    message: string;
    author: string;
  }): { revision: string } | undefined | Promise<{ revision: string } | undefined>;
  /** The revision `ref` names, the checked-out one by default (a draft's by its `branch`). */
  head(ref?: string): string | Promise<string>;
  /** Pushes `ref` to the repository at `url`, signed in with `token` (a draft by its `branch`). */
  push?(target: { url: string; token: string; ref: string }): void | Promise<void>;
  /**
   * The draft `id` (letters, digits, `_` and `-`), opened: made from the checked-out revision the
   * first time, then the same one, edits and all, until its branch is deleted.
   */
  draft?(id: string): Promise<Draft>;
  /** The open drafts' ids, sorted. */
  drafts?(): Promise<string[]>;
  /** What the draft `id` has committed since its branch left the checked-out one (read from the branch alone). */
  diff?(id: string): Promise<DraftDiff>;
  /** Closes the draft `id`: its checkout removed and its branch deleted, whatever it held; nothing when it is gone. */
  closeDraft?(id: string): Promise<void>;
  /**
   * `sanoma check` on the draft `id`, as a child in its checkout, one at a time in the process. A
   * check that gives no result (a config that does not load, no install, a timeout) is a result
   * of one problem saying why.
   */
  check?(id: string): Promise<CheckResult>;
  /** The URL of the repository this one was cloned from (`origin`); undefined when it has none. */
  remoteUrl?(): Promise<string | undefined>;
  /**
   * Fast-forwards the checked-out branch to `ref` in the repository at `url`, signed in with
   * `token`, as `push` is: only when `ref` is checked out, nothing is uncommitted and the remote's
   * `ref` contains it; otherwise `skipped`, saying why. The checked-out revision after.
   */
  follow?(target: { url: string; token: string; ref: string }): Promise<{ revision: string } | { skipped: string }>;
}

/**
 * A draft: a checkout of its own, at `root`, on `branch`, which `commit` records in as
 * `Source.commit` does in its root. Its `node_modules` may be the root's own install, linked in:
 * a writer never writes under it.
 */
export interface Draft {
  branch: string;
  root: string;
  commit: Source["commit"];
}

/** A draft's change: the files it touches, relative to the root, and git's `--stat` of it. */
export interface DraftDiff {
  files: string[];
  summary: string;
}

/** What `sanoma check` finds in a repo (a draft's too). */
export interface CheckResult {
  ok: boolean;
  /** One printable line each: `<file>:<line>:<col>: <message>`, or `<scenario> › <step>: <message>`. */
  problems: string[];
  /** What is worth fixing but not wrong, one line each, `<file>:<line>:<col>: warning: <message>`: the sites' `warnings`. */
  warnings: string[];
  /** The repo's Permissions grid (`permissionsGrid`), when its config loaded: what a change is reviewed by. */
  grid?: PermissionsGrid;
}

/**
 * The built-in operation `sanoma.source.resolve`: the commit `ref` names in the repository at
 * `url` now, by `git ls-remote` (a branch first, then a tag, peeled; a full commit id is itself).
 * Apply calls it to fill a host's revision before it plans, and drift to see a merge. `resolveConfig`
 * registers it when a connector declares a host type.
 */
export const sourceOps = defineConnector("sanoma", {
  source: {
    resolve: {
      effect: "read",
      idempotent: true,
      description: "Resolve a branch or tag of a git repository to the commit it names now",
      input: z.object({ url: z.string().min(1), ref: z.string().min(1) }),
      output: z.object({ revision: z.string() }),
      target: ({ url, ref }: { url: string; ref: string }) => `${url}#${ref}`,
    },
  },
});

export const SOURCE_RESOLVE = "sanoma.source.resolve" satisfies typeof sourceOps.source.resolve.id;

/** The driver of `sanoma.source.resolve`: git on this machine, with its own credential helpers. */
export const sourceDriver = defineDriver(sourceOps, {
  source: { resolve: async ({ url, ref }) => ({ revision: await resolveRevision(url, ref) }) },
});

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commit `ref` (a branch, a tag, `HEAD`, a full ref or a commit id) names in the repository at `url`. */
export async function resolveRevision(url: string, ref: string): Promise<string> {
  if (COMMIT.test(ref)) return ref;
  const { stdout } = await promisify(execFile)("git", ["ls-remote", "--", url, ref, `${ref}^{}`], {
    // Never a prompt for credentials: a repository that needs them and has none fails.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
  }).catch((err: { stderr?: string; message: string }) => {
    throw new DriverError(`git ls-remote ${url} failed: ${err.stderr?.trim() || err.message}`, {
      retryable: true,
      cause: err,
    });
  });
  const refs = new Map(
    stdout.split("\n").flatMap((line) => {
      const [sha, name] = line.split("\t");
      return sha && name ? [[name, sha] as const] : [];
    }),
  );
  for (const name of [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, ref]) {
    const sha = refs.get(name);
    if (sha) return sha;
  }
  throw new DriverError(`${url} has no branch or tag ${ref}`, { retryable: false, vendorCode: "no_such_ref" });
}
