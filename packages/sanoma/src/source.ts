import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Draft, Source } from "@sanoma-ai/workflows";

const run = promisify(execFile);

/** Git in `cwd`: its output, trimmed. */
const gitIn = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  (await run("git", args, { cwd, env: { ...process.env, ...env } })).stdout.trim();

/** Whether git in `cwd` ignores `path`; a failure of git's own (exit 128) is thrown. */
const ignores = (cwd: string, path: string) =>
  gitIn(cwd, ["check-ignore", "--quiet", "--", path]).then(
    () => true,
    (err: { code?: unknown }) => {
      if (err.code === 1) return false;
      throw err;
    },
  );

/** A draft's id: a name, never a path. */
const DRAFT_ID = /^[\w-]{1,64}$/;

/** The branch of the draft `id`, refused unless the id is a name. */
function branchOf(id: string): string {
  if (!DRAFT_ID.test(id)) throw new Error(`A draft's id is letters, digits, _ and -: ${JSON.stringify(id)}`);
  return `draft/${id}`;
}

// One git write at a time in this process, whichever source makes it: two tool calls of one turn
// may open, or commit to, one draft at once, and the worker and the app each hold a source.
let writing: Promise<unknown> = Promise.resolve();
function serial<T>(write: () => Promise<T>): Promise<T> {
  const done = writing.then(write);
  writing = done.catch(() => undefined);
  return done;
}

/** `Source.commit` in the checkout at `cwd`: the root's, or a draft's. */
const commitIn =
  (cwd: string): Source["commit"] =>
  ({ paths, message, author }) =>
    serial(async () => {
      // No paths would be every path to git.
      if (!paths.length) return undefined;
      await gitIn(cwd, ["add", "--", ...paths]);
      if (!(await gitIn(cwd, ["status", "--porcelain", "--", ...paths]))) return undefined;
      // Only these paths, whatever else is staged; the email stays the machine's.
      await gitIn(cwd, ["commit", "--quiet", "-m", message, "--", ...paths], {
        GIT_AUTHOR_NAME: `${author} via Sanoma`,
      });
      return { revision: await gitIn(cwd, ["rev-parse", "HEAD"]) };
    });

/**
 * The local git checkout at `root` as a `Source`: commits on the current branch, as the
 * machine's git identity with the author named `<author> via Sanoma`, and pushes a branch to a
 * repository by its URL with a token. A draft is a git worktree at `<root>/.sanoma/drafts/<id>` on
 * the branch `draft/<id>`, with the root's `node_modules` linked into it; `git worktree list` is
 * the one record of which are open.
 */
export function localGitSource(root: string): Source {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => gitIn(root, args, env);
  /** The worktrees on a `draft/<id>` branch at their place, by id: whether each is still there. */
  const listed = async () => {
    const at = join(realpathSync(root), ".sanoma", "drafts");
    const entries = (await git(["worktree", "list", "--porcelain", "-z"])).split("\0\0");
    return new Map(
      entries.flatMap((entry) => {
        const fields = entry.split("\0");
        const path = fields.find((f) => f.startsWith("worktree "))?.slice("worktree ".length);
        const id = fields
          .find((f) => f.startsWith("branch refs/heads/draft/"))
          ?.slice("branch refs/heads/draft/".length);
        return id && path === join(at, id) ? [[id, !fields.some((f) => f.startsWith("prunable"))] as const] : [];
      }),
    );
  };

  return {
    root,
    commit: commitIn(root),
    head: (ref = "HEAD") => git(["rev-parse", "--verify", `${ref}^{commit}`]),
    async push({ url, token, ref }) {
      // The token goes in a header, through the environment, as the runtime image sends it: never
      // in the URL, the arguments, .git/config or an error. No prompt for anything else.
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      const env = {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: header,
      };
      await git(["push", "--quiet", "--", url, `refs/heads/${ref}:refs/heads/${ref}`], env).catch(
        (err: { stderr?: string; message: string }) => {
          const why = (err.stderr?.trim() || err.message).replaceAll(token, "<token>");
          throw new Error(`git push to ${url} failed: ${why}`);
        },
      );
    },
    async draft(id): Promise<Draft> {
      const branch = branchOf(id);
      const at = join(root, ".sanoma", "drafts", id);
      await serial(async () => {
        const here = (await listed()).get(id);
        if (!here) {
          // Ignored, or every file in it would be a change in the live checkout.
          if (!(await ignores(root, at))) {
            throw new Error(`.sanoma/ is not in ${join(root, ".gitignore")}, so a draft there would be a change here`);
          }
          const branched = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "");
          // One whose directory is gone (`git clean -X`) is still listed: added again over that entry alone (`-f`).
          const over = here === false ? ["-f"] : [];
          const from = branched ? [at, branch] : ["-b", branch, at, "HEAD"];
          await git(["worktree", "add", "--quiet", ...over, ...from]);
        }
        const [installed, modules] = [join(root, "node_modules"), join(at, "node_modules")];
        if (existsSync(installed) && !lstatSync(modules, { throwIfNoEntry: false })) {
          // Relative, so it holds when the repository moves.
          symlinkSync(relative(at, installed), modules, "dir");
          // `node_modules/` names a directory, not a link: the repository's own exclude file names it then.
          if (!(await ignores(at, "node_modules"))) {
            const exclude = resolve(at, await gitIn(at, ["rev-parse", "--git-path", "info/exclude"]));
            mkdirSync(dirname(exclude), { recursive: true });
            appendFileSync(exclude, "\n/node_modules\n");
          }
        }
      });
      return { branch, root: at, commit: commitIn(at) };
    },
    drafts: async () => [...(await listed())].flatMap(([id, here]) => (here ? [id] : [])).toSorted(),
    async diff(id) {
      // Three dots: from where the branch left the checked-out one, so what was merged since is not shown.
      // No renames, so a moved file's old path is a file too; no colour, whatever the user's config.
      const range = `HEAD...${branchOf(id)}`;
      const [names, summary] = await Promise.all([
        git(["diff", "--no-renames", "--name-only", "-z", range, "--"]),
        git(["diff", "--no-renames", "--no-color", "--stat", range, "--"]),
      ]);
      return { files: names.split("\0").filter(Boolean), summary };
    },
  };
}
