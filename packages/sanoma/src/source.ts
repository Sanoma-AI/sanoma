import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type CheckResult, type Draft, draftBranch, draftOf, errorMessage, type Source } from "@sanoma-ai/workflows";
import type { SanomaEvent } from "./events.ts";

const run = promisify(execFile);

/** Git in `cwd`: its output, trimmed. */
const gitIn = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  (await run("git", args, { cwd, env: { ...process.env, ...env } })).stdout.trim();

/** Whether git in `cwd` answers yes (exit 0) or no (exit 1); a failure of git's own (exit 128) is thrown. */
const holds = (cwd: string, args: string[]) =>
  gitIn(cwd, args).then(
    () => true,
    (err: { code?: unknown }) => {
      if (err.code === 1) return false;
      throw err;
    },
  );

/** Whether git in `cwd` ignores `path`. */
const ignores = (cwd: string, path: string) => holds(cwd, ["check-ignore", "--quiet", "--", path]);

/** A draft's id: a name, never a path. */
const DRAFT_ID = /^[\w-]{1,64}$/;

/** The draft id `id`, refused unless it is a name. */
function draftId(id: string): string {
  if (!DRAFT_ID.test(id)) throw new Error(`A draft's id is letters, digits, _ and -: ${JSON.stringify(id)}`);
  return id;
}

/** The branch of the draft `id`. */
const branchOf = (id: string) => draftBranch(draftId(id));

// One git write at a time in this process, whichever source makes it: two tool calls of one turn
// may open, or commit to, one draft at once, and the worker and the app each hold a source.
let writing: Promise<unknown> = Promise.resolve();
function serial<T>(write: () => Promise<T>): Promise<T> {
  const done = writing.then(write);
  writing = done.catch(() => undefined);
  return done;
}

/**
 * Git's environment for a command that reaches the repository at a URL with `token`: the token in
 * a header, as the runtime image sends it, never in the URL, the arguments or .git/config; no
 * prompt for anything else.
 */
const signedIn = (token: string): NodeJS.ProcessEnv => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

/** A failed git command that was given `token`, as an error that never holds it. */
const withoutToken = (what: string, token: string) => (err: { stderr?: string; message: string }) => {
  const why = (err.stderr?.trim() || err.message).replaceAll(token, "<token>");
  throw new Error(`${what} failed: ${why}`);
};

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
 * machine's git identity with the author named `<author> via Sanoma`, pushes a branch to a
 * repository by its URL with a token, and follows one there (a fast-forward). A draft is a git
 * worktree at `<root>/.sanoma/drafts/<id>` on the branch `draft/<id>`, with the root's
 * `node_modules` linked into it; `git worktree list` is the one record of which are open. A
 * draft's `sanoma check` runs on `<databaseUrl>_check` (the launcher's database when it is not given).
 */
