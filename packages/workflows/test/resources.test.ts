import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { github } from "@sanoma-ai/connector-github";
import { github as githubTypes } from "@sanoma-ai/connector-github/resources";
import { stripe } from "@sanoma-ai/connector-stripe";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parsed } from "../src/ast.ts";
import { readDataFile } from "../src/datafile.ts";
import { describeConfig, readDataFiles, readResources } from "../src/describe.ts";
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
  schema: z.object({
    name: z.string(),
    size: z.number().nullish(),
    url: z.string().nullish(),
    token: z.string().min(8).nullish(),
  }),
  fields: { immutable: [], vendorOwned: ["url"], writeOnly: ["token"] },
  find: ({ name }) => name,
});
const acme = defineConnector("acme", { widget }, { package: "@acme/sanoma-connector" });

const base = {
  workflows: [],
  connectors: [github, stripe, acme],
  policy: allowAll,
  ledger: memoryLedger(),
} satisfies SanomaConfig;

const companyDir = fileURLToPath(new URL("./fixtures/company/", import.meta.url));

describe("readResources", () => {
  it("reads each declared resource from the data files beside the config, without running them", () => {
    const resources = readResources(company);
    // Named by identity, else (Stripe's, which have none) by export; bound as the lockfile says.
    expect(resources.map((r) => [r.id, r.vendor, r.type, r.name, r.identity, r.binding])).toEqual([
      ["resources/billing/stripe.ts#pro", "stripe", "product", "pro", undefined, "prod_SanomaFixturePro"],
      ["resources/billing/stripe.ts#events", "stripe", "webhook_endpoint", "events", undefined, undefined],
      ["resources/identity/github.ts#website", "github", "repository", "website", "website", "R_website"],
      ["resources/identity/github.ts#docs", "github", "repository", "docs", "docs", "R_docs"],
      [
        "resources/identity/github.ts#websiteMain",
        "github",
        "branch_protection",
        "website:main",
        "website:main",
        "BPR_website:main",
      ],
      ["resources/identity/rules.ts#docsMain", "github", "branch_protection", "docs:main", "docs:main", undefined],
    ]);
    const website = resources.find((r) => r.id === "resources/identity/github.ts#website")!;
    expect(website).toEqual({
      id: "resources/identity/github.ts#website",
      file: "resources/identity/github.ts",
      vendor: "github",
      type: "repository",
      name: "website",
      identity: "website",
      binding: "R_website",
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

  it("is what describeConfig lists as the config's resources, with their bindings and the orphans, without problems", () => {
    const { resources, orphans, problems } = describeConfig(company);
    expect(resources).toEqual(readResources(company));
    expect(orphans).toEqual(readDataFiles(dirname(company.file!), company.connectors).orphans);
    expect(orphans).toHaveLength(1);
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
    const GH = `import { github } from "@sanoma-ai/connector-github/resources";\n`;

    it.each(BAD_DATA_FILES)("%s, at file:line:column, as the lint does", (name, source, at, message) => {
      expect(problems({ [`bad/${name}.ts`]: source })).toEqual([
        expect.stringMatching(new RegExp(`^resources/bad/${name}\\.ts:${at}: ${message.source.replace(/^\^/, "")}`)),
      ]);
    });

    it("a constructors import that is not exactly the resources entry of a connector the config has", () => {
      expect(
        problems({
          "a.ts": `import { ghost } from "@sanoma-ai/connector-ghost/resources";\nexport const p = ghost.post({ title: "x" });\n`,
          "b.ts": `import { gh } from "@sanoma-ai/connector-github/resources";\nexport const r = gh.repository({ name: "x" });\n`,
          // acme's package is @acme/sanoma-connector: no name is guessed from the vendor.
          "c.ts": `import { acme } from "@sanoma-ai/connector-acme/resources";\nexport const w = acme.widget({ name: "x" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:1:10: \"@sanoma-ai/connector-ghost/resources\" is not the resources entry of a connector in the config's `connectors`: add the connector, and import from its package's `/resources`",
        'resources/b.ts:1:10: "@sanoma-ai/connector-github/resources" exports its constructors as github: `import { github } from "@sanoma-ai/connector-github/resources"`',
        "resources/c.ts:1:10: \"@sanoma-ai/connector-acme/resources\" is not the resources entry of a connector in the config's `connectors`: add the connector, and import from its package's `/resources`",
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
          "b.ts": `import { stripe } from "@sanoma-ai/connector-stripe/resources";\nexport const p = stripe.product({ id: "prod_1", name: "Pro" });\n`,
          "c.ts": `${GH}export const r = github.repository({ name: "" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:2:1: export const a: github.repository: no field wiki",
        "resources/a.ts:3:1: export const b: github.repository: leave out html_url: the vendor sets it",
        "resources/a.ts:4:1: export const c: github.repository: ✖ Invalid input: expected boolean, received string → at has_wiki",
        "resources/b.ts:2:1: export const p: stripe.product: leave out id: the vendor sets it",
        "resources/c.ts:2:1: export const r: github.repository: its name is missing",
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

    it("two resources of one type with one identity, but not two without one", () => {
      expect(
        problems({
          "a.ts": `${GH}export const site = github.repository({ name: "web" });\n`,
          "b/c.ts": `${GH}export const web = github.repository({ name: "web", has_wiki: false });\n`,
        }),
      ).toEqual([
        'resources/b/c.ts:2:1: github.repository "web" is declared twice, also as resources/a.ts#site: declare each resource once, and import it where it is used',
      ]);
      const STRIPE = `import { stripe } from "@sanoma-ai/connector-stripe/resources";\n`;
      dir = project({
        "a.ts": `${STRIPE}export const pro = stripe.product({ name: "Pro" });\n`,
        "b.ts": `${STRIPE}export const pro = stripe.product({ name: "Pro" });\n`,
      });
      expect(readResources({ ...base, root: dir }).map((r) => r.name)).toEqual(["pro", "pro"]);
    });

    it("a lockfile that is not JSON, or not bindings", () => {
      expect(
        problems({ "a.ts": `${GH}export const r = github.repository({ name: "x" });\n`, "sanoma.lock.json": "{" }),
      ).toEqual([expect.stringMatching(/^resources\/sanoma\.lock\.json: not JSON: /)]);
      expect(
        problems({
          "sanoma.lock.json": JSON.stringify({ "resources/a.ts#r": { type: "github.repository" }, nope: {} }),
        }),
      ).toEqual([
        'resources/sanoma.lock.json: ✖ Invalid key in record → at nope ✖ Invalid input: expected string, received undefined → at ["resources/a.ts#r"].id',
      ]);
    });

    it("a binding of another type than its declaration's, and two declarations bound to one object", () => {
      expect(
        problems({
          "a.ts": `${GH}export const web = github.repository({ name: "web" });
export const docs = github.repository({ name: "docs" });
export const main = github.branch_protection({ repository_id: web, pattern: "main" });
`,
          "sanoma.lock.json": JSON.stringify({
            "resources/a.ts#web": { type: "github.repository", id: "R_1" },
            "resources/a.ts#docs": { type: "github.repository", id: "R_1" },
            "resources/a.ts#main": { type: "github.repository", id: "R_2" },
          }),
        }),
      ).toEqual([
        "resources/a.ts:3:1: resources/a.ts#docs is bound to the same github.repository R_1 as resources/a.ts#web in resources/sanoma.lock.json: bind each object once",
        "resources/a.ts:4:1: resources/a.ts#main is bound to a github.repository in resources/sanoma.lock.json, but declares a github.branch_protection",
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

  it("joins each declaration to its binding, and lists the bindings no data file declares", () => {
    const { resources, bindings, orphans, problems } = readDataFiles(dirname(company.file!), company.connectors);
    expect(problems).toEqual([]);
    expect(Object.keys(bindings)).toHaveLength(5);
    expect(resources.filter((r) => r.binding === undefined).map((r) => r.id)).toEqual([
      "resources/billing/stripe.ts#events",
      "resources/identity/rules.ts#docsMain",
    ]);
    expect(orphans).toEqual([
      { key: "resources/billing/stripe.ts#basic", type: "stripe.product", id: "prod_SanomaFixtureBasic" },
    ]);
    // A declaration whose value is refused is still declared: its binding is no orphan.
    const dir = project({
      "a.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const web = github.repository({ name: process.env.NAME });\n`,
      "sanoma.lock.json": JSON.stringify({ "resources/a.ts#web": { type: "github.repository", id: "R_1" } }),
    });
    try {
      const refused = readDataFiles(dir, base.connectors);
      expect([refused.resources, refused.orphans, refused.problems.length]).toEqual([[], [], 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("collections in resources/data.ts", () => {
  const DATA = `import { collection } from "sanoma/data";

export const leads = collection({
  name: "outbound",
  title: "Outbound",
  key: "company",
  fields: { company: "text", stage: { enum: ["new", "won"] }, seats: { type: "number", optional: true } },
});
`;

  it("are read where they are declared, their declarations plain values collection() takes, never as resources", () => {
    const filename = "/repo/resources/data.ts";
    const { program } = parsed(DATA, filename);
    expect(readDataFile(program, filename)).toEqual({
      imports: [],
      exports: [],
      collections: [
        {
          export: "leads",
          name: "outbound",
          start: DATA.indexOf("export const"),
          end: DATA.length - 1,
        },
      ],
      declared: [],
      problems: [],
    });
  });

  it("are still where they are declared, by a name written out, when the rest cannot be read", () => {
    const filename = "/repo/resources/data.ts";
    const source = `import { collection } from "sanoma/data";
export const leads = collection({ name: "leads", key: "id", title: \`Leads \${"x"}\`, fields: { id: "text" } });
`;
    const read = readDataFile(parsed(source, filename).program, filename);
    expect(read.collections.map((c) => [c.export, c.name])).toEqual([["leads", "leads"]]);
    expect(read.problems).toHaveLength(1);
  });

  it("are listed where they are declared, beside the resources, matched to no connector, type or lockfile", () => {
    const dir = project({
      "data.ts": DATA,
      "identity/github.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const site = github.repository({ name: "site" });\n`,
    });
    try {
      const read = readDataFiles(dir, base.connectors);
      expect(read.problems).toEqual([]);
      expect(read.collections).toEqual([
        {
          id: "resources/data.ts#leads",
          file: "resources/data.ts",
          name: "outbound",
          span: [DATA.indexOf("export const"), DATA.length - 1],
        },
      ]);
      expect(read.resources.map((r) => r.id)).toEqual(["resources/identity/github.ts#site"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are no resource another data file names", () => {
    const dir = project({
      "data.ts": DATA,
      "identity/github.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nimport { leads } from "../data.ts";\nexport const site = github.repository({ name: leads });\n`,
    });
    try {
      expect(readDataFiles(dir, base.connectors).problems).toEqual([
        {
          file: "resources/identity/github.ts",
          line: 2,
          column: 23,
          message:
            'import "../data.ts" is not allowed in a data file: resources/data.ts holds collections, which no resource names; import resources from other data files',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secret()", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ACME = `import { acme } from "@acme/sanoma-connector/resources";\n`;

  it("reads a secret at a write-only field as its marker, imported from either entry", () => {
    dir = project({
      "a.ts": `${ACME}import { secret } from "sanoma/resources";\nexport const a = acme.widget({ name: "a", token: secret("A_TOKEN") });\n`,
      "b.ts": `${ACME}import { secret as s } from "@sanoma-ai/workflows/resources";\nexport const b = acme.widget({ name: "b", token: s("B_TOKEN", { generate: true }) });\n`,
    });
    const { resources, problems } = readDataFiles(dir, base.connectors);
    expect(problems).toEqual([]);
    expect(resources.map((r) => r.desired)).toEqual([
      { name: "a", token: { $secret: "A_TOKEN" } },
      { name: "b", token: { $secret: "B_TOKEN", generate: true } },
    ]);
  });

  it("refuses a secret anywhere else, as the type does", () => {
    dir = project({
      "a.ts": `${ACME}import { secret } from "sanoma/resources";\nexport const a = acme.widget({ name: secret("A_NAME") });\n`,
    });
    expect(readDataFiles(dir, base.connectors).problems).toEqual([
      {
        file: "resources/a.ts",
        line: 3,
        column: 1,
        message: "export const a: acme.widget: name is not write-only, so it takes a value, not a secret (A_NAME)",
      },
    ]);
  });
});

describe("describeConfig's problems", () => {
  it("are data: the resources read without one are listed beside them", () => {
    const dir = project({
      "good.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const web = github.repository({ name: "web" });\n`,
      "bad.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nimport { web } from "./good.ts";\nexport const docs = github.repository({ name: "docs", description: process.env.X });\nexport const main = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
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
