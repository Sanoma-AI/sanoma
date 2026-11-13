import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { PermissionsGrid } from "./grid.ts";
import { defineConnector, defineDriver, DriverError } from "./op.ts";
import { COMMIT_ID } from "./shared.ts";

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
   * The draft `id` (letters, digits, `_` and `-`), opened on its branch (`draftBranch`): made from
   * the checked-out revision the first time, then the same one, edits and all, until its branch is
   * deleted.
   */
  draft?(id: string): Promise<Draft>;
  /** The open drafts' ids, sorted. */
  drafts?(): Promise<string[]>;
  /** What the draft `id` has committed since its branch left the checked-out one (read from the branch alone). */
  diff?(id: string): Promise<DraftDiff>;
  /** Closes the draft `id`: its checkout removed and its branch deleted, whatever it held; nothing when it is gone. */
  closeDraft?(id: string): Promise<void>;
  /**
   * Saves the draft `id` at its commit `head` into the checked-out branch: what it changes, merged
   * with what that branch gained since, as one commit titled `title` by `author` (a squash) that
   * names the save `run` (`saved` finds it by it), then closes the draft as `closeDraft` does, all
   * as one git write; a draft that will not close stays open, the commit made. Refused once the
   * draft's branch is not at `head`, while the checkout has uncommitted changes to any file git
   * tracks, when the draft changes nothing there, or when the two edit the same lines. The commit.
   */
  merge?(
    id: string,
    change: { head: string; title: string; author: string; run: string },
  ): Promise<{ revision: string }>;
  /** The commit `merge` made for the save `run` on the checked-out branch, and the files it changed; undefined when there is none. */
  saved?(run: string): Promise<{ revision: string; files: string[] } | undefined>;
  /**
   * Commits the undoing of `sha` (a commit of the checked-out branch; of a merge, what it brought
   * in) on the draft `id`, by `author`, opening the draft first as `draft` does; refused when this
   * repository does not have `sha`, or a later commit edits the same lines. The draft's commit after.
   */
  revert?(id: string, change: { sha: string; author: string }): Promise<{ revision: string }>;
  /**
   * Pushes the checked-out branch to `origin`, signed in as git on this machine is (its credential
   * helpers, its keys), never prompting; an error saying why, without the remote's credentials,
   * when `origin` refuses it (it has commits this branch lacks) or cannot be reached.
   */
  pushOrigin?(): Promise<void>;
  /**
   * The draft `id`'s branch as a git bundle (`git bundle create`), for a clone elsewhere (an agent
   * box's) to fetch: its commits since `since`, a commit that clone has, or the whole branch when
   * `since` is absent or a commit this repository lacks; no bytes when the clone has them all.
   * The branch's head beside it. A bundle holds commits and the branch's name alone: no remote,
   * no config, no credential.
   */
  bundle?(id: string, opts?: { since?: string }): Promise<{ bytes: Uint8Array; head: string }>;
  /**
   * Takes a bundle of the draft `id`'s branch made elsewhere (an agent box's new commits on it):
   * its commits fetched, then the draft's checkout fast-forwarded to them. Refused unless that is
   * a fast-forward that leaves what the checkout holds uncommitted in place. The branch's head after.
   */
  unbundle?(id: string, bytes: Uint8Array): Promise<{ head: string }>;
  /** The URL of the repository this one was cloned from (`origin`); undefined when it has none. */
  remoteUrl?(): Promise<string | undefined>;
  /**
   * Fast-forwards the branch `ref` to `ref` in the repository at `url`, signed in with `token`, as
   * `push` is, where it is checked out: the root's checked-out branch, or an open draft's (by its
   * `branch`), whose new commits on the host it takes so. Only when nothing is uncommitted there
   * and the remote's `ref` contains it; otherwise `skipped`, saying why. The revision after.
   */
  follow?(target: { url: string; token: string; ref: string }): Promise<{ revision: string } | { skipped: string }>;
  /**
   * How many commits the source repository of the app `folder` (the URL its `apps/<folder>/app.ts`
   * names) has on its default branch that the checked-out one lacks, of those changing what an
   * update merges (`apps/<folder>/` and `package.json`): fetched now. An error when the app names
   * no source.
   */
  behind?(folder: string): Promise<number>;
}

/** The branch of the draft `id`, as a source names it: `draft/<id>`. */
export const draftBranch = (id: string) => `draft/${id}`;

/** The draft whose branch `branch` is (`draftBranch`), or undefined for a branch that is no draft's. */
export const draftOf = (branch: string) => (branch.startsWith("draft/") ? branch.slice("draft/".length) : undefined);

/**
 * A draft: a checkout of its own, at `root`, on `branch`, which `commit` records in as
 * `Source.commit` does in its root. Its `node_modules` may be the root's own install, linked in:
 * a writer never writes under it.
 */
export interface Draft {
  branch: string;
  root: string;
  commit: Source["commit"];
  /**
   * Takes an app into the draft: fetches `ref` (the default branch by default) of the repository
   * at `url`, a source (a public company repo with one `apps/<folder>/`), and merges it in with its
   * history (`--allow-unrelated-histories`), as one merge commit by `author`. What it merges is
   * `apps/<folder>/` and `package.json`; every other file stays the draft's. `folder` may be left
   * out when the source has one app. Refused when the draft has `apps/<folder>/` already.
   */
  take?(app: { url: string; ref?: string; folder?: string; author: string }): Promise<AppMerge>;
  /**
   * Merges the new commits of the app `folder`'s source (the URL its `app.ts` names, its default
   * branch) into the draft, by `author`, as `take` merges: `apps/<folder>/` and `package.json`.
   */
  update?(app: { folder: string; author: string }): Promise<AppMerge>;
}

