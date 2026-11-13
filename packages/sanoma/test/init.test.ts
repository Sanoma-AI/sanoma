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
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { testDatabaseUrl } from "sanoma/testing";
import { declareFounder, declareName, declareSlug } from "sanoma/init";
import { AGENTS, VISITORS } from "sanoma/workflows";
import { readPeople } from "sanoma/workflows/describe";
import { groupNamesOf, principalIdsOf } from "sanoma/workflows/shared";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  FIRST_COMMIT,
  packageManagerOf,
  packageName,
  pinDependencies,
  slugOf,
  startCompany,
  TEMPLATE,
  templatePeopleIds,
  whoIsStarting,
} from "../src/init.ts";
import { copyFixture, ensureBuilt, linkConnector, runCli, templateConnectors } from "./fixture.ts";
import { gitIdentity } from "./git.ts";

/** The template's manifest, as a company starts from it. */
const template = JSON.parse(readFileSync(new URL("package.json", TEMPLATE), "utf8")) as {
  dependencies: Record<string, string>;
};
/** The workspace root's manifest, whose devDependencies are the connectors the tests run. */
const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
};

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
/** The `stage` events of starting a company, in order, as `SANOMA_EVENTS=1` writes them. */
const STAGES = ["template", "people", "git", "install"].flatMap((stage) =>
  ["start", "done"].map((status) => ({ sanoma: 1, event: "stage", stage, status })),
);
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
      "secrets.ts",
      "workflows/record-lead.ts",
      "scenarios/record-lead/record.feature",
      "policies/policy.cedar",
      "policies/changes.cedar",
      "AGENTS.md",
    ]) {
      expect(read(file)).toBe(readFileSync(new URL(file, TEMPLATE), "utf8"));
    }
    const pkg = JSON.parse(read("package.json")) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("acme-ops");
    // From a checkout, whose version npm may not have, the template's ranges (packed.test.ts pins them).
    expect(pkg.dependencies).toEqual(template.dependencies);
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    // pnpm's alone.
    expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false);
    // No database URL: `sanoma` runs the company's own Postgres.
    expect(Object.keys(parseEnv(read(".env"))).toSorted()).toEqual(["SANOMA_SECRETS_KEY", "SANOMA_SIGNING_KEY"]);
    // Its creator is its one person, so the app admits them, and picks them without asking.
    expect(read("resources/people.ts")).toContain(
      'export const founder = sanoma.person({ id: "ada", name: "Ada Ortiz", github: "ada-ortiz" });',
    );
    expect(templatePeopleIds()).toEqual(["founder", "admin"]);
    // Sanoma Cloud declared, by the directory's name for want of the company's.
    expect(read("resources/sanoma/infra.ts")).toContain('hostname: "acme-ops.sanoma.work"');

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
    expect(Object.keys(env).toSorted()).toEqual(["SANOMA_DATABASE_URL", "SANOMA_SECRETS_KEY", "SANOMA_SIGNING_KEY"]);
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

  it("names the company and its slug after the name it is given, and says each stage it goes through", async () => {
    gitIdentity(vi.stubEnv);
    vi.stubEnv("SANOMA_EVENTS", "1");
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => lines.push(String(line)) > 0);
    await startCompany(fresh("maple"), { name: "Maple Street Studio", creator, install: writeLockfile });
    vi.mocked(process.stdout.write).mockRestore();

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(STAGES);
    expect(read("sanoma.config.ts")).toContain('export default defineConfig({\n  name: "Maple Street Studio",\n');
    expect(read("resources/sanoma/infra.ts")).toContain('hostname: "maple-street-studio.sanoma.work"');
    // The package stays named after the directory.
    expect(JSON.parse(read("package.json")).name).toBe("maple");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("leaves a directory that holds anything else alone", async () => {
    fresh();
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    expect(await startCompany(dir, { creator, install: () => Promise.reject(new Error("no install")) })).toBe(false);
    expect(existsSync(join(dir, "sanoma.config.ts"))).toBe(false);
  });
});

describe("pinDependencies", () => {
  it("pins sanoma and the connectors to the launcher's own version", () => {
    expect(pinDependencies({ ...template.dependencies, "left-alone": "^1" }, { version: "1.2.3" })).toEqual({
      "@sanoma-ai/connector-anthropic": "1.2.3",
      "@sanoma-ai/connector-github": "1.2.3",
      "@sanoma-ai/connector-openai": "1.2.3",
      "@sanoma-ai/connector-opencode": "1.2.3",
      "@sanoma-ai/connector-pi": "1.2.3",
      "@sanoma-ai/connector-resend": "1.2.3",
      "@sanoma-ai/connector-sanoma-cloud": "1.2.3",
      "left-alone": "^1",
      sanoma: "1.2.3",
    });
  });

  it("names every template connector as a devDependency of the workspace, so the tests run against the checkout", () => {
    for (const name of Object.keys(template.dependencies).filter((dep) => dep !== "sanoma")) {
      expect(root.devDependencies[name], name).toBe("workspace:*");
    }
  });
});

