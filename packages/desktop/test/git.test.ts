import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import type { Company } from "../src/companies.ts";
import {
  addressProblem,
  cloneCompany,
  cloneSession,
  cloneTarget,
  createSession,
  defaultParent,
  isCloneUrl,
  newCompanyProblem,
  repoNameOf,
} from "../src/create.ts";
import {
  AUTH_MESSAGE,
  gitEnv,
  gitFailure,
  identityOf,
  identityProblem,
  isAuthFailure,
  needsCommandLineTools,
  type Run,
  setIdentity,
} from "../src/git.ts";
import type { SessionOptions } from "../src/session.ts";
import { fastForward, LOCAL_CHANGES, ownChanges, prepareUpdate } from "../src/update-company.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "sanoma-desktop-git-")));

/** git's environment for a test: no system or user config but its own, and an identity to commit as. */
function testEnv(): NodeJS.ProcessEnv {
  const home = temp();
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return gitEnv({
    ...base,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
}

const env = testEnv();

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const company = (path: string): Company => ({ path, name: "x", port: 3100, lastOpened: "1" });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();

function commit(dir: string, file: string, text: string) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "--quiet", "-m", `write ${file}`);
}

/** A bare repository on `main` with one commit, as GitHub would hold a company, and its file URL. */
function origin() {
  const root = temp();
  const bare = join(root, "acme.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", bare, seed);
  commit(seed, "sanoma.config.ts", "export default {};\n");
  git(seed, "push", "--quiet", "origin", "main");
  return { bare, url: pathToFileURL(bare).href, seed };
}

/** A clone of the origin, on its main: the company on this computer. */
function local(bare: string) {
  const dir = join(temp(), "acme");
  git(tmpdir(), "clone", "--quiet", bare, dir);
  return dir;
}

/** Another commit on GitHub's main, from somewhere else. */
function pushFrom(seed: string, file: string) {
  commit(seed, file, `${file}\n`);
  git(seed, "push", "--quiet", "origin", "main");
}

