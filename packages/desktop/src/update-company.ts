import { gitFailure, type Run, run } from "./git.ts";

/** The one line for local work Get Updates would put at risk: changes not committed, or commits not pushed. */
export const LOCAL_CHANGES = "This computer has changes that are not on GitHub yet; nothing was changed";

const nothing = () => undefined;

/** The lockfile the shell's own `pnpm install --prefer-offline` (`startSession`) may rewrite. */
export const LOCKFILE = "pnpm-lock.yaml";

/**
 * The person's own changes in `git status --porcelain=v2` output, one line each: all but the root
 * lockfile changed in the tree only (`.M`), which is the shell's own install's doing, and which
 * `fastForward` puts back before it moves `main`.
 */
export const ownChanges = (status: string): string[] =>
  status.split("\n").filter((line) => line && !/^1 \.M (\S+ ){6}pnpm-lock\.yaml$/.test(line));

/** What Get Updates found: why it does nothing, or how many commits `main` is behind GitHub's (0: up to date). */
export type UpdatePlan = { refused: string } | { behind: number };

/**
 * Whether the company in `repo` can take GitHub's `main`, and how far behind it is. It refuses,
 * in one line and changing nothing, unless the repository has an `origin`, is on `main` and has
 * nothing of its own: no change in the tree (untracked files included; a lockfile the shell's
 * install rewrote is not the person's, `ownChanges`) and no commit `origin` does not have.
 * Otherwise it fetches `origin`'s `main` into `origin/main` and counts what is new.
 */
export async function prepareUpdate(repo: string, env: NodeJS.ProcessEnv, exec: Run = run): Promise<UpdatePlan> {
  const git = (...args: string[]) => exec("git", args, { cwd: repo, env });
  if ((await git("remote", "get-url", "origin").catch(nothing)) === undefined) {
    return { refused: "This company has no repository on GitHub (no origin) to get updates from; nothing was changed" };
  }
  const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(nothing);
  if (branch !== "main") {
    const where = branch === undefined ? "not on a branch" : `on the branch ${branch}`;
    return { refused: `This company is ${where}, and updates come to main; nothing was changed` };
  }
  if (ownChanges(await git("status", "--porcelain=v2")).length) return { refused: LOCAL_CHANGES };
  try {
    await git("fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    if (/couldn't find remote ref/i.test(said)) {
      return { refused: "The company's repository on GitHub has no main branch; nothing was changed" };
    }
    return { refused: gitFailure(said, "Sanoma could not get updates") };
  }
  const [ahead, behind] = (await git("rev-list", "--left-right", "--count", "HEAD...origin/main"))
    .split(/\s+/)
    .map(Number);
  if (ahead) return { refused: LOCAL_CHANGES };
  return { behind: behind ?? 0 };
}

/**
 * Moves `main` to the fetched `origin/main`, only forward (`git pull --ff-only`, without fetching
 * again), after putting back the lockfile the shell's install rewrote (`ownChanges`), so that a
 * lockfile GitHub changed applies; the start after the update installs from it.
 */
export async function fastForward(repo: string, env: NodeJS.ProcessEnv, exec: Run = run): Promise<void> {
  const git = (...args: string[]) => exec("git", args, { cwd: repo, env });
  await git("diff", "--quiet", "--", LOCKFILE).catch(() => git("checkout", "--", LOCKFILE));
  await git("merge", "--ff-only", "--quiet", "origin/main");
}