describe("declareName, declareSlug and slugOf", () => {
  it("writes the company's name first in the config, as given", () => {
    expect(declareName("export default defineConfig({\n  connectors: [],\n});\n", 'Ann\'s "Co" $&')).toBe(
      'export default defineConfig({\n  name: "Ann\'s \\"Co\\" $&",\n  connectors: [],\n});\n',
    );
    expect(() => declareName("export default {};\n", "Acme")).toThrow("has no `export default defineConfig({`");
  });

  it("writes the company's slug for the template's, and refuses a file without it", () => {
    const text = 'export const host = cloud.host({ name: "company", hostname: "company.sanoma.work" });\n';
    expect(declareSlug(text, "maple-$&")).toBe(
      'export const host = cloud.host({ name: "maple-$&", hostname: "maple-$&.sanoma.work" });\n',
    );
    expect(() => declareSlug("export {};\n", "maple")).toThrow('names no "company"');
  });

  it("makes a slug the Cloud takes of any name, else of the directory's", () => {
    expect(slugOf("Maple Street Studio", "maple")).toBe("maple-street-studio");
    expect(slugOf("  Café & Co.  ", "dir")).toBe("cafe-co");
    expect(slugOf("Crème Brûlée Co", "dir")).toBe("creme-brulee-co");
    expect(slugOf("AB", "dir")).toBe("ab-company");
    expect(slugOf(undefined, "Acme Ops")).toBe("acme-ops");
    // A name in another script gives no slug: the directory's stands.
    expect(slugOf("Пекарня", "bakery")).toBe("bakery");
    expect(slugOf("東京", "東京")).toBe("company");
    const long = slugOf(`${"a".repeat(39)} b`, "dir");
    expect(long).toBe("a".repeat(39));
    expect(slugOf("x".repeat(60), "dir")).toHaveLength(40);
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
    for (const taken of ["founder", "admin", "agents", "scenarios", "visitors", "anonymous"]) {
      signedIn(taken);
      expect(await whoIsStarting()).toMatchObject({ id: "founder", github: taken });
    }
  });

  it("takes the name and email it is given over git's", async () => {
    signedIn("ada-ortiz");
    const config = join(mkdtempSync(join(tmpdir(), "sanoma-git-")), "gitconfig");
    writeFileSync(config, "[user]\n\tname = Ada Ortiz\n\temail = ada@acme.test\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    expect(await whoIsStarting({ name: "Dana Reyes", email: "dana@maple.test" })).toEqual({
      id: "ada-ortiz",
      github: "ada-ortiz",
      name: "Dana Reyes",
      email: "dana@maple.test",
    });
    expect(await whoIsStarting({ name: "", email: "" })).toMatchObject({ name: "Ada Ortiz", email: "ada@acme.test" });
  });

  it("takes git's user.email as the email a host's sign-in sends codes to", async () => {
    signedIn("ada-ortiz");
    const config = join(mkdtempSync(join(tmpdir(), "sanoma-git-")), "gitconfig");
    writeFileSync(config, "[user]\n\tname = Ada Ortiz\n\temail = ada@acme.test\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    expect(await whoIsStarting()).toMatchObject({ id: "ada-ortiz", name: "Ada Ortiz", email: "ada@acme.test" });
    expect(declareFounder('export const founder = sanoma.person({ id: "founder" });\n', await whoIsStarting())).toBe(
      'export const founder = sanoma.person({ id: "ada-ortiz", github: "ada-ortiz", name: "Ada Ortiz", email: "ada@acme.test" });\n',
    );
  });
});

