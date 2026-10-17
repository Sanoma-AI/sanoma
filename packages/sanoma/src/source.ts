import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Source } from "@sanoma-ai/workflows";

const run = promisify(execFile);

/**
 * The local git checkout at `root` as a `Source`: commits on the current branch, as the
 * machine's git identity with the author named `<author> via Sanoma`; no remote, so no `push` yet.
 */
export function localGitSource(root: string): Source {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) =>
    (await run("git", args, { cwd: root, env: { ...process.env, ...env } })).stdout.trim();
  return {
    root,
    async commit({ paths, message, author }) {
      await git(["add", "--", ...paths]);
      if (!(await git(["status", "--porcelain", "--", ...paths]))) return undefined;
      // Only these paths, whatever else is staged; the email stays the machine's.
      await git(["commit", "--quiet", "-m", message, "--", ...paths], { GIT_AUTHOR_NAME: `${author} via Sanoma` });
      return { revision: await git(["rev-parse", "HEAD"]) };
    },
    head: (ref = "HEAD") => git(["rev-parse", "--verify", `${ref}^{commit}`]),
  };
}
