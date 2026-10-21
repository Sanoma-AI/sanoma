import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { resolveDatabaseUrl } from "@sanoma-ai/workflows";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DATABASE_URL, FIRST_COMMIT, packageManagerOf, packageName, startCompany, TEMPLATE } from "../src/init.ts";
import { copyFixture, ensureBuilt, runCli } from "./fixture.ts";
import { gitIdentity } from "./git.ts";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const fresh = (name = "Acme Ops") => {
  dir = join(mkdtempSync(join(tmpdir(), "sanoma-init-")), name);
  mkdirSync(dir);
  return dir;
};
/** An install that writes pnpm's lockfile alone. */
const writeLockfile = async (cwd: string) => writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
afterEach(() => {
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("startCompany", () => {
  it("copies the template, writes .env, installs with the package manager that ran it and makes the first commit", async () => {
    gitIdentity(vi.stubEnv);
    vi.stubEnv("npm_config_user_agent", "npm/11.0.0 node/v24.2.0 darwin arm64");
    const installs: string[][] = [];
    const log: string[] = [];
    expect(
      await startCompany(fresh(), {
        install: async (cwd, pm) => void installs.push([cwd, pm]),
        log: (line) => log.push(line),
      }),
    ).toBe(true);

    expect(installs).toEqual([[dir, "npm"]]);
    expect(log).toEqual([`starting a Sanoma company in ${dir}`, `committed "${FIRST_COMMIT}"; installing with npm`]);
    for (const file of ["sanoma.config.ts", "workflows/publish-post.ts", "policies/policy.ts", "AGENTS.md"]) {
      expect(read(file)).toBe(readFileSync(new URL(file, TEMPLATE), "utf8"));
    }
    const pkg = JSON.parse(read("package.json")) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("acme-ops");
    expect(pkg.dependencies).toEqual({ "@sanoma-ai/connector-ghost": `^${version}`, sanoma: `^${version}` });
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    // pnpm's alone.
    expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false);
    expect(Object.keys(parseEnv(read(".env")))).toEqual(["SANOMA_DATABASE_URL", "SANOMA_SECRETS_KEY"]);

    expect(git("log", "--format=%s|%an")).toBe(`${FIRST_COMMIT}|Test User`);
    expect(git("branch", "--show-current")).toBe("main");
    const tracked = git("ls-files").split("\n");
    expect(tracked).toContain("resources/identity/.gitkeep");
    expect(tracked).toContain(".gitignore");
    expect(tracked).not.toContain(".env");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("keeps the dotfiles a directory holds, adding to them, and commits only what it wrote, the lockfile with it", async () => {
    gitIdentity(vi.stubEnv);
    vi.stubEnv("npm_config_user_agent", "");
    fresh();
    writeFileSync(join(dir, ".gitignore"), "/scratch\n");
    writeFileSync(join(dir, ".env"), "SANOMA_DATABASE_URL=postgresql://elsewhere/acme");
    writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    expect(await startCompany(dir, { install: writeLockfile })).toBe(true);

    expect(read(".gitignore")).toMatch(/^\/scratch\n\n# Secrets must never be committed.*\n\.env\n/s);
    const env = parseEnv(read(".env"));
    expect(env.SANOMA_DATABASE_URL).toBe("postgresql://elsewhere/acme");
    expect(Object.keys(env)).toEqual(["SANOMA_DATABASE_URL", "SANOMA_SECRETS_KEY"]);
    const tracked = git("ls-files").split("\n");
    expect(tracked).toContain("pnpm-lock.yaml");
    expect(tracked).toContain("pnpm-workspace.yaml");
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain(".npmrc");
    expect(git("log", "--format=%s")).toBe(FIRST_COMMIT);
  });

  it("leaves a repository with its first commit when the install fails", async () => {
    gitIdentity(vi.stubEnv);
    fresh();
    await expect(startCompany(dir, { install: () => Promise.reject(new Error("offline")) })).rejects.toThrow("offline");
    expect(git("log", "--format=%s")).toBe(FIRST_COMMIT);
  });

  it("leaves a directory that holds anything else alone", async () => {
    fresh();
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    expect(await startCompany(dir, { install: () => Promise.reject(new Error("no install")) })).toBe(false);
    expect(existsSync(join(dir, "sanoma.config.ts"))).toBe(false);
  });
});

describe("packageManagerOf and packageName", () => {
  it("takes the package manager from the user agent, pnpm when it names none", () => {
    expect(packageManagerOf("pnpm/11.15.1 npm/? node/v24.2.0")).toBe("pnpm");
    expect(packageManagerOf("yarn/4.5.0 npm/? node/v24.2.0")).toBe("yarn");
    expect(packageManagerOf("bun/1.2.0 npm/? node/v24.2.0")).toBe("bun");
    expect(packageManagerOf(undefined)).toBe("pnpm");
    expect(packageManagerOf("deno/2.0")).toBe("pnpm");
  });

  it("names the package after the directory", () => {
    expect(packageName("Acme Ops")).toBe("acme-ops");
    expect(packageName("_acme.co")).toBe("acme.co");
    expect(packageName("!!!")).toBe("company");
  });

  it("names it apart from a package it depends on", async () => {
    gitIdentity(vi.stubEnv);
    fresh("sanoma");
    await startCompany(dir, { install: async () => {} });
    expect(JSON.parse(read("package.json")).name).toBe("sanoma-company");
  });

  it("writes the runtime's default database", () => {
    expect(DATABASE_URL).toBe(resolveDatabaseUrl({}, {}));
  });
});

describe("sanoma in an empty directory", () => {
  it("starts a company, then serves it with the sanoma it installed", async () => {
    // A pnpm that installs only a stub of `sanoma`, whose `main` says it ran.
    const bin = mkdtempSync(join(tmpdir(), "sanoma-bin-"));
    const pnpm = join(bin, "pnpm");
    writeFileSync(
      pnpm,
      [
        "#!/bin/sh",
        "mkdir -p node_modules/sanoma/dist",
        `echo 'export const main = async (argv) => { console.log("served", JSON.stringify(argv)); return 0; };' > node_modules/sanoma/dist/cli.js`,
        "",
      ].join("\n"),
    );
    chmodSync(pnpm, 0o755);
    fresh("acme");
    const done = await runCli(dir, [], {
      ...gitIdentity(),
      PATH: `${bin}:${process.env.PATH}`,
      npm_config_user_agent: "pnpm/11.15.1 npm/? node/v24.2.0",
    });
    rmSync(bin, { recursive: true, force: true });

    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toBe("served []\n");
    expect(done.stderr).toContain("installing with pnpm");
    expect(git("log", "--format=%s")).toBe(FIRST_COMMIT);
    expect(basename(dir)).toBe(JSON.parse(read("package.json")).name);
  });
});

describe("the template", () => {
  beforeAll(ensureBuilt, 600_000);

  it("passes sanoma check without building the app (it has no sites), and its .env.example is current", async () => {
    dir = copyFixture(fileURLToPath(TEMPLATE));
    const env = {
      SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-template"),
      GHOST_ADMIN_URL: "",
      GHOST_ADMIN_API_KEY: "",
    };
    const checked = await runCli(dir, ["check"], env);
    expect(checked.code, `${checked.stdout}${checked.stderr}`).toBe(0);
    expect(existsSync(join(dir, ".sanoma"))).toBe(false);
    const current = await runCli(dir, ["env", "--check"], env);
    expect(current.code, current.stderr).toBe(0);
  }, 120_000);
});
