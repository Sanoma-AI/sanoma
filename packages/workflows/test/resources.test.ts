import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { github } from "@sanoma/connector-github";
import { github as githubTypes } from "@sanoma/connector-github/resources";
import { stripe } from "@sanoma/connector-stripe";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, readResources } from "../src/describe.ts";
import {
  allowAll,
  defineConnector,
  defineResource,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
} from "../src/index.ts";
import { BAD_DATA_FILES } from "./bad-data-files.ts";
import company from "./fixtures/company/sanoma.config.ts";

// A connector whose package does not exist: the reader finds it by `info.package`, and never imports it.
const widget = defineResource({
  vendor: "acme",
  type: "widget",
  title: "Widget",
  identity: "name",
  schema: z.object({ name: z.string(), size: z.number().nullish(), url: z.string().nullish() }),
  fields: { immutable: [], vendorOwned: ["url"], writeOnly: [] },
  find: ({ name }) => name,
});
const acme = defineConnector("acme", { widget }, { package: "@acme/sanoma-connector" });

const base = {
  workflows: [],
  connectors: [github, stripe, acme],
  drivers: [],
  policy: allowAll,
  ledger: memoryLedger(),
} satisfies SanomaConfig;

const companyDir = fileURLToPath(new URL("./fixtures/company/", import.meta.url));

