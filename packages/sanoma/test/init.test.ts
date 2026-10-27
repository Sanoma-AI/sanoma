import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  declareFounder,
  FIRST_COMMIT,
  packageManagerOf,
  packageName,
  startCompany,
  TEMPLATE,
  whoIsStarting,
} from "../src/init.ts";
import { copyFixture, ensureBuilt, linkConnector, runCli } from "./fixture.ts";
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
/** Who starts the company in these tests: never `gh`, which may be signed in on this machine. */
const creator = async () => ({ id: "ada", name: "Ada Ortiz", github: "ada-ortiz" });
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
        creator,
        install: async (cwd, pm) => void installs.push([cwd, pm]),
        log: (line) => log.push(line),
      }),
    ).toBe(true);

    expect(installs).toEqual([[dir, "npm"]]);
    expect(log).toEqual([`starting a Sanoma company in ${dir}`, `committed "${FIRST_COMMIT}"; installing with npm`]);
    for (const file of [
      "sanoma.config.ts",
      "workflows/publish-post.ts",
      "policies/policy.cedar",
      "policies/changes.cedar",
      "AGENTS.md",
    ]) {
      expect(read(file)).toBe(readFileSync(new URL(file, TEMPLATE), "utf8"));
    }
    const pkg = JSON.parse(read("package.json")) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("acme-ops");
    expect(pkg.dependencies).toEqual({
      "@sanoma-ai/connector-anthropic": "latest",
      "@sanoma-ai/connector-ghost": "latest",
      sanoma: `^${version}`,
    });
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    // pnpm's alone.
    expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false);
    // No database URL: `sanoma` runs the company's own Postgres.
    expect(Object.keys(parseEnv(read(".env")))).toEqual(["SANOMA_SECRETS_KEY"]);
    // Its creator is its first person, so the app admits them.
    expect(read("resources/people.ts")).toContain(
      'export const founder = sanoma.person({ id: "ada", name: "Ada Ortiz", github: "ada-ortiz" });',
    );

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
    expect(await startCompany(dir, { creator, install: writeLockfile })).toBe(true);

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
    await expect(startCompany(dir, { creator, install: () => Promise.reject(new Error("offline")) })).rejects.toThrow(
      "offline",
    );
    expect(git("log", "--format=%s")).toBe(FIRST_COMMIT);
  });

  it("leaves a directory that holds anything else alone", async () => {
    fresh();
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    expect(await startCompany(dir, { creator, install: () => Promise.reject(new Error("no install")) })).toBe(false);
    expect(existsSync(join(dir, "sanoma.config.ts"))).toBe(false);
  });
});

describe("declareFounder", () => {
  it("writes the creator in as given, a $ in a name too, and refuses a file without a founder", () => {
    const text =
      'import { sanoma } from "sanoma/resources";\nexport const founder = sanoma.person({ id: "founder" });\n';
    expect(declareFounder(text, { id: "ann", name: "Ann $' Co" })).toContain(
      'export const founder = sanoma.person({ id: "ann", name: "Ann $\' Co" });',
    );
    expect(() => declareFounder("export {};\n", { id: "ann" })).toThrow("declares no `founder`");
  });
});

/** A `gh` signed in as `login`, first on the PATH. */
const signedIn = (login: string) => {
  const bin = mkdtempSync(join(tmpdir(), "sanoma-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho ${login}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
};

describe("whoIsStarting", () => {
  it("takes the GitHub login as the id, unless the template's people, the runtime's agents or the visitors have it", async () => {
    signedIn("ada-ortiz");
    expect(await whoIsStarting()).toMatchObject({ id: "ada-ortiz", github: "ada-ortiz" });
    for (const taken of ["reviewer", "editor", "admin", "agents", "scenarios", "visitors", "anonymous"]) {
      signedIn(taken);
      expect(await whoIsStarting()).toMatchObject({ id: "founder", github: taken });
    }
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
    await startCompany(dir, { creator, install: async () => {} });
    expect(JSON.parse(read("package.json")).name).toBe("sanoma-company");
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

  it("starts a company that passes sanoma check, its policy and scenarios with it, without building the app (it has no sites), and its .env.example is current", async () => {
    gitIdentity(vi.stubEnv);
    const started = fresh();
    await startCompany(started, { creator, install: async () => {} });
    dir = copyFixture(started);
    // The template's other connector: the chat's model.
    linkConnector(dir, "anthropic");
    rmSync(started, { recursive: true, force: true });
    const env = {
      SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-template"),
      ANTHROPIC_API_KEY: "",
      GHOST_ADMIN_URL: "",
      GHOST_ADMIN_API_KEY: "",
    };
    const checked = await runCli(dir, ["check"], env);
    expect(checked.code, `${checked.stdout}${checked.stderr}`).toBe(0);
    // The generated SDK, written before tsc, and nothing else: no app built.
    const logged = checked.stderr.split("\n");
    expect(logged.indexOf("wrote .sanoma/api.ts")).toBeGreaterThan(-1);
    expect(logged.indexOf("wrote .sanoma/api.ts")).toBeLessThan(logged.indexOf("tsc"));
    expect(readdirSync(join(dir, ".sanoma"))).toEqual(["api.ts", "schema.cedarschema"]);
    // The policy holds, so the scenarios ran: each passed under it.
    expect(logged).toContain("passed scenarios/publish-post/publish.feature › The editor approves");
    expect(logged).toContain("passed scenarios/publish-post/publish.feature › An editor publishes without a review");
    expect(readFileSync(join(dir, ".sanoma/api.ts"), "utf8")).toContain("publishPost: WorkflowFn<");
    const current = await runCli(dir, ["env", "--check"], env);
    expect(current.code, current.stderr).toBe(0);
  }, 120_000);
});
