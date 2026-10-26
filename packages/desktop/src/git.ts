import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { EXTRA_PATH } from "./launcher.ts";

/** Runs a command in `cwd`; resolves its stdout, trimmed, and rejects with what it printed on stderr. */
export type Run = (command: string, args: readonly string[], options?: RunOptions) => Promise<string>;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** `Run` with `execFile`: the error's message is the command's stderr, trimmed, when it printed any. */
export const run: Run = (command, args, { cwd, env } = {}) =>
  new Promise((resolve, reject) =>
    execFile(command, args, { cwd, env, timeout: 120_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      reject(Object.assign(new Error(stderr.trim() || err.message), { code: err.code }));
    }),
  );

/**
 * The environment the shell runs git in: this process's, with Homebrew's folders after the
 * system's PATH (an app started from the Finder gets a short one), and nothing that waits for a
 * person: no password prompt (`GIT_TERMINAL_PROMPT=0`; the OS credential helper still answers)
 * and ssh in batch mode, unless the person set their own ssh command.
 */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = [...(base.PATH ?? "").split(delimiter), ...EXTRA_PATH].filter(Boolean);
  return {
    ...base,
    PATH: [...new Set(path)].join(delimiter),
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

/**
 * Whether this computer lacks Apple's command line tools, which git on macOS is part of: there,
 * `/usr/bin/git` is a stub that offers to install them. `xcode-select -p` fails until they (or
 * Xcode) are installed. Never on another platform.
 */
export async function needsCommandLineTools(platform: NodeJS.Platform = process.platform, exec: Run = run) {
  if (platform !== "darwin") return false;
  return exec("xcode-select", ["-p"]).then(
    () => false,
    () => true,
  );
}

/** Opens Apple's installer for the command line tools; it runs on its own, and says when it is done. */
export const installCommandLineTools = (exec: Run = run) =>
  exec("xcode-select", ["--install"]).then(
    () => {},
    () => {},
  );

/** Who commits: git's `user.name` and `user.email`. */
export interface Identity {
  name: string;
  email: string;
}

/** The identity git commits as from `cwd` (each value empty when it is not set). */
export async function identityOf(cwd: string, env: NodeJS.ProcessEnv, exec: Run = run): Promise<Identity> {
  const get = (key: string) => exec("git", ["config", "--get", key], { cwd, env }).catch(() => "");
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { name, email };
}

/** What is wrong with an identity a person typed, in one line; undefined when it will do. */
export function identityProblem({ name, email }: Identity): string | undefined {
  if (!name.trim()) return "Type the name your changes are signed with.";
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email.trim())) return "Type an email address, such as you@example.com.";
  return undefined;
}

/** Sets the identity for every repository on this computer (`git config --global`). */
export async function setIdentity({ name, email }: Identity, env: NodeJS.ProcessEnv, exec: Run = run) {
  await exec("git", ["config", "--global", "user.name", name.trim()], { env });
  await exec("git", ["config", "--global", "user.email", email.trim()], { env });
}

/** What git prints when the server wants a sign-in it did not get, or hides a private repository. */
const AUTH_FAILED =
  /Authentication failed|could not read Username|terminal prompts disabled|Repository not found|Permission denied \(publickey|returned error: 40[13]|Invalid username or password/i;

/** Whether git's stderr says it could not sign in (or the repository is private, which looks the same). */
export const isAuthFailure = (stderr: string) => AUTH_FAILED.test(stderr);

/** The one line a failed sign-in gets: it points at GitHub sign-in (#286 D6). */
export const AUTH_MESSAGE =
  "GitHub did not let this computer in (a private repository, or a wrong address): Sign in with GitHub comes in a later version of Sanoma.";
