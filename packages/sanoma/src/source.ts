import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type AppMerge,
  appSourceOf,
  type Draft,
  draftBranch,
  draftOf,
  errorMessage,
  readApps,
  type Source,
} from "sanoma/workflows";
import { APP_NAME, COMMIT_ID } from "sanoma/workflows/shared";

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

/** The trailer a saved draft's commit names its save's run in (`Source.merge`, `Source.saved`). */
const SAVE_TRAILER = "Sanoma-Save";

/** How long a push to `origin` may take. */
const PUSH_TIMEOUT_MS = 60_000;

/** The environment a commit by `author` is made in: named `<author> via Sanoma`, the email the machine's. */
const authoredBy = (author: string) => ({ GIT_AUTHOR_NAME: `${author} via Sanoma` });

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
      await gitIn(cwd, ["commit", "--quiet", "-m", message, "--", ...paths], authoredBy(author));
      return { revision: await gitIn(cwd, ["rev-parse", "HEAD"]) };
    });

// Taking and updating an app: a source repository's history merged into a draft. A source is a
// public repository: fetched by https alone (`GIT_ALLOW_PROTOCOL`, unless the environment sets its
// own list), with no credential helper and no prompt, into a ref of its own, so two fetches run
// at once and outside the one git write.

/** A ref a source is taken at: a branch, a tag or a commit id, never an option or a refspec. */
const SOURCE_REF = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

/** How long a source's fetch may take. */
const FETCH_TIMEOUT_MS = 2 * 60_000;

/** The commit `ref` (the default branch when absent) names in the repository at `url`, fetched into the checkout at `cwd`. */
async function fetchSource(cwd: string, url: string, ref?: string): Promise<string> {
  if (ref !== undefined && !SOURCE_REF.test(ref))
    throw new Error(`Not a branch, tag or commit: ${JSON.stringify(ref)}`);
  const into = `refs/sanoma/fetched/${randomUUID()}`;
  const args = ["-c", "credential.helper=", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head"];
  await run("git", [...args, "--", url, `+${ref ?? "HEAD"}:${into}`], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL ?? "https" },
    timeout: FETCH_TIMEOUT_MS,
  }).catch((err: { stderr?: string; message: string }) => {
    throw new Error(`git fetch from ${url} failed: ${err.stderr?.trim() || err.message}`);
  });
  try {
    return await gitIn(cwd, ["rev-parse", "--verify", `${into}^{commit}`]);
  } finally {
    // Its commit is pinned by its id.
    await gitIn(cwd, ["update-ref", "-d", into]);
  }
}

/**
 * How many commits `from` has that `HEAD` lacks, in the checkout at `cwd`, of those that change
 * what a merge of the app `folder` takes: its folder and `package.json`.
 */
const behindIn = async (cwd: string, from: string, folder: string) =>
  Number(await gitIn(cwd, ["rev-list", "--count", `HEAD..${from}`, "--", `apps/${folder}`, "package.json"]));

