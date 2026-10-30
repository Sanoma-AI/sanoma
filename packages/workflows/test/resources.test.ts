import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { github } from "@sanoma-ai/connector-github";
import { github as githubTypes } from "@sanoma-ai/connector-github/resources";
import { stripe } from "@sanoma-ai/connector-stripe";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, loadDataFiles, readResources } from "../src/describe.ts";
import { defineConnector, defineResource, memoryLedger, resolveConfig, type SanomaConfig } from "../src/index.ts";
import { exportSpan, problemLine } from "../src/shared.ts";
import company from "./fixtures/company/sanoma.config.ts";

// A connector whose package does not exist: the loader serves its constructors by `info.package`, and never imports it.
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
  ledger: memoryLedger(),
} satisfies SanomaConfig;

const companyDir = fileURLToPath(new URL("./fixtures/company/", import.meta.url));

describe("readResources", () => {
  it("reads each declared resource from the data files beside the config, as loading them makes them", () => {
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
      at: { file: "resources/identity/github.ts", export: "website" },
      desired: {
        name: "website",
        description: "The company website",
        visibility: "public",
        has_wiki: false,
        topics: ["website", "astro"],
      },
      refs: {},
    });
    // The id's file is relative to the config's root, and its export is found in its text.
    const source = readFileSync(join(companyDir, "resources/identity/github.ts"), "utf8");
    expect(source.slice(...exportSpan(source, website.at.export)!)).toMatch(/^export const website = [\s\S]*\}\);$/);
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
    expect(orphans).toEqual(loadDataFiles(dirname(company.file!), company.connectors).orphans);
    expect(orphans).toHaveLength(1);
    expect(problems).toEqual([]);
    expect(JSON.parse(JSON.stringify(resources))).toEqual(resources);
  });

  describe("refuses", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Writes `files` under `resources/` in a fresh project, and returns the problems `readResources` throws. */
    const problems = (
      files: Record<string, string>,
      config: Partial<SanomaConfig> = {},
      others: Record<string, string> = {},
    ): string[] => {
      dir = project(files, others);
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

    it("an import of a connector the config does not have, or of a name its constructors entry does not export", () => {
      expect(
        problems({
          "a.ts": `import { ghost } from "@sanoma-ai/connector-ghost/resources";\nexport const p = ghost.post({ title: "x" });\n`,
          "b.ts": `import { gh } from "@sanoma-ai/connector-github/resources";\nexport const r = gh.repository({ name: "x" });\n`,
          // acme's package is @acme/sanoma-connector: no name is guessed from the vendor.
          "c.ts": `import { acme } from "@sanoma-ai/connector-acme/resources";\nexport const w = acme.widget({ name: "x" });\n`,
        }),
      ).toEqual([
        "resources/a.ts: \"@sanoma-ai/connector-ghost/resources\" is not the resources entry of a connector in the config's `connectors`: add the connector, and import from its package's `/resources`",
        "resources/b.ts: The requested module '@sanoma-ai/connector-github/resources' does not provide an export named 'gh'",
        "resources/c.ts: \"@sanoma-ai/connector-acme/resources\" is not the resources entry of a connector in the config's `connectors`: add the connector, and import from its package's `/resources`",
      ]);
    });

    it("an import of a file or package that is not there, and top-level await", () => {
      expect(
        problems({
          "a.ts": `import { x } from "../../lib/site.ts";\nexport const y = x;\n`,
          "b.ts": `import { z } from "zod";\nexport const s = z.string();\n`,
          "c.ts": `${GH}export const r = github.repository({ name: await Promise.resolve("x") });\n`,
        }),
      ).toEqual([
        'resources/a.ts: "../../lib/site.ts" cannot be found: import a file that is there, or a package the company has',
        'resources/b.ts: "zod" cannot be found: import a file that is there, or a package the company has',
        "resources/c.ts: a data file is loaded synchronously: leave out top-level `await`, and compute values where they are used",
      ]);
    });

    it("what a file throws as it loads, where it throws it, and nothing at a file that imports it", () => {
      expect(
        problems({
          "a.ts": `${GH}import { web } from "./b.ts";\nexport const main = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
          "b.ts": `${GH}export const web = github.repository({ name: "web", description: secret("X") });\n`,
          "c.ts": `${GH}export const web = github.repository({ name: "c" });\nexport const web = github.repository({ name: "d" });\n`,
        }),
      ).toEqual([
        "resources/b.ts:2:66: secret is not defined",
        "resources/c.ts: Identifier 'web' has already been declared",
      ]);
    });

    it("a resource type the connector does not declare", () => {
      expect(problems({ "a.ts": `${GH}export const r = github.repo({ name: "x" });\n` })).toEqual([
        "resources/a.ts:2:25: github has no resource type repo: its types are repository, branch_protection, team_membership, repository_deploy_key",
      ]);
    });

    it("what the resource type refuses, as calling it does: the first in each file, which stops it", () => {
      expect(
        problems({
          "a.ts": `${GH}export const a = github.repository({ name: "a", wiki: true });\nexport const b = github.repository({ name: "b" });\n`,
          "b.ts": `${GH}export const b = github.repository({ name: "b", html_url: "https://github.com/x/b" });\n`,
          "c.ts": `${GH}export const c = github.repository({ name: "c", has_wiki: "yes" });\n`,
          "d.ts": `import { stripe } from "@sanoma-ai/connector-stripe/resources";\nexport const p = stripe.product({ id: "prod_1", name: "Pro" });\n`,
          "e.ts": `${GH}export const r = github.repository({ name: process.env.NO_SUCH_NAME ?? "" });\n`,
        }),
      ).toEqual([
        "resources/a.ts:2:25: github.repository: no field wiki",
        "resources/b.ts:2:25: github.repository: leave out html_url: the vendor sets it",
        "resources/c.ts:2:25: github.repository: ✖ Invalid input: expected boolean, received string → at has_wiki",
        "resources/d.ts:2:25: stripe.product: leave out id: the vendor sets it",
        "resources/e.ts:2:25: github.repository: its name is missing",
      ]);
    });

    it("a reference where the type takes none, or to a resource of another type", () => {
      expect(
        problems({
          "a.ts": `${GH}export const web = github.repository({ name: "web" });
export const copy = github.repository({ name: web });
`,
          "b.ts": `${GH}export const site = github.repository({ name: "site" });
export const main = github.branch_protection({ repository_id: site, pattern: "main" });
export const rule = github.branch_protection({ repository_id: main, pattern: "next" });
`,
        }),
      ).toEqual([
        "resources/a.ts:3:28: github.repository: name takes a value, not a resource (github.repository web)",
        "resources/b.ts:4:28: github.branch_protection: repository_id names a resource of type github.repository, not github.branch_protection (site:main)",
      ]);
    });

    it("a resource made but not exported, or exported twice, and one naming a resource no data file exports", () => {
      expect(
        problems(
          {
            "a.ts": `${GH}import { site } from "../lib/site.ts";\nexport const m = github.branch_protection({ repository_id: site, pattern: "main" });\n`,
            "b.ts": `${GH}github.repository({ name: "loose" });\nexport const web = github.repository({ name: "web" });\nexport const site = web;\n`,
          },
          {},
          {
            "lib/site.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const site = github.repository({ name: "site" });\n`,
          },
        ),
      ).toEqual([
        'resources/a.ts#m: repository_id names a github.repository "site" that no data file exports: export it from a data file and import it here',
        "resources/b.ts#web: resources/b.ts#web and resources/b.ts#site are one github.repository: export each resource under one name",
        'resources/b.ts: a github.repository "loose" is made here but not exported: declare each resource as its own `export const <name> = <vendor>.<type>({ … })`',
      ]);
    });

    it("nothing more where a reference names a resource whose value is refused", () => {
      expect(
        problems({
          "a.ts": `${GH}import { web } from "./b.ts";\nexport const m = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
          "b.ts": `${GH}export const web = github.repository({ name: process.env.NO_SUCH_NAME });\n`,
        }),
      ).toEqual([
        "resources/b.ts:2:27: github.repository: ✖ Invalid input: expected string, received undefined → at name",
      ]);
    });

    it("a reference cycle, which cannot be loaded", () => {
      expect(
        problems({
          "a.ts": `${GH}import { b } from "./b.ts";\nexport const a = github.branch_protection({ repository_id: b, pattern: "main" });\n`,
          "b.ts": `${GH}import { a } from "./a.ts";\nexport const b = github.branch_protection({ repository_id: a, pattern: "main" });\n`,
        }),
      ).toEqual(["resources/b.ts:3:60: Cannot access 'a' before initialization"]);
    });

    it("two resources of one type with one identity, but not two without one", () => {
      expect(
        problems({
          "a.ts": `${GH}export const site = github.repository({ name: "web" });\n`,
          "b/c.ts": `${GH}export const web = github.repository({ name: "web", has_wiki: false });\n`,
        }),
      ).toEqual([
        'resources/b/c.ts#web: github.repository "web" is declared twice, also as resources/a.ts#site: declare each resource once, and import it where it is used',
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
        "resources/a.ts#docs: resources/a.ts#docs is bound to the same github.repository R_1 as resources/a.ts#web in resources/sanoma.lock.json: bind each object once",
        "resources/a.ts#main: resources/a.ts#main is bound to a github.repository in resources/sanoma.lock.json, but declares a github.branch_protection",
      ]);
    });

    it("a syntax error", () => {
      expect(problems({ "a.ts": `${GH}export const r = github.repository({ name: "x" ;\n` })).toEqual([
        "resources/a.ts:2:48: Expected ',', got ';'",
      ]);
    });

    it("a config with no root, rather than guess one", () => {
      expect(() => readResources(base)).toThrow(
        "The resources' data files have problems:\n  The config has no root, so its data files cannot be found: make it with defineConfig, which records its file, or set its `root`",
      );
    });
  });

  it("joins each declaration to its binding, and lists the bindings no data file declares", () => {
    const { resources, bindings, orphans, problems } = loadDataFiles(dirname(company.file!), company.connectors);
    expect(problems).toEqual([]);
    expect(Object.keys(bindings)).toHaveLength(5);
    expect(resources.filter((r) => r.binding === undefined).map((r) => r.id)).toEqual([
      "resources/billing/stripe.ts#events",
      "resources/identity/rules.ts#docsMain",
    ]);
    expect(orphans).toEqual([
      { key: "resources/billing/stripe.ts#basic", type: "stripe.product", id: "prod_SanomaFixtureBasic" },
    ]);
    // A binding under a file that fails to load is no orphan: what the file declares is not known.
    const dir = project({
      "a.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const web = github.repository({ name: process.env.NO_SUCH_NAME });\n`,
      "sanoma.lock.json": JSON.stringify({ "resources/a.ts#web": { type: "github.repository", id: "R_1" } }),
    });
    try {
      const refused = loadDataFiles(dir, base.connectors);
      expect([refused.resources, refused.orphans, refused.problems.length]).toEqual([[], [], 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a connector's constructors by its package, never importing it, and loads only data files", () => {
    const dir = project({
      // The package does not exist: only the loader's constructors make the file load.
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

  it("are listed where they are declared, beside the resources, matched to no connector, type or lockfile", () => {
    const dir = project({
      "data.ts": DATA,
      "identity/github.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const site = github.repository({ name: "site" });\n`,
    });
    try {
      const read = loadDataFiles(dir, base.connectors);
      expect(read.problems).toEqual([]);
      expect(read.collections).toEqual([
        {
          id: "resources/data.ts#leads",
          file: "resources/data.ts",
          name: "outbound",
          at: { file: "resources/data.ts", export: "leads" },
        },
      ]);
      expect(read.resources.map((r) => r.id)).toEqual(["resources/identity/github.ts#site"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are declared in resources/data.ts only, and are no resource another data file names", () => {
    const dir = project({
      "data.ts": `${DATA}export const MAX = 3;\nexport const site = github.repository({ name: "site" });\n`.replace(
        'import { collection } from "sanoma/data";',
        'import { collection } from "sanoma/data";\nimport { github } from "@sanoma-ai/connector-github/resources";',
      ),
      "identity/github.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nimport { collection } from "sanoma/data";\nimport { leads } from "../data.ts";\nexport const web = github.repository({ name: leads });\nexport const notes = collection({ name: "notes", key: "id", fields: { id: "text" } });\n`,
    });
    try {
      expect(loadDataFiles(dir, base.connectors).problems.map(problemLine)).toEqual([
        "resources/data.ts#site: resources/data.ts holds collections only, since workflows and the runtime import it: declare a connector's resources in another data file",
        "resources/identity/github.ts:4:27: github.repository: ✖ Invalid input: expected string, received object → at name",
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
    const { resources, problems } = loadDataFiles(dir, base.connectors);
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
    expect(loadDataFiles(dir, base.connectors).problems).toEqual([
      {
        file: "resources/a.ts",
        line: 3,
        column: 23,
        message: "acme.widget: name is not write-only, so it takes a value, not a secret (A_NAME)",
      },
    ]);
  });
});

describe("describeConfig's problems", () => {
  it("are data: the resources read without one are listed beside them", () => {
    const dir = project({
      "good.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const web = github.repository({ name: "web" });\n`,
      "bad.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nexport const docs = github.repository({ name: "docs", has_wiki: "yes" });\n`,
      "more.ts": `import { github } from "@sanoma-ai/connector-github/resources";\nimport { web } from "./good.ts";\nexport const main = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
    });
    try {
      const { resources, problems } = describeConfig({ ...base, root: dir });
      expect(resources.map((r) => r.id)).toEqual(["resources/good.ts#web", "resources/more.ts#main"]);
      expect(problems).toEqual([
        {
          file: "resources/bad.ts",
          line: 2,
          column: 28,
          message: expect.stringMatching(/^github\.repository: .* at has_wiki$/),
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

describe("exportSpan and problemLine", () => {
  it("find an export in a file's text, to the next statement at a line's start, and print a problem at its export", () => {
    const text = `import { github } from "x";\n\nexport const web = github.repository({\n  name: "web",\n});\n\nexport const web2 = 1;\nconst x = 2;\nexport default [web];\n`;
    expect(text.slice(...exportSpan(text, "web")!)).toBe(`export const web = github.repository({\n  name: "web",\n});`);
    expect(text.slice(...exportSpan(text, "web2")!)).toBe("export const web2 = 1;");
    expect(text.slice(...exportSpan(text, "default")!)).toBe("export default [web];");
    expect(exportSpan(text, "we")).toBeUndefined();
    expect(problemLine({ file: "resources/a.ts", export: "web", message: "m" })).toBe("resources/a.ts#web: m");
    expect(problemLine({ file: "resources/a.ts", line: 2, message: "m" })).toBe("resources/a.ts:2:1: m");
    expect(problemLine({ file: "resources/a.ts", message: "m" })).toBe("resources/a.ts: m");
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

/** A fresh project with `files` under its `resources/`, and `others` under the root; returns its directory. */
function project(files: Record<string, string>, others: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-resources-"));
  const all = {
    ...Object.fromEntries(Object.entries(files).map(([path, source]) => [`resources/${path}`, source])),
    ...others,
  };
  for (const [path, source] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}