/**
 * What taking or updating an app merged into a draft. A line both sides changed is committed with
 * git's markers in its file (ours, the merge base and theirs), so the draft's checks fail until the
 * agent resolves it; a file one side deleted stays as the draft had it. The merge commit keeps the
 * source's history either way.
 */
export interface AppMerge {
  /** The app's folder: `apps/<folder>/`. */
  folder: string;
  /** The draft's commit after the merge. */
  revision: string;
  /** The source's commits the merge brought in that change the app's folder or `package.json`; 0 when the draft had them all, and nothing was merged. */
  merged: number;
  /** The files git could not merge, relative to the root, committed with conflict markers; empty when it merged clean. */
  conflicts: string[];
}

/** A draft's change: the files it touches, relative to the root, git's `--stat` of it, and the branch's commit it was read at. */
export interface DraftDiff {
  files: string[];
  summary: string;
  head: string;
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
 * `url` now, by `git ls-remote` (a branch first, then a tag, peeled; a full commit id is itself),
 * and the ref; with no `ref`, the repository's default branch (its `HEAD`) and the commit it names.
 * Apply calls it to fill a host's revision before it plans, and drift to see a merge. `resolveConfig`
 * registers it when a connector declares a host type.
 */
export const sourceOps = defineConnector("sanoma", {
  source: {
    resolve: {
      effect: "read",
      idempotent: true,
      description:
        "Resolve a branch or tag of a git repository, its default branch by default, to the commit it names now",
      input: z.object({ url: z.string().min(1), ref: z.string().min(1).optional() }),
      output: z.object({ revision: z.string(), ref: z.string() }),
      target: ({ url, ref }: { url: string; ref?: string }) => `${url}#${ref ?? "HEAD"}`,
    },
  },
});

export const SOURCE_RESOLVE = "sanoma.source.resolve" satisfies typeof sourceOps.source.resolve.id;

/** The driver of `sanoma.source.resolve`: git on this machine, with its own credential helpers. */
export const sourceDriver = defineDriver(sourceOps, {
  source: {
    resolve: async ({ url, ref }) =>
      ref === undefined ? defaultBranch(url) : { revision: await resolveRevision(url, ref), ref },
  },
});

/**
 * The fake of `sanoma.source.resolve`, which a sandbox run calls (`sandboxDrivers`): no git and no
 * network, a full commit id is itself as the driver has it, and any other ref the SHA-1 of
 * `<url>#<ref>`, so a scenario's revisions are the same on every run; the default branch is `main`.
 */
export const fakeSourceDriver = defineDriver(sourceOps, {
  source: {
    resolve: async ({ url, ref = "main" }) => ({
      revision: COMMIT_ID.test(ref) ? ref : createHash("sha1").update(`${url}#${ref}`).digest("hex"),
      ref,
    }),
  },
});

/** `git ls-remote` of `patterns` in the repository at `url`, with `options`, never prompting for credentials. */
async function lsRemote(url: string, patterns: string[], options: string[] = []): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["ls-remote", ...options, "--", url, ...patterns], {
    // Never a prompt for credentials: a repository that needs them and has none fails.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
  }).catch((err: { stderr?: string; message: string }) => {
    throw new DriverError(`git ls-remote ${url} failed: ${err.stderr?.trim() || err.message}`, {
      retryable: true,
      cause: err,
    });
  });
  return stdout;
}

/** The default branch of the repository at `url` (the branch its `HEAD` names) and the commit it names now. */
export async function defaultBranch(url: string): Promise<{ revision: string; ref: string }> {
  const stdout = await lsRemote(url, ["HEAD"], ["--symref"]);
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout)?.[1];
  const revision = /^([0-9a-f]{40,64})\tHEAD$/m.exec(stdout)?.[1];
  if (!branch || !revision) {
    throw new DriverError(`${url} names no default branch`, { retryable: false, vendorCode: "no_such_ref" });
  }
  return { revision, ref: branch };
}

/** The commit `ref` (a branch, a tag, `HEAD`, a full ref or a commit id) names in the repository at `url`. */
export async function resolveRevision(url: string, ref: string): Promise<string> {
  if (COMMIT_ID.test(ref)) return ref;
  const stdout = await lsRemote(url, [ref, `${ref}^{}`]);
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
 * One repository on a host, opened by its remote half with the company's credentials, read when
 * a call needs them; a half may keep a token for a few minutes (its README says how long), so a
 * token stored later is used soon after. A failure is a `DriverError` (retryable as the host's
 * status says).
 */
export interface SourceHost {
  /**
   * A token that writes to the repository: the company's app's on the host when it is installed
   * on the owner, else a person's token (`prefer: "token"` asks for that one first). It is never
   * logged; a push signs in with it. A `DriverError` whose `vendorCode` is `no_token` when there is
   * neither.
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
  /** The permissions the company's app on the host holds, by name (`contents: "write"`), as the host lists them; undefined without the app's keys. */
  permissions?(context: RemoteContext): Promise<Record<string, string> | undefined>;
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
