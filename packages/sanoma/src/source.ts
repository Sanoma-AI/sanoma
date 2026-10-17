import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Source } from "@sanoma-ai/workflows";

const run = promisify(execFile);

/**
 * The local git checkout at `root` as a `Source`: commits on the current branch, as the
 * machine's git identity with the author named `<author> via Sanoma`, and pushes a branch to a
 * repository by its URL with a token.
 */
export function localGitSource(root: string): Source {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) =>
    (await run("git", args, { cwd: root, env: { ...process.env, ...env } })).stdout.trim();
  return {
    root,
    async commit({ paths, message, author }) {
      // No paths would be every path to git.
      if (!paths.length) return undefined;
      await git(["add", "--", ...paths]);
      if (!(await git(["status", "--porcelain", "--", ...paths]))) return undefined;
      // Only these paths, whatever else is staged; the email stays the machine's.
      await git(["commit", "--quiet", "-m", message, "--", ...paths], { GIT_AUTHOR_NAME: `${author} via Sanoma` });
      return { revision: await git(["rev-parse", "HEAD"]) };
    },
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
  };
}