describe("readResources", () => {
  it("reads each declared resource from the data files beside the config, without running them", () => {
    const resources = readResources(company);
    expect(resources.map((r) => [r.id, r.vendor, r.type, r.name])).toEqual([
      ["resources/billing/stripe.ts#pro", "stripe", "product", "prod_SanomaFixturePro"],
      ["resources/billing/stripe.ts#events", "stripe", "webhook_endpoint", "we_SanomaFixtureEvents"],
      ["resources/identity/github.ts#website", "github", "repository", "website"],
      ["resources/identity/github.ts#docs", "github", "repository", "docs"],
      ["resources/identity/github.ts#websiteMain", "github", "branch_protection", "website:main"],
      ["resources/identity/rules.ts#docsMain", "github", "branch_protection", "docs:main"],
    ]);
    const website = resources.find((r) => r.id === "resources/identity/github.ts#website")!;
    expect(website).toEqual({
      id: "resources/identity/github.ts#website",
      vendor: "github",
      type: "repository",
      name: "website",
      span: [expect.any(Number), expect.any(Number)],
      desired: {
        name: "website",
        description: "The company website",
        visibility: "public",
        has_wiki: false,
        topics: ["website", "astro"],
      },
      refs: {},
    });
    // The id's file is relative to the config's root, and the span indexes into its text.
    const source = readFileSync(join(companyDir, "resources/identity/github.ts"), "utf8");
    expect(source.slice(...website.span)).toMatch(/^export const website = [\s\S]*\}\);$/);
    // A template literal without `${}` is a string.
    expect(resources.find((r) => r.id === "resources/identity/github.ts#docs")?.desired.description).toBe(
      "Product documentation",
    );
  });

  it("holds a reference as the name it stands for, with the id of the resource it names in refs", () => {
    const byId = new Map(readResources(company).map((r) => [r.id, r]));
    const rule = byId.get("resources/identity/github.ts#websiteMain")!;
    expect(rule.desired).toEqual({
      repository_id: "website",
      pattern: "main",
      enforce_admins: true,
      required_pull_request_reviews: [{ required_approving_review_count: 1, dismiss_stale_reviews: true }],
    });
    expect(rule.refs).toEqual({ repository_id: "resources/identity/github.ts#website" });
    // What a drift check compares: the vendor's state names the repository too, so no drift.
    const { normalize } = githubTypes.branch_protection;
    const desired = rule.desired as Parameters<typeof normalize>[1];
    expect(normalize({ ...desired, allows_deletions: false }, desired)).toEqual(normalize(desired, desired));
    // Across files: the import is the reference.
    expect(byId.get("resources/identity/rules.ts#docsMain")).toMatchObject({
      name: "docs:main",
      desired: { repository_id: "docs" },
      refs: { repository_id: "resources/identity/github.ts#docs" },
    });
  });

  it("is what describeConfig lists as the config's resources, without problems", () => {
    const { resources, problems } = describeConfig(company);
    expect(resources).toEqual(readResources(company));
    expect(problems).toEqual([]);
    expect(JSON.parse(JSON.stringify(resources))).toEqual(resources);
  });

  describe("refuses", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Writes `files` under `resources/` in a fresh project, and returns the problems `readResources` throws. */
    const problems = (files: Record<string, string>, config: Partial<SanomaConfig> = {}): string[] => {
      dir = project(files);
      try {
        readResources({ ...base, ...config, root: dir });
      } catch (e) {
        const [head, ...lines] = (e as Error).message.split("\n");
        expect(head).toBe("The resources' data files have problems:");
        return lines.map((line) => line.trim());
      }
      throw new Error("read without problems");
    };
    const GH = `import { github } from "@sanoma/connector-github/resources";\n`;

    it.each(BAD_DATA_FILES)("%s, at file:line:column, as the lint does", (name, source, at, message) => {
      expect(problems({ [`bad/${name}.ts`]: source })).toEqual([
        expect.stringMatching(new RegExp(`^resources/bad/${name}\\.ts:${at}: ${message.source.replace(/^\^/, "")}`)),
      ]);
    });

    it("a constructors import that is not exactly the resources entry of a connector the config has", () => {
      expect(
        problems({
          "a.ts": `import { ghost } from "@sanoma/connector-ghost/resources";\nexport const p = ghost.post({ title: "x" });\n`,
          "b.ts": `import { gh } from "@sanoma/connector-github/resources";\nexport const r = gh.repository({ name: "x" });\n`,
          // acme's package is @acme/sanoma-connector: no name is guessed from the vendor.
          "c.ts": `import { acme } from "@sanoma/connector-acme/resources";\nexport const w = acme.widget({ name: "x" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:1:10: \"@sanoma/connector-ghost/resources\" is not the resources entry of a connector in the config's `connectors`: add the connector, and import from its package's `/resources`",
        'resources/b.ts:1:10: "@sanoma/connector-github/resources" exports its constructors as github: `import { github } from "@sanoma/connector-github/resources"`',
        "resources/c.ts:1:10: \"@sanoma/connector-acme/resources\" is not the resources entry of a connector in the config's `connectors`: add the connector, and import from its package's `/resources`",
      ]);
    });

    it("a resource type the connector does not declare", () => {
      expect(problems({ "a.ts": `${GH}export const r = github.repo({ name: "x" });\n` })).toEqual([
        "resources/a.ts:2:1: github has no resource type repo: its types are repository, branch_protection, team_membership",
      ]);
    });

    it("what the resource type refuses, as calling it would", () => {
      expect(
        problems({
          "a.ts": `${GH}export const a = github.repository({ name: "a", wiki: true });
export const b = github.repository({ name: "b", html_url: "https://github.com/x/b" });
export const c = github.repository({ name: "c", has_wiki: "yes" });
`,
          "b.ts": `import { stripe } from "@sanoma/connector-stripe/resources";\nexport const p = stripe.product({ name: "Pro" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:2:1: export const a: github.repository: no field wiki",
        "resources/a.ts:3:1: export const b: github.repository: leave out html_url: the vendor sets it",
        "resources/a.ts:4:1: export const c: github.repository: ✖ Invalid input: expected boolean, received string → at has_wiki",
        "resources/b.ts:2:1: export const p: stripe.product: its id is missing",
      ]);
    });

    it("a reference where the type takes none, or to a resource of another type", () => {
      expect(
        problems({
          "a.ts": `${GH}export const web = github.repository({ name: "web" });
export const copy = github.repository({ name: web });
export const main = github.branch_protection({ repository_id: web, pattern: "main" });
export const rule = github.branch_protection({ repository_id: main, pattern: "next" });
`,
        }),
      ).toEqual([
        "resources/a.ts:3:1: export const copy: github.repository: name takes a value, not a resource (github.repository web)",
        "resources/a.ts:5:1: export const rule: github.branch_protection: repository_id names a resource of type github.repository, not github.branch_protection (web:main)",
      ]);
    });

    it("a reference to a resource no data file declares, or to a file that is not one", () => {
      expect(
        problems({
          "a.ts": `${GH}import { site } from "./b.ts";\nimport { x } from "./c.ts";\nexport const m = github.branch_protection({ repository_id: site, pattern: "main" });\nexport const n = github.branch_protection({ repository_id: x, pattern: "main" });\n`,
          "b.ts": `${GH}export const web = github.repository({ name: "web" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:2:10: site is not a resource resources/b.ts declares",
        'resources/a.ts:3:10: "./c.ts" is not a data file under resources/',
      ]);
    });

    it("nothing more where a reference names a resource whose value is refused", () => {
      expect(
        problems({
          "a.ts": `${GH}import { web } from "./b.ts";\nexport const m = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
          "b.ts": `${GH}export const web = github.repository({ name: process.env.NAME });\n`,
        }),
      ).toEqual([expect.stringMatching(/^resources\/b\.ts:2:46: process is not allowed in a data file/)]);
    });

    it("a reference cycle", () => {
      expect(
        problems({
          "a.ts": `${GH}import { b } from "./b.ts";\nexport const a = github.branch_protection({ repository_id: b, pattern: "main" });\n`,
          "b.ts": `${GH}import { a } from "./a.ts";\nexport const b = github.branch_protection({ repository_id: a, pattern: "main" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:3:1: resources/a.ts#a refers to itself: resources/a.ts#a → resources/b.ts#b → resources/a.ts#a",
      ]);
    });

    it("two resources of one type with one name", () => {
      expect(
        problems({
          "a.ts": `${GH}export const site = github.repository({ name: "web" });\n`,
          "b/c.ts": `${GH}export const web = github.repository({ name: "web", has_wiki: false });\n`,
        }),
      ).toEqual([
        'resources/b/c.ts:2:1: github.repository "web" is declared twice, also as resources/a.ts#site: declare each resource once, and import it where it is used',
      ]);
    });

    it("a syntax error", () => {
      expect(problems({ "a.ts": `${GH}export const r = github.repository({ name: "x" ;\n` })).toEqual([
        expect.stringMatching(/^resources\/a\.ts:2:\d+: syntax: /),
      ]);
    });

    it("a config with no root, rather than guess one", () => {
      expect(() => readResources(base)).toThrow(
        "The resources' data files have problems:\n  The config has no root, so its data files cannot be found: make it with defineConfig, which records its file, or set its `root`",
      );
    });
  });

  it("finds a connector by its package, reads only data files, and never imports one", () => {
    const dir = project({
      // The package does not exist: importing the file would fail.
      "widgets.ts": `import { acme } from "@acme/sanoma-connector/resources";\nexport const big = acme.widget({ name: "big", size: -2 });\nexport default [big];\n`,
      // Neither tests nor declarations are data files, nor a directory named like one.
      "widgets.test.ts": `throw new Error("not a data file");\n`,
      "types.d.ts": `declare const x: number;\n`,
      "dir.ts/inner.txt": "",
    });
    try {
      // Nor a link, which may lead out of resources/, or nowhere.
      symlinkSync(join(dir, "missing.ts"), join(dir, "resources", "dangling.ts"));
      expect(readResources({ ...base, root: dir })).toEqual([
        expect.objectContaining({
          id: "resources/widgets.ts#big",
          vendor: "acme",
          name: "big",
          desired: { name: "big", size: -2 },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeConfig's problems", () => {
  it("are data: the resources read without one are listed beside them", () => {
    const dir = project({
      "good.ts": `import { github } from "@sanoma/connector-github/resources";\nexport const web = github.repository({ name: "web" });\n`,
      "bad.ts": `import { github } from "@sanoma/connector-github/resources";\nimport { web } from "./good.ts";\nexport const docs = github.repository({ name: "docs", description: process.env.X });\nexport const main = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
    });
    try {
      const { resources, problems } = describeConfig({ ...base, root: dir });
      expect(resources.map((r) => r.id)).toEqual(["resources/bad.ts#main", "resources/good.ts#web"]);
      expect(problems).toEqual([
        {
          file: "resources/bad.ts",
          line: 3,
          column: 68,
          message: expect.stringMatching(/^process is not allowed in a data file/),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("say so, once, when the config has no root", () => {
    expect(describeConfig(base)).toMatchObject({
      resources: [],
      problems: [{ message: expect.stringMatching(/no root/) }],
    });
  });
});

describe("resolveConfig's root", () => {
  it("is the directory of the file defineConfig was called from", () => {
    expect(company.file).toBe(join(companyDir, "sanoma.config.ts"));
    expect(resolveConfig(company).root).toBe(join(companyDir, "."));
  });

  it("is the config's own `root` when it has one, as a bundle sets it, and absent with neither", () => {
    expect(resolveConfig({ ...company, root: "/srv/company" }).root).toBe("/srv/company");
    expect(resolveConfig(base).root).toBeUndefined();
    expect("root" in resolveConfig(base)).toBe(false);
  });
});

/** A fresh project with `files` under its `resources/`; returns its directory. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-resources-"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "resources", path)), { recursive: true });
    writeFileSync(join(dir, "resources", path), source);
  }
  return dir;
}
