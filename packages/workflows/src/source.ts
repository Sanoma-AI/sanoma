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
  /** The repo's Permissions grid (`permissionsGrid`), when its config loaded and its policies hold: what a change is reviewed by. */
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

// A git host's side of a change: the pull request a branch is reviewed in, merged through and
// closed by, the `sanoma` commit status the review card links from, whether the host refuses a
// change to `main` that is not a merge, and the host's webhooks. A connector carries it as its
// remote half (`ConnectorSetup.remote`), the way a login or a model half is carried.

/** A repository on a host: `owner/name`. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** A pull request (a merge request, on a host that calls it so), as a change follows it. */
export interface PullRequest {
  number: number;
  /** Its page on the host. */
  url: string;
  /** The branch it merges. */
  branch: string;
  /** The branch's commit it was read at. */
  head: string;
  state: "open" | "closed" | "merged";
  /** The commit its merge made on the base branch, once merged. */
  mergeSha?: string;
}

/**
 * Whether the host refuses a change to a branch that does not follow the rules: `pullRequest`
 * when a direct push is refused (every change is a merge), `check` when a merge needs the
 * `sanoma` status to pass. `reason` says why neither can be read or held, such as a plan that
 * has no rules.
 */
export interface HostEnforcement {
  pullRequest: boolean;
  check: boolean;
  reason?: string;
}

/**
 * One repository on a host, opened by its remote half with the company's credentials. Every
 * call reads them when made, so a token stored later is used; a failure is a `DriverError`
 * (retryable as the host's status says).
 */
export interface SourceHost {
  /**
   * A token that writes to the repository: the company's app's on the host when it is installed
   * on the owner, else a person's token (`prefer: "token"` asks for that one first). It is never
   * logged; a push signs in with it.
   */
  token(prefer?: "app" | "token"): Promise<string>;
  /** The pull request of `branch`: the open one, else the latest; undefined when it has none. */
  pullRequestFor(branch: string): Promise<PullRequest | undefined>;
  pullRequest(number: number): Promise<PullRequest>;
  /** Opens a pull request of `branch` into `base`; the open one when `branch` has one already. */
  openPullRequest(request: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  /**
   * Squash-merges pull request `number` when its branch is still at `sha`, as one commit titled
   * `title`. A `DriverError` whose `vendorCode` is `head_moved` when the branch moved on, and
   * `not_mergeable` when the host refuses the merge (a conflict, a rule).
   */
  mergePullRequest(number: number, merge: { sha: string; method: "squash"; title?: string }): Promise<{ sha: string }>;
  closePullRequest(number: number): Promise<void>;
  /** Deletes `branch`; nothing when it is gone already. */
  deleteBranch?(branch: string): Promise<void>;
  /** Sets the `sanoma` status on commit `sha`, linking to `targetUrl`. */
  setStatus(status: {
    sha: string;
    state: "pending" | "success" | "failure";
    description: string;
    targetUrl?: string;
  }): Promise<void>;
  /** What the host enforces on `base` (see `HostEnforcement`). */
  enforcement(base: string): Promise<HostEnforcement>;
  /** Uploads a PNG the pull request's comment shows; its URL. */
  uploadImage?(png: Uint8Array, name: string): Promise<string>;
  /** Writes the pull request's comment that carries `marker`, once: a second call edits it. */
  upsertComment?(number: number, marker: string, body: string): Promise<void>;
}

/** What a host's webhook says happened: a branch pushed, or a pull request closed (merged or not). */
export type RemoteEvent =
  | { kind: "pushed"; repo: RepoRef; branch: string; head: string }
  | { kind: "closed"; repo: RepoRef; branch: string; number: number; merged: boolean; sha?: string };

/** What a remote half reads the company's credentials with, as a login or a model half reads them. */
export interface RemoteContext {
  /** Secrets' values by name: the environment's first, then the stored credentials (`LoginContext.secrets`). */
  secrets(names: readonly string[]): Promise<Map<string, string>>;
}

/** A connector's remote half (`ConnectorSetup.remote`): a git host's repositories, made once per resolved config. */
export interface RemoteHalf {
  /** The repository a clone URL of this host names, or undefined for another host's. */
  matches(url: string): RepoRef | undefined;
  /** The repository `repo`, with the company's credentials. */
  open(repo: RepoRef, context: RemoteContext): SourceHost;
  /**
   * The events a webhook request carries, once its signature is verified: throws for a missing or
   * bad signature, and answers `[]` for an event the change workflow does not follow.
   */
  webhook?(request: Request, context: RemoteContext): Promise<RemoteEvent[]>;
  /** The accounts the company's app on the host is installed on: where it acts with no person's token. */
  owners?(context: RemoteContext): Promise<{ login: string; kind: "user" | "organization" }[]>;
}

/** The remote half among `remotes` (`ResolvedConfig.remotes`) whose host `url` is on, with its vendor and the repository. */
export function remoteFor(
  remotes: ReadonlyMap<string, RemoteHalf>,
  url: string,
): { vendor: string; remote: RemoteHalf; repo: RepoRef } | undefined {
  for (const [vendor, remote] of remotes) {
    const repo = remote.matches(url);
    if (repo) return { vendor, remote, repo };
  }
  return undefined;
}