/** `use` of a file of its own in a temporary directory, deleted after. */
async function inTemp<T>(use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sanoma-bundle-"));
  try {
    return await use(join(dir, "draft.bundle"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Paths git printed with `-z`. */
const pathsOf = (z: string) => z.split("\0").filter(Boolean);

/**
 * Merges the commit `from` into the draft at `cwd` as one commit by `author`, titled `message`,
 * with its history (`take`: the first time the two meet, or another app of a source merged here
 * already). What it merges is the app's folder (a take's, the source's as it is) and `package.json`
 * (its connectors): every other file stays the company's, as does a file one side deleted, since
 * the source's root is the starter's and the rest of it the source's own. A file git could not
 * merge is committed with its markers (ours, the base, theirs) and named in `conflicts`. Refused
 * when the draft has uncommitted changes; a failure once the merge has begun puts the draft back.
 */
async function mergeIn(
  cwd: string,
  from: string,
  { folder, message, author, take }: { folder: string; message: string; author: string; take?: boolean },
): Promise<AppMerge> {
  if (await gitIn(cwd, ["status", "--porcelain"]))
    throw new Error("The draft has uncommitted changes: commit them first");
  const merged = await behindIn(cwd, from, folder);
  if (!merged && !take) return { folder, revision: await gitIn(cwd, ["rev-parse", "HEAD"]), merged, conflicts: [] };
  const as = authoredBy(author);
  if (merged) {
    const merge = ["-c", "merge.conflictStyle=diff3", "merge", "--quiet", "--no-ff", "--no-commit"];
    const failed = await gitIn(cwd, [...merge, ...(take ? ["--allow-unrelated-histories"] : []), from], as).then(
      () => undefined,
      (err: { stderr?: string; stdout?: string; message: string }) => err,
    );
    if (!(await holds(cwd, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]))) {
      throw new Error(
        `git merge of ${from} failed: ${failed?.stderr?.trim() || failed?.stdout?.trim() || failed?.message}`,
      );
    }
  }
  try {
    // The draft has no such folder: a take's is the source's whole, whatever the history here says.
    if (take) await gitIn(cwd, ["checkout", from, "--", `apps/${folder}`]);
    const outside = pathsOf(
      await gitIn(cwd, [
        "diff",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ".",
        `:(exclude)apps/${folder}`,
        ":(exclude)package.json",
      ]),
    );
    // Each unmerged file's stages: without ours (2) or theirs (3), one side deleted it.
    const stages = new Map<string, string[]>();
    for (const entry of pathsOf(await gitIn(cwd, ["ls-files", "--unmerged", "-z"]))) {
      const tab = entry.indexOf("\t");
      const path = entry.slice(tab + 1);
      stages.set(path, [...(stages.get(path) ?? []), entry.slice(0, tab).split(" ")[2]!]);
    }
    const bothSides = (path: string) => ["2", "3"].every((stage) => stages.get(path)!.includes(stage));
    const kept = new Set(outside);
    const conflicts = [...stages.keys()].filter((path) => !kept.has(path) && bothSides(path)).toSorted();
    await keepOurs(cwd, [...new Set([...outside, ...[...stages.keys()].filter((path) => !bothSides(path))])]);
    if (conflicts.length) await gitIn(cwd, ["add", "--", ...conflicts], { GIT_LITERAL_PATHSPECS: "1" });
    const left = conflicts.length ? `\n\nConflicts left to resolve:\n${conflicts.map((f) => `- ${f}`).join("\n")}` : "";
    await gitIn(cwd, ["commit", "--quiet", "-m", `${message}${left}`], as);
    return { folder, revision: await gitIn(cwd, ["rev-parse", "HEAD"]), merged, conflicts };
  } catch (err) {
    // The draft was clean: back to its commit, the merge (if any) with it.
    await gitIn(cwd, ["reset", "--quiet", "--hard", "HEAD"]).catch(() => undefined);
    throw err;
  }
}

/** Refuses `from` unless the checkout at `cwd` shares history with it: a take squashed or rebased away leaves no base. */
async function mustShareHistory(cwd: string, from: string, folder: string, url: string): Promise<void> {
  if (!(await holds(cwd, ["merge-base", "HEAD", from]))) {
    throw new Error(`apps/${folder}/ shares no history with ${url}: was it taken by a squashed or rebased merge?`);
  }
}

/** The files at `paths` in the checkout at `cwd` as `HEAD` has them, merged or not: those it lacks removed. */
async function keepOurs(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  // Paths, not patterns: a file's name may hold a `*`.
  const literal = { GIT_LITERAL_PATHSPECS: "1" };
  const listed = await gitIn(cwd, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...paths], literal);
  const ours = new Set(pathsOf(listed));
  const gone = paths.filter((path) => !ours.has(path));
  if (ours.size) await gitIn(cwd, ["checkout", "HEAD", "--", ...ours], literal);
  if (gone.length) await gitIn(cwd, ["rm", "--quiet", "--force", "--", ...gone], literal);
}

/**
 * The local git checkout at `root` as a `Source`: commits on the current branch, as the
 * machine's git identity with the author named `<author> via Sanoma`, pushes a branch to a
 * repository by its URL with a token, and follows one there (a fast-forward). A draft is a git
 * worktree at `<root>/.sanoma/drafts/<id>` on the branch `draft/<id>`, with the root's
 * `node_modules` linked into it; `git worktree list` is the one record of which are open. A
 * draft takes an app (`git merge --allow-unrelated-histories` of its source) and updates one
 * (a merge of its source's default branch); `behind` fetches an app's source into the checkout.
 * A draft's branch travels to an agent box's clone and back as a git bundle (`bundle`, `unbundle`).
 * A draft is saved (`merge`) at the commit given as one commit on the checked-out branch, its
 * tree made by `git merge-tree` so a conflict never reaches the live checkout, which then
 * fast-forwards, its save's run in a trailer (`Sanoma-Save`, which `saved` reads), the draft
 * closed in the same git write; a saved commit is undone (`revert`) by a `git revert` committed in
 * a draft, saved the same way; `pushOrigin` pushes the checked-out branch with git's own sign-in.
 */
export function localGitSource(root: string): Source {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => gitIn(root, args, env);
  /** The commit `ref` names, in the checkout at `cwd` (the root's by default). */
  const head = (ref = "HEAD", cwd = root) => gitIn(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
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
        const branch = fields.find((f) => f.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
        const id = branch === undefined ? undefined : draftOf(branch);
        return id && path === join(at, id) ? [[id, !fields.some((f) => f.startsWith("prunable"))] as const] : [];
      }),
    );
  };
  /**
   * Closes the draft `id`, under `serial`: its checkout removed and its branch deleted, the branch
   * only while it is still at `tip` when one is given.
   */
  const close = async (id: string, tip?: string) => {
    const [branch, at] = [branchOf(id), draftAt(id)];
    // Its link first: Git for Windows takes a junction for a folder, and would empty the company's own node_modules.
    const modules = join(at, "node_modules");
    if (lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(modules);
    // Forced: whatever it holds uncommitted goes with it, and one whose directory is gone too.
    if ((await listed()).has(id)) await git(["worktree", "remove", "--force", at]);
    if (!(await branched(branch))) return;
    await git(
      tip === undefined ? ["branch", "--quiet", "-D", branch] : ["update-ref", "-d", `refs/heads/${branch}`, tip],
    );
  };

  const source: Source = {
    root,
    commit: commitIn(root),
    head: (ref) => head(ref),
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
    follow: async ({ url, token, ref }) => {
      // A draft's branch is checked out in the draft's own checkout.
      const id = draftOf(ref);
      const cwd = id !== undefined && DRAFT_ID.test(id) && (await listed()).get(id) ? draftAt(id) : root;
      return serial(async () => {
        const gitHere = (args: string[], env?: NodeJS.ProcessEnv) => gitIn(cwd, args, env);
        const on = await gitHere(["branch", "--show-current"]);
        if (on !== ref)
          return { skipped: on ? `${on} is checked out, not ${ref}` : `no branch is checked out, not ${ref}` };
        if (await gitHere(["status", "--porcelain"])) return { skipped: "the checkout has uncommitted changes" };
        await gitHere(["fetch", "--quiet", "--no-tags", "--", url, `refs/heads/${ref}`], signedIn(token)).catch(
          withoutToken(`git fetch from ${url}`, token),
        );
        // The commit fetched, pinned: anything else may rewrite FETCH_HEAD before the merge.
        const fetched = await head("FETCH_HEAD", cwd);
        if (!(await holds(cwd, ["merge-base", "--is-ancestor", "HEAD", fetched]))) {
          return { skipped: `${ref} has commits ${url} does not` };
        }
        await gitHere(["merge", "--quiet", "--ff-only", fetched]);
        return { revision: fetched };
      });
    },
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
        if (existsSync(installed) && !existsSync(modules)) {
          // A link the repository's move left dangling goes first.
          rmSync(modules, { force: true });
          // Relative, so it holds when the repository moves. On Windows a junction, as a symbolic
          // link needs Developer Mode there, whose target is absolute; the type means nothing elsewhere.
          symlinkSync(relative(at, installed), modules, "junction");
          // `node_modules/` names a directory, not a link: the repository's own exclude file names it then.
          if (!(await ignores(at, "node_modules"))) {
            const exclude = resolve(at, await gitIn(at, ["rev-parse", "--git-path", "info/exclude"]));
            mkdirSync(dirname(exclude), { recursive: true });
            appendFileSync(exclude, "\n/node_modules\n");
          }
        }
      });
      return {
        branch,
        root: at,
        commit: commitIn(at),
        take: async ({ url, ref, folder, author }) => {
          const from = await fetchSource(at, url, ref);
          return serial(async () => {
            const apps = pathsOf(await gitIn(at, ["ls-tree", "-d", "--name-only", "-z", from, "--", "apps/"]))
              .map((path) => path.slice("apps/".length))
              .filter((name) => APP_NAME.test(name));
            const name = folder ?? (apps.length === 1 ? apps[0] : undefined);
            if (name === undefined || !apps.includes(name)) {
              const held = apps.map((a) => `apps/${a}/`).join(", ");
              if (!held) throw new Error(`${url} holds no app: a source holds one apps/<name>/`);
              throw new Error(
                `${url} ${folder ? `has no apps/${folder}/` : "holds more than one app"}: it holds ${held}`,
              );
            }
            if (existsSync(join(at, "apps", name))) throw new Error(`apps/${name}/ is here already: update it instead`);
            return mergeIn(at, from, { folder: name, message: `Take ${name} from ${url}`, author, take: true });
          });
        },
        update: async ({ folder, author }) => {
          // Main's `app.ts`, never the draft's: a draft's files are never loaded.
          if (!readApps(root).some((app) => app.name === folder) && existsSync(join(at, "apps", folder))) {
            throw new Error(`apps/${folder}/ is only in this draft: publish the take first, then update it`);
          }
          const url = appSourceOf(root, folder);
          const from = await fetchSource(at, url);
          return serial(async () => {
            await mustShareHistory(at, from, folder, url);
            return mergeIn(at, from, { folder, message: `Update ${folder} from ${url}`, author });
          });
        },
      };
    },
    closeDraft: (id) => serial(() => close(id)),
    async bundle(id, { since } = {}) {
      const ref = `refs/heads/${branchOf(id)}`;
      // A commit the clone says it has, by its id alone, that this repository has too; else the whole branch.
      const [tip, base] = await Promise.all([
        head(ref),
        since !== undefined && COMMIT_ID.test(since)
          ? holds(root, ["rev-parse", "--verify", "--quiet", `${since}^{commit}`]).then((has) =>
              has ? since : undefined,
            )
          : undefined,
      ]);
      // Git refuses an empty bundle: the clone has every commit.
      if (base !== undefined && (await holds(root, ["merge-base", "--is-ancestor", tip, base]))) {
        return { bytes: new Uint8Array(), head: tip };
      }
      return inTemp(async (file) => {
        await git(["bundle", "create", "--quiet", file, ref, ...(base === undefined ? [] : [`^${base}`])]);
        return { bytes: await readFile(file), head: tip };
      });
    },
    async unbundle(id, bytes) {
      const [branch, at] = [branchOf(id), draftAt(id)];
      if (!(await listed()).get(id)) throw new Error(`The draft ${id} is not open`);
      return inTemp(async (file) => {
        await writeFile(file, bytes);
        return serial(async () => {
          // It was made where an agent ran: fsck'd as it arrives by a git that checks a bundle's
          // objects (2.39 does not); checkout's own path checks hold either way.
          const pull = ["-c", "fetch.fsckObjects=true", "pull", "--quiet", "--ff-only", "--no-rebase", "--no-tags"];
          await gitIn(at, [...pull, "--", file, `refs/heads/${branch}`]).catch(
            (err: { stderr?: string; message: string }) => {
              throw new Error(
                `The draft ${id} could not take the bundle's ${branch} as a fast-forward: ${err.stderr?.trim() || err.message}`,
              );
            },
          );
          return { head: await head("HEAD", at) };
        });
      });
    },
    async behind(folder) {
      const url = appSourceOf(root, folder);
      const from = await fetchSource(root, url);
      await mustShareHistory(root, from, folder, url);
      return behindIn(root, from, folder);
    },
    drafts: async () => [...(await listed())].flatMap(([id, here]) => (here ? [id] : [])).toSorted(),
    async diff(id) {
      // The branch's commit first, so the files and the summary are of the one commit.
      const tip = await head(`refs/heads/${branchOf(id)}`);
      // Three dots: from where the branch left the checked-out one, so what was merged since is not shown.
      // No renames, so a moved file's old path is a file too; no colour, whatever the user's config.
      const range = `HEAD...${tip}`;
      const [names, summary] = await Promise.all([
        git(["diff", "--no-renames", "--name-only", "-z", range, "--"]),
        git(["diff", "--no-renames", "--no-color", "--stat", range, "--"]),
      ]);
      return { files: pathsOf(names), summary, head: tip };
    },
    async merge(id, { head: tip, title, author, run: save }) {
      return serial(async () => {
        // Read once the agent's commits can no longer land: what is merged and closed is `tip`, or nothing.
        if ((await head(`refs/heads/${branchOf(id)}`)) !== tip) {
          throw new Error(`The draft ${id} has moved on from ${tip.slice(0, 7)}: save it from its latest card`);
        }
        if (await git(["status", "--porcelain", "--untracked-files=no"])) {
          throw new Error("The live checkout has uncommitted changes: commit or discard them first");
        }
        // Merged as git would, without touching the checkout: the tree, or the files both sides edit.
        const tree = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", tip]).catch(
          (err: { code?: unknown; stdout?: string }) => {
            if (err.code !== 1) throw err;
            const both = err.stdout?.trim().split("\n").slice(1).join(", ");
            throw new Error(`The draft ${id} and what was saved since it began both change ${both}`);
          },
        );
        if (tree === (await git(["rev-parse", "HEAD^{tree}"]))) {
          throw new Error(`The draft ${id} changes nothing here`);
        }
        const message = ["-m", title, "-m", `${SAVE_TRAILER}: ${save}`];
        const commit = await git(["commit-tree", tree, "-p", "HEAD", ...message], authoredBy(author));
        await git(["merge", "--quiet", "--ff-only", commit]);
        // Saved either way: a draft that would not close is saved again from where it is, or closed with its chat.
        await close(id, tip).catch((err: unknown) =>
          console.warn(
            `sanoma: saved ${commit.slice(0, 7)}, but could not close the draft ${id}: ${errorMessage(err)}`,
          ),
        );
        return { revision: commit };
      });
    },
    async saved(save) {
      const line = `^${SAVE_TRAILER}: ${save.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
      const revision = await git(["log", "--first-parent", "-n", "1", "--format=%H", "-E", `--grep=${line}`, "HEAD"]);
      if (!revision) return undefined;
      const files = await git(["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", revision]);
      return { revision, files: pathsOf(files) };
    },
    async revert(id, { sha, author }) {
      if (!COMMIT_ID.test(sha)) throw new Error(`Not a commit's id: ${JSON.stringify(sha)}`);
      // A commit merged on the host is here once the checkout followed main.
      const parents = await git(["rev-list", "--parents", "-n", "1", sha]).catch(() => {
        throw new Error(`${sha.slice(0, 7)} is not in this repository yet: undo it once main has it`);
      });
      const { root: at } = await source.draft!(id);
      return serial(async () => {
        // A merge is undone as what it brought into its first parent.
        const mainline = parents.split(" ").length > 2 ? ["-m", "1"] : [];
        await gitIn(at, ["revert", "--no-edit", ...mainline, sha], authoredBy(author)).catch(
          async (err: { stderr?: string; message: string }) => {
            await gitIn(at, ["revert", "--abort"]).catch(() => undefined);
            throw new Error(`${sha.slice(0, 7)} cannot be undone here: ${err.stderr?.trim() || err.message}`);
          },
        );
        return { revision: await head("HEAD", at) };
      });
    },
    async pushOrigin() {
      // To the branch of the same name; a fast-forward only, as git pushes by default.
      await run("git", ["push", "--quiet", "origin", "HEAD"], {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: PUSH_TIMEOUT_MS,
      }).catch((err: { stderr?: string; message: string; killed?: boolean }) => {
        if (err.killed) throw new Error(`git push to origin took more than ${PUSH_TIMEOUT_MS / 1000} seconds`);
        const why = (err.stderr?.trim() || err.message)
          .split("\n")
          .filter((line) => !line.startsWith("hint:"))
          .join(" ")
          // A URL's credentials, should git print one.
          .replace(/\/\/[^/@\s]*@/g, "//");
        throw new Error(`git push to origin failed: ${why}`);
      });
    },
  };
  return source;
}