describe("git's prerequisites", () => {
  test("Apple's command line tools are needed on macOS when xcode-select has no path, and nowhere else", async () => {
    const calls: string[] = [];
    const answering =
      (ok: boolean): Run =>
      async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (!ok) throw new Error("xcode-select: error: unable to get active developer directory");
        return "/Library/Developer/CommandLineTools";
      };
    expect(await needsCommandLineTools("darwin", answering(false))).toBe(true);
    expect(await needsCommandLineTools("darwin", answering(true))).toBe(false);
    expect(calls).toEqual(["xcode-select -p", "xcode-select -p"]);
    expect(await needsCommandLineTools("linux", answering(false))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("an identity is read from git's config, checked, and set globally", async () => {
    const own = testEnv();
    const dir = temp();
    expect(await identityOf(dir, own)).toEqual({ name: "", email: "" });
    expect(identityProblem({ name: " ", email: "a@b.c" })).toMatch(/name/);
    expect(identityProblem({ name: "Ada", email: "ada" })).toMatch(/email/);
    expect(identityProblem({ name: "Ada", email: "ada@example.com" })).toBeUndefined();
    await setIdentity({ name: " Ada Lovelace ", email: "ada@example.com" }, own);
    expect(await identityOf(dir, own)).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(readFileSync(own.GIT_CONFIG_GLOBAL!, "utf8")).toContain("name = Ada Lovelace");
  });

  test("git never prompts", () => {
    expect(gitEnv({ PATH: "/usr/bin:/bin" })).toEqual({ PATH: "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" });
    expect(gitEnv({ GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBe("ssh -i key");
  });

  test.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", true],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", true],
    ["git@github.com: Permission denied (publickey).", true],
    ["fatal: Authentication failed for 'https://github.com/a/b/'", true],
    ["fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com", false],
  ])("%s: a failed sign-in %s", (stderr, auth) => {
    expect(isAuthFailure(stderr)).toBe(auth);
  });

  test("a failure is one line: the sign-in's, or git's last, without a password", () => {
    expect(gitFailure("remote: Repository not found.", "git could not clone x")).toBe(AUTH_MESSAGE);
    expect(
      gitFailure(
        "Cloning into 'x'...\nfatal: unable to access 'https://u:tok@example.com/x/': Could not resolve host",
        "git could not clone x",
      ),
    ).toBe("git could not clone x: unable to access 'https://***@example.com/x/': Could not resolve host");
    expect(
      gitFailure(
        "Host key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
        "git could not clone x",
      ),
    ).toBe("git could not clone x: Host key verification failed.");
  });
});

describe("a new company", () => {
  test("starts from the last company's folder, else the home folder", () => {
    expect(defaultParent([], "/Users/a")).toBe("/Users/a");
    expect(defaultParent([company("/Users/a/Companies/acme")], "/Users/a", () => true)).toBe("/Users/a/Companies");
    expect(defaultParent([company("/Volumes/gone/acme")], "/Users/a", () => false)).toBe("/Users/a");
  });

  test("needs an empty folder, dotfiles aside", () => {
    const dir = temp();
    writeFileSync(join(dir, ".DS_Store"), "");
    expect(newCompanyProblem(dir)).toBeUndefined();
    writeFileSync(join(dir, "notes.txt"), "");
    expect(newCompanyProblem(dir)).toMatch(/has files in it already/);
  });

  test("runs the launcher's init with pnpm dlx through the shims, and serves the company it started", async () => {
    const repo = temp();
    const bin = join(temp(), "bin");
    const calls = join(temp(), "calls");
    const lines: string[] = [];
    const progress: string[] = [];
    const port = await freePort();
    const session = createSession({
      repo,
      port,
      node: process.execPath,
      pnpm: fixture("dlx.mjs"),
      bin,
      env: { ...process.env, FAKE_MODE: "event", FAKE_PNPM_LOG: calls },
      pollMs: 50,
      onLine: (_stream, line) => lines.push(line),
      onProgress: (step) => progress.push(step),
    });
    await expect(session.ready).resolves.toBe(`http://localhost:${port}`);
    expect(readFileSync(calls, "utf8")).toBe("dlx sanoma\n");
    expect(existsSync(join(repo, "sanoma.config.ts"))).toBe(true);
    expect(existsSync(join(bin, "pnpm"))).toBe(true);
    expect(lines).toContain(`env ${port} 1 ${bin}`);
    expect(progress).toEqual(["Starting a new company with sanoma from npm"]);
    await session.stop();
    await expect(session.ended).resolves.toMatchObject({ code: 143 });
  });

  test("opens a folder that holds files as any other, as Start again after an init that got that far does", async () => {
    const repo = temp();
    writeFileSync(join(repo, "package.json"), "{}");
    const progress: string[] = [];
    const session = createSession(options(repo, await freePort(), { FAKE_PNPM_EXIT: "1" }, progress));
    await expect(session.ended).resolves.toMatchObject({ error: expect.stringContaining("pnpm install failed") });
    expect(progress).toEqual(["Installing packages"]);
  });
});

/** A session's options for `repo`, on the fake pnpm and Node, with `extra` in its environment. */
function options(repo: string, port: number, extra: NodeJS.ProcessEnv, progress: string[] = []): SessionOptions {
  return {
    repo,
    port,
    node: process.execPath,
    pnpm: fixture("pnpm.mjs"),
    bin: join(temp(), "bin"),
    env: { ...env, FAKE_MODE: "event", ...extra },
    pollMs: 50,
    onLine: () => {},
    onProgress: (step) => progress.push(step),
  };
}

describe("a clone", () => {
  test.each([
    ["https://github.com/acme/company", "company"],
    ["https://github.com/acme/company.git/", "company"],
    ["git@github.com:acme/back-office.git", "back-office"],
    ["file:///tmp/repos/acme.git", "acme"],
  ])("%s goes into %s", (url, name) => {
    expect(isCloneUrl(url)).toBe(true);
    expect(repoNameOf(url)).toBe(name);
  });

  test("refuses what is not an address, and a folder that is there already", () => {
    const parent = temp();
    expect(isCloneUrl("acme/company")).toBe(false);
    expect(isCloneUrl("--upload-pack=touch /tmp/x")).toBe(false);
    expect(addressProblem("acme")).toMatch(/not a repository's address/);
    expect(addressProblem("https://github.com/acme/..")).toMatch(/cannot tell what to name/);
    expect(addressProblem("https://github.com/acme/company")).toBeUndefined();
    expect(cloneTarget("https://github.com/acme/company", parent)).toEqual({ dir: join(parent, "company") });
    mkdirSync(join(parent, "company"));
    expect(cloneTarget("https://github.com/acme/company", parent)).toMatchObject({
      problem: expect.stringMatching(/has a company already/),
    });
  });

  test("clones with the system git, and says why when it cannot", async () => {
    const { url } = origin();
    const dir = join(temp(), "acme");
    const lines: string[] = [];
    await expect(cloneCompany(url, dir, { env, onLine: (_s, line) => lines.push(line) }).done).resolves.toBeUndefined();
    expect(existsSync(join(dir, "sanoma.config.ts"))).toBe(true);
    expect(lines.join("\n")).toContain("Cloning into");

    const missing = cloneCompany(`${url}-missing`, join(temp(), "x"), { env, onLine: () => {} });
    await expect(missing.done).resolves.toMatch(/^git could not clone .*acme\.git-missing: /);
  });

  test("as a session: clones, then installs and starts the company; a failed clone ends it with git's line", async () => {
    // A company whose installed sanoma, committed for the test, is the fake launcher.
    const { bare, seed } = origin();
    mkdirSync(join(seed, "node_modules", "sanoma"), { recursive: true });
    writeFileSync(join(seed, "node_modules", "sanoma", "cli.mjs"), readFileSync(fixture("launcher.mjs")));
    writeFileSync(join(seed, "node_modules", "sanoma", "package.json"), JSON.stringify({ bin: { sanoma: "cli.mjs" } }));
    git(seed, "add", "--force", "node_modules");
    git(seed, "commit", "--quiet", "-m", "the fake launcher");
    git(seed, "push", "--quiet", "origin", "main");
    const url = pathToFileURL(bare).href;
    const progress: string[] = [];
    const repo = join(temp(), "acme");
    const port = await freePort();
    const session = cloneSession(url)(options(repo, port, {}, progress));
    await expect(session.ready).resolves.toBe(`http://localhost:${port}`);
    expect(progress).toEqual(["Cloning", "Installing packages", "Starting the company"]);
    await session.stop();

    const failed = cloneSession(`${url}-missing`)(options(join(temp(), "x"), await freePort(), {}));
    await expect(failed.ready).rejects.toThrow(/^git could not clone /);
    await expect(failed.ended).resolves.toMatchObject({ error: expect.stringMatching(/^git could not clone /) });

    // A folder there already that holds no company (a clone stopped halfway): it says so, and installs nothing.
    const partial = cloneSession(url)(options(temp(), await freePort(), {}));
    await expect(partial.ended).resolves.toMatchObject({ error: expect.stringMatching(/holds no company/) });
  });

  test("a failed sign-in says so in one line", async () => {
    // A credential helper that knows nothing, and a server that asks for one: what a private repository does.
    const helper = join(temp(), "helper.sh");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const server = createServer((socket) =>
      socket.once("data", () =>
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        ),
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const cloning = cloneCompany(`http://127.0.0.1:${port}/acme/company.git`, join(temp(), "company"), {
        env: { ...env, GIT_CONFIG_PARAMETERS: `'credential.helper=${helper}'` },
        onLine: () => {},
      });
      await expect(cloning.done).resolves.toBe(AUTH_MESSAGE);
    } finally {
      server.close();
    }
  });
});

/** A changed file's line in `git status --porcelain=v2`. */
const statusLine = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 abc abc ${path}`;

describe("Get Updates", () => {
  test("fast-forwards a clean main that is behind GitHub", async () => {
    const { bare, seed } = origin();
    const dir = local(bare);
    expect(await prepareUpdate(dir, env)).toEqual({ behind: 0 });
    pushFrom(seed, "a.ts");
    pushFrom(seed, "b.ts");
    expect(await prepareUpdate(dir, env)).toEqual({ behind: 2 });
    await fastForward(dir, env);
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(seed, "rev-parse", "HEAD"));
    expect(existsSync(join(dir, "b.ts"))).toBe(true);
  });

  test("refuses, changing nothing, with changes on this computer", async () => {
    const { bare, seed } = origin();
    pushFrom(seed, "a.ts");
    const dir = local(bare);
    pushFrom(seed, "b.ts");
    const head = git(dir, "rev-parse", "HEAD");

    writeFileSync(join(dir, "a.ts"), "edited\n");
    expect(await prepareUpdate(dir, env)).toEqual({ refused: LOCAL_CHANGES });
    git(dir, "checkout", "--quiet", "--", "a.ts");

    writeFileSync(join(dir, "new.ts"), "untracked\n");
    expect(await prepareUpdate(dir, env)).toEqual({ refused: LOCAL_CHANGES });
    git(dir, "add", "new.ts");
    git(dir, "commit", "--quiet", "-m", "a commit not on GitHub");
    // Diverged: a commit here, and one on GitHub.
    expect(await prepareUpdate(dir, env)).toEqual({ refused: LOCAL_CHANGES });
    expect(git(dir, "rev-parse", "HEAD~1")).toBe(head);
  });

  test("takes a lockfile the shell's own install rewrote as clean, and GitHub's lockfile over it", async () => {
    const { bare, seed } = origin();
    commit(seed, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    git(seed, "push", "--quiet", "origin", "main");
    const dir = local(bare);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# rewritten by the shell's install\n");
    expect(await prepareUpdate(dir, env)).toEqual({ behind: 0 });
    commit(seed, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# from GitHub\n");
    git(seed, "push", "--quiet", "origin", "main");
    expect(await prepareUpdate(dir, env)).toEqual({ behind: 1 });
    await fastForward(dir, env);
    expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toMatch(/from GitHub/);
    expect(git(dir, "status", "--porcelain")).toBe("");

    // Staged, or with any other change, it is the person's.
    writeFileSync(join(dir, "pnpm-lock.yaml"), "staged\n");
    git(dir, "add", "pnpm-lock.yaml");
    expect(await prepareUpdate(dir, env)).toEqual({ refused: LOCAL_CHANGES });
    git(dir, "reset", "--quiet");
    writeFileSync(join(dir, "package.json"), "{}\n");
    expect(await prepareUpdate(dir, env)).toEqual({ refused: LOCAL_CHANGES });
  });

  test("only the root lockfile changed in the tree is the shell's", () => {
    expect(ownChanges(statusLine(".M", "pnpm-lock.yaml"))).toEqual([]);
    const theirs = [statusLine("M.", "pnpm-lock.yaml"), statusLine(".M", "sub/pnpm-lock.yaml"), "? new.ts"];
    expect(ownChanges(theirs.join("\n"))).toEqual(theirs);
  });

  test("refuses off main, and without an origin", async () => {
    const { bare } = origin();
    const dir = local(bare);
    git(dir, "checkout", "--quiet", "-b", "draft");
    expect(await prepareUpdate(dir, env)).toEqual({
      refused: "This company is on the branch draft, and updates come to main; nothing was changed",
    });
    git(dir, "checkout", "--quiet", "--detach", "main");
    expect(await prepareUpdate(dir, env)).toMatchObject({ refused: expect.stringMatching(/not on a branch/) });

    const alone = temp();
    git(alone, "init", "--quiet", "--initial-branch=main");
    commit(alone, "sanoma.config.ts", "export default {};\n");
    expect(await prepareUpdate(alone, env)).toMatchObject({ refused: expect.stringMatching(/no origin/) });
  });

  test("says when GitHub cannot be reached, or has no main", async () => {
    const { bare } = origin();
    const dir = local(bare);
    git(dir, "remote", "set-url", "origin", `${pathToFileURL(bare).href}-gone`);
    expect(await prepareUpdate(dir, env)).toMatchObject({
      refused: expect.stringMatching(/^Sanoma could not get updates: /),
    });
    git(bare, "branch", "-m", "main", "trunk");
    git(dir, "remote", "set-url", "origin", bare);
    expect(await prepareUpdate(dir, env)).toMatchObject({ refused: expect.stringMatching(/no main branch/) });
  });
});