export function localGitSource(root: string, { databaseUrl }: { databaseUrl?: string } = {}): Source {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => gitIn(root, args, env);
  const head = (ref = "HEAD") => git(["rev-parse", "--verify", `${ref}^{commit}`]);
  /** Where the draft `id`'s checkout is. */
  const draftAt = (id: string) => join(root, ".sanoma", "drafts", draftId(id));
  /** Whether the local branch `branch` exists. */
  const branched = (branch: string) =>
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(Boolean, () => false);
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
    head,
    async push({ url, token, ref }) {
      await git(["push", "--quiet", "--", url, `refs/heads/${ref}:refs/heads/${ref}`], signedIn(token)).catch(
        withoutToken(`git push to ${url}`, token),
      );
    },
    remoteUrl: () =>
      git(["remote", "get-url", "origin"]).catch((err: { code?: unknown }) => {
        // Exit 2: no remote of that name.
        if (err.code === 2) return undefined;
        throw err;
      }),
    follow: ({ url, token, ref }) =>
      serial(async () => {
        // A draft's branch is checked out in the draft's own checkout.
        const id = draftOf(ref);
        const cwd = id !== undefined && DRAFT_ID.test(id) && (await listed()).get(id) ? draftAt(id) : root;
        const gitHere = (args: string[], env?: NodeJS.ProcessEnv) => gitIn(cwd, args, env);
        const on = await gitHere(["branch", "--show-current"]);
        if (on !== ref)
          return { skipped: on ? `${on} is checked out, not ${ref}` : `no branch is checked out, not ${ref}` };
        if (await gitHere(["status", "--porcelain"])) return { skipped: "the checkout has uncommitted changes" };
        await gitHere(["fetch", "--quiet", "--no-tags", "--", url, `refs/heads/${ref}`], signedIn(token)).catch(
          withoutToken(`git fetch from ${url}`, token),
        );
        // The commit fetched, pinned: anything else may rewrite FETCH_HEAD before the merge.
        const fetched = await gitHere(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
        if (!(await holds(cwd, ["merge-base", "--is-ancestor", "HEAD", fetched]))) {
          return { skipped: `${ref} has commits ${url} does not` };
        }
        await gitHere(["merge", "--quiet", "--ff-only", fetched]);
        return { revision: fetched };
      }),
    async draft(id): Promise<Draft> {
      const [branch, at] = [branchOf(id), draftAt(id)];
      await serial(async () => {
        const here = (await listed()).get(id);
        if (!here) {
          // Ignored, or every file in it would be a change in the live checkout.
          if (!(await ignores(root, at))) {
            throw new Error(`.sanoma/ is not in ${join(root, ".gitignore")}, so a draft there would be a change here`);
          }
          // One whose directory is gone (`git clean -X`) is still listed: added again over that entry alone (`-f`).
          const over = here === false ? ["-f"] : [];
          const from = (await branched(branch)) ? [at, branch] : ["-b", branch, at, "HEAD"];
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
    closeDraft: async (id) => {
      const [branch, at] = [branchOf(id), draftAt(id)];
      // Not under a check still running in it.
      await checkingAt.get(at);
      return serial(async () => {
        // Forced: whatever it holds uncommitted goes with it, and one whose directory is gone too.
        if ((await listed()).has(id)) await git(["worktree", "remove", "--force", at]);
        if (await branched(branch)) await git(["branch", "--quiet", "-D", branch]);
      });
    },
    check: async (id) => checks(draftAt(id), databaseUrl, async () => (await listed()).get(id) === true),
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

/** How long a check may take before it is stopped and its result is that. */
const CHECK_TIMEOUT_MS = 15 * 60_000;

/**
 * `sanoma check` on the draft at `root` (a `Source.draft`'s), as a child in it: the `sanoma` its
 * `node_modules` holds, with this Node, an environment of `PATH`, `HOME` and `databaseUrl` alone
 * (no credential of this process, no `.env`: a draft has none), and `SANOMA_EVENTS=1` for its
 * result. One at a time in the process, whichever the draft and whichever source asks (the app's
 * and the worker's): every check runs its scenarios on the one `<database>_check`. A check that
 * gives no result (a draft not open when its turn comes, a config that does not load, no install,
 * the timeout) is a result of one problem, saying why.
 */
function checks(root: string, databaseUrl: string | undefined, open: () => Promise<boolean>): Promise<CheckResult> {
  const done = checking.then(async () => {
    if (!(await open())) return failed(`the draft at ${root} is not open`);
    return checkNow(root, databaseUrl).catch((err: unknown) => failed(errorMessage(err)));
  });
  checking = done;
  checkingAt.set(root, done);
  void done.then(() => checkingAt.get(root) === done && checkingAt.delete(root));
  return done;
}

/** The last check queued, if any. */
let checking: Promise<unknown> = Promise.resolve();
/** Each draft's last check queued, by its checkout, until it ends: what closing it waits for. */
const checkingAt = new Map<string, Promise<CheckResult>>();

const failed = (why: string): CheckResult => ({ ok: false, problems: [`sanoma check: ${why}`], warnings: [] });

interface Ran {
  stdout: string;
  stderr: string;
  killed?: boolean;
  code?: unknown;
}

async function checkNow(root: string, databaseUrl: string | undefined): Promise<CheckResult> {
  // The company's own install (linked into the draft).
  const sanoma = join(root, "node_modules", "sanoma");
  const { bin } = JSON.parse(await readFile(join(sanoma, "package.json"), "utf8")) as {
    bin: string | { sanoma: string };
  };
  const env: NodeJS.ProcessEnv = { SANOMA_EVENTS: "1", ...(databaseUrl && { SANOMA_DATABASE_URL: databaseUrl }) };
  for (const name of ["PATH", "HOME"] as const) if (process.env[name]) env[name] = process.env[name];
  const ran: Ran = await promisify(execFile)(
    process.execPath,
    [join(sanoma, typeof bin === "string" ? bin : bin.sanoma), "check"],
    {
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHECK_TIMEOUT_MS,
    },
  ).catch((err: Ran & { message: string }) => ({ ...err, stderr: err.stderr || err.message }));
  if (ran.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return failed("it printed more than its 64 MiB");
  if (ran.killed) return failed(`stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes`);
  // Beside the lines a person reads (and DBOS's), each event is a line of its own. The last one
  // counts: the draft's own code, which the check imports, prints on the same stdout before it.
  let result: CheckResult | undefined;
  let error: string | undefined;
  for (const line of ran.stdout.split("\n")) {
    if (!line.startsWith('{"sanoma":1,')) continue;
    let event: SanomaEvent & { sanoma: 1 };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue; // Not the launcher's: printed by the draft's own code.
    }
    if (event.event === "checked") {
      // Every field of the result, the grid among them.
      const { sanoma: _, event: __, ...fields } = event;
      result = fields;
    }
    if (event.event === "error") error = event.message;
  }
  return result ?? failed(error ?? (ran.stderr.trim().split("\n").at(-1) || "it gave no result"));
}