describe("templatePeopleIds", () => {
  it("reads from the template's text the ids and group names loading it declares", () => {
    const { people, problems } = readPeople(fileURLToPath(TEMPLATE));
    expect(problems).toEqual([]);
    const declared = [...principalIdsOf(people), ...groupNamesOf(people).filter((g) => g !== AGENTS && g !== VISITORS)];
    expect(templatePeopleIds().toSorted()).toEqual(declared.toSorted());
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

/** A pnpm that installs only a stub of `sanoma`, whose `main` says it ran, first on the PATH. */
const stubbed = () => {
  const bin = mkdtempSync(join(tmpdir(), "sanoma-bin-"));
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/bin/sh",
      "mkdir -p node_modules/sanoma/dist",
      `echo 'export const main = async (argv) => { console.log("served", JSON.stringify(argv)); return 0; };' > node_modules/sanoma/dist/cli.js`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
  return {
    ...gitIdentity(),
    PATH: `${bin}:${process.env.PATH}`,
    npm_config_user_agent: "pnpm/11.15.1 npm/? node/v24.2.0",
  };
};

describe("sanoma in an empty directory", () => {
  it("starts a company, then serves it with the sanoma it installed", async () => {
    fresh("acme");
    const done = await runCli(dir, [], stubbed());

    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toBe("served []\n");
    expect(done.stderr).toContain("installing with pnpm");
    expect(git("log", "--format=%s")).toBe(FIRST_COMMIT);
    expect(basename(dir)).toBe(JSON.parse(read("package.json")).name);
  });

  it("sanoma init names the company and who starts it as told, says each stage, then serves it", async () => {
    fresh("maple");
    const done = await runCli(
      dir,
      ["init", "--name", "Maple Street Studio", "--you", "Dana Reyes", "--email", "dana@maple.test"],
      { ...stubbed(), SANOMA_EVENTS: "1" },
    );

    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toBe(`${[...STAGES.map((stage) => JSON.stringify(stage)), "served []"].join("\n")}\n`);
    expect(read("sanoma.config.ts")).toContain('  name: "Maple Street Studio",\n');
    expect(read("resources/people.ts")).toMatch(
      /^export const founder = sanoma\.person\(\{ id: "[^"]+", .*name: "Dana Reyes", email: "dana@maple\.test" \}\);$/m,
    );
    expect(read("resources/sanoma/infra.ts")).toContain('hostname: "maple-street-studio.sanoma.work"');
  });

  it("sanoma init refuses a directory with files in it, and an email that is no address before writing anything", async () => {
    const env = stubbed();
    fresh();
    const bad = await runCli(dir, ["init", "--email", "dana"], env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--email: "dana" is not an email address');
    expect(readdirSync(dir)).toEqual([]);

    writeFileSync(join(dir, "notes.txt"), "mine\n");
    const elsewhere = await runCli(dir, ["check", "--name", "Acme"], env);
    expect(elsewhere.code).toBe(2);
    expect(elsewhere.stderr).toContain("--name, --you and --email are sanoma init's");

    const full = await runCli(dir, ["init"], env);
    expect(full.code).toBe(2);
    expect(full.stderr).toMatch(/sanoma init starts a company in an empty directory: .+ holds files already/);
  });
});

/** A workflow that sends, beside the template's, for its policy to hold. */
const WELCOME = `import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "welcome",
  title: "Welcome a lead",
  trigger: "manual",
  input: z.object({ to: z.string() }),
  uses: [resend.emails.send],
  run: async (ctx, { to }) =>
    ctx.resend.emails.send({ from: "Acme <hi@acme.test>", to, subject: "Hello", text: "Hello" }, { name: "Send it" }),
});
`;

const WELCOME_FEATURE = `Feature: Welcome a lead
  Scenario: The founder approves
    When welcome runs with
      | to | sam@acme.test |
    And "Review before it goes out" is approved by ada
    Then resend.emails.send was held for group "admin"
    And the run succeeds

  Scenario: The founder sends without a review
    Given ada is acting
    When welcome runs with
      | to | sam@acme.test |
    Then resend.emails.send was called
    And the run succeeds
`;

describe("the template", () => {
  beforeAll(ensureBuilt, 600_000);

  it("starts a company that passes sanoma check, its policy and scenarios with it, without building the app (it has no sites), and its .env.example is current", async () => {
    gitIdentity(vi.stubEnv);
    const started = fresh();
    await startCompany(started, { creator, install: async () => {} });
    dir = copyFixture(started);
    // The template's connectors: the chat's model, the sign-in code's sender, the repository's and Sanoma Cloud's.
    for (const name of templateConnectors) linkConnector(dir, name);
    rmSync(started, { recursive: true, force: true });
    // A workflow that sends, which the template's policy holds for admin unless someone in admin asked.
    writeFileSync(join(dir, "workflows/welcome.ts"), WELCOME);
    mkdirSync(join(dir, "scenarios/welcome"));
    writeFileSync(join(dir, "scenarios/welcome/welcome.feature"), WELCOME_FEATURE);
    const env = {
      SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-template"),
      ANTHROPIC_API_KEY: "",
      RESEND_API_KEY: "",
      SANOMA_CLOUD_TOKEN: "",
    };
    const checked = await runCli(dir, ["check"], env);
    expect(checked.code, `${checked.stdout}${checked.stderr}`).toBe(0);
    // The generated SDK, written before tsc, and the app bundle's build cache: no site, so no sites' files.
    const logged = checked.stderr.split("\n");
    expect(logged.indexOf("wrote .sanoma/api.ts")).toBeGreaterThan(-1);
    expect(logged.indexOf("wrote .sanoma/api.ts")).toBeLessThan(logged.indexOf("tsc"));
    expect(logged).toContain("build the app bundle");
    expect(readdirSync(join(dir, ".sanoma"))).toEqual(["api.ts", "app", "schema.cedarschema"]);
    expect(existsSync(join(dir, "sites"))).toBe(false);
    // The policy holds, so the scenarios ran: each passed under it.
    expect(logged).toContain("passed scenarios/record-lead/record.feature › A lead is recorded");
    expect(logged).toContain("passed scenarios/welcome/welcome.feature › The founder approves");
    expect(logged).toContain("passed scenarios/welcome/welcome.feature › The founder sends without a review");
    expect(readFileSync(join(dir, ".sanoma/api.ts"), "utf8")).toContain("recordLead: WorkflowFn<");
    const current = await runCli(dir, ["env", "--check"], env);
    expect(current.code, current.stderr).toBe(0);
  }, 120_000);
});
