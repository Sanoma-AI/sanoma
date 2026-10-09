import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { github } from "@sanoma/connector-github";
import { stripe } from "@sanoma/connector-stripe";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, readResources } from "../src/describe.ts";
import {
  allowAll,
  defineConfig,
  defineConnector,
  defineResource,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
} from "../src/index.ts";

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

const fixtures = fileURLToPath(new URL("./fixtures/resources/", import.meta.url));

describe("readResources", () => {
  const config = defineConfig({ ...base, resources: "fixtures/resources" });

  it("reads each declared resource from the data files, without running them", () => {
    const resources = readResources(config);
    expect(resources.map((r) => [r.id, r.vendor, r.type, r.name])).toEqual([
      ["billing/stripe.ts#pro", "stripe", "product", "prod_SanomaFixturePro"],
      ["billing/stripe.ts#events", "stripe", "webhook_endpoint", "we_SanomaFixtureEvents"],
      ["identity/github.ts#website", "github", "repository", "website"],
      ["identity/github.ts#docs", "github", "repository", "docs"],
      ["identity/github.ts#websiteMain", "github", "branch_protection", "website:main"],
      ["identity/rules.ts#docsMain", "github", "branch_protection", "docs:main"],
    ]);
    const website = resources.find((r) => r.id === "identity/github.ts#website")!;
    expect(website).toEqual({
      id: "identity/github.ts#website",
      vendor: "github",
      type: "repository",
      name: "website",
      file: "identity/github.ts",
      span: { start: expect.any(Number), end: expect.any(Number) },
      line: 5,
      desired: {
        name: "website",
        description: "The company website",
        visibility: "public",
        has_wiki: false,
        topics: ["website", "astro"],
      },
    });
    const source = readFileSync(join(fixtures, "identity/github.ts"), "utf8");
    expect(source.slice(website.span.start, website.span.end)).toMatch(/^export const website = [\s\S]*\}\);$/);
    // A template literal without `${}` is a string.
    expect(resources.find((r) => r.id === "identity/github.ts#docs")?.desired.description).toBe(
      "Product documentation",
    );
  });

  it("keeps a reference as the id of the resource it names, and checks it as that resource's name", () => {
    const byId = new Map(readResources(config).map((r) => [r.id, r]));
    expect(byId.get("identity/github.ts#websiteMain")?.desired).toEqual({
      repository_id: { ref: "identity/github.ts#website" },
      pattern: "main",
      enforce_admins: true,
      required_pull_request_reviews: [{ required_approving_review_count: 1, dismiss_stale_reviews: true }],
    });
    // Across files: the import is the reference.
    expect(byId.get("identity/rules.ts#docsMain")).toMatchObject({
      name: "docs:main",
      desired: { repository_id: { ref: "identity/github.ts#docs" } },
    });
  });

  it("is what describeConfig lists as the config's resources", () => {
    const { resources } = describeConfig(config);
    expect(resources).toEqual(readResources(config));
    expect(JSON.parse(JSON.stringify(resources))).toEqual(resources);
  });

  describe("refuses", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Writes data files under a fresh `resources/` and reads them; returns the error's lines. */
    const problems = (files: Record<string, string>): string[] => {
      dir = mkdtempSync(join(tmpdir(), "sanoma-resources-"));
      for (const [path, source] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, "resources", path)), { recursive: true });
        writeFileSync(join(dir, "resources", path), source);
      }
      try {
        readResources({ ...base, file: join(dir, "sanoma.config.ts") });
      } catch (e) {
        const [head, ...lines] = (e as Error).message.split("\n");
        expect(head).toBe("The resources' data files have problems:");
        return lines.map((line) => line.trim().replace(/^.*?resources\//, ""));
      }
      throw new Error("read without problems");
    };
    const GH = `import { github } from "@sanoma/connector-github/resources";\n`;

    it("every construct outside the data-file subset, at file:line:column", () => {
      const bad = fileURLToPath(new URL("./fixtures/bad-resources/", import.meta.url));
      const err = (() => {
        try {
          readResources({ ...base, resources: bad });
        } catch (e) {
          return (e as Error).message;
        }
      })();
      for (const [file, at, what] of [
        ["assertion.ts", "3:65", "a type assertion"],
        ["call.ts", "3:46", "a call"],
        ["computed.ts", "3:41", "a computed key"],
        ["default.ts", "5:16", "export default must list"],
        ["function.ts", "3:1", "a function declaration"],
        ["import.ts", "1:19", 'import "zod"'],
        ["let.ts", "3:1", "`export let`"],
        ["member.ts", "4:66", "member access"],
        ["new.ts", "3:61", "`new`"],
        ["not-constructor.ts", "3:20", "export const web must be a resource constructor call"],
        ["outside.ts", "2:25", 'import "../resources/identity/github.ts"'],
        ["process.ts", "3:66", "process is not allowed"],
        ["spread.ts", "4:53", "a spread"],
        ["template.ts", "3:46", "a template with `${…}`"],
        ["undefined.ts", "3:66", "undefined is not allowed"],
        ["unexported.ts", "3:1", "`const name`"],
      ]) {
        expect(err).toContain(`bad-resources/${file}:${at}: ${what}`);
      }
    });

    it("a connector the config does not have, or its constructors under another name", () => {
      expect(
        problems({
          "a.ts": `import { ghost } from "@sanoma/connector-ghost/resources";\nexport const p = ghost.post({ title: "x" });\n`,
          "b.ts": `import { gh } from "@sanoma/connector-github/resources";\nexport const r = gh.repository({ name: "x" });\n`,
        }),
      ).toEqual([
        'a.ts:1:10: "@sanoma/connector-ghost/resources" is not the resources entry of a connector in the config\'s `connectors`: add the connector',
        'b.ts:1:10: "@sanoma/connector-github/resources" exports its constructors as github: `import { github } from "@sanoma/connector-github/resources"`',
      ]);
    });

    it("a resource type the connector does not declare", () => {
      expect(problems({ "a.ts": `${GH}export const r = github.repo({ name: "x" });\n` })).toEqual([
        "a.ts:2:1: github has no resource type repo: its types are repository, branch_protection, team_membership",
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
        "a.ts:2:1: export const a: github.repository: no field wiki",
        "a.ts:3:1: export const b: github.repository: leave out html_url: the vendor sets it",
        "a.ts:4:1: export const c: github.repository: ✖ Invalid input: expected boolean, received string → at has_wiki",
        "b.ts:2:1: export const p: stripe.product: its id is missing",
      ]);
    });

    it("a reference to a resource no data file declares, or to a file outside the directories", () => {
      expect(
        problems({
          "a.ts": `${GH}import { site } from "./b.ts";\nimport { x } from "./c.ts";\nexport const m = github.branch_protection({ repository_id: site, pattern: "main" });\nexport const n = github.branch_protection({ repository_id: x, pattern: "main" });\n`,
          "b.ts": `${GH}export const web = github.repository({ name: "web" });\n`,
        }),
      ).toEqual([
        "a.ts:2:10: site is not a resource b.ts declares",
        'a.ts:3:10: "./c.ts" is not a data file in the config\'s `resources` directories',
      ]);
    });

    it("nothing more where a reference names a resource whose value is refused", () => {
      expect(
        problems({
          "a.ts": `${GH}import { web } from "./b.ts";\nexport const m = github.branch_protection({ repository_id: web, pattern: "main" });\n`,
          "b.ts": `${GH}export const web = github.repository({ name: process.env.NAME });\n`,
        }),
      ).toEqual([expect.stringMatching(/^b\.ts:2:46: process is not allowed in a data file/)]);
    });

    it("a reference cycle", () => {
      expect(
        problems({
          "a.ts": `${GH}import { b } from "./b.ts";\nexport const a = github.branch_protection({ repository_id: b, pattern: "main" });\n`,
          "b.ts": `${GH}import { a } from "./a.ts";\nexport const b = github.branch_protection({ repository_id: a, pattern: "main" });\n`,
        }),
      ).toEqual(["a.ts:3:1: a.ts#a refers to itself: a.ts#a → b.ts#b → a.ts#a"]);
    });

    it("two resources of one type with one name", () => {
      expect(
        problems({
          "a.ts": `${GH}export const site = github.repository({ name: "web" });\n`,
          "b/c.ts": `${GH}export const web = github.repository({ name: "web", has_wiki: false });\n`,
        }),
      ).toEqual([
        'b/c.ts:2:1: github.repository "web" is declared twice, also as a.ts#site: declare each resource once, and import it where it is used',
      ]);
    });

    it("a syntax error", () => {
      expect(problems({ "a.ts": `${GH}export const r = github.repository({ name: "x" ;\n` })).toEqual([
        expect.stringMatching(/^a\.ts:2:\d+: syntax: /),
      ]);
    });
  });

  it("finds a connector by its package, and never imports a data file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-resources-"));
    try {
      mkdirSync(join(dir, "resources"));
      // The package does not exist: importing the file would fail.
      writeFileSync(
        join(dir, "resources", "widgets.ts"),
        `import { acme } from "@acme/sanoma-connector/resources";\nexport const big = acme.widget({ name: "big", size: -2 });\nexport default [big];\n`,
      );
      // Neither tests nor declarations are data files.
      writeFileSync(join(dir, "resources", "widgets.test.ts"), `throw new Error("not a data file");\n`);
      writeFileSync(join(dir, "resources", "types.d.ts"), `declare const x: number;\n`);
      expect(readResources({ ...base, file: join(dir, "sanoma.config.ts") })).toEqual([
        expect.objectContaining({
          id: "widgets.ts#big",
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

describe("resolveConfig's resources", () => {
  it("are `resources` beside the config's file by default, when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-resources-"));
    try {
      const file = join(dir, "sanoma.config.ts");
      expect(resolveConfig({ ...base, file }).resources).toEqual([]);
      mkdirSync(join(dir, "resources"));
      expect(resolveConfig({ ...base, file }).resources).toEqual([join(dir, "resources")]);
      expect(() => resolveConfig({ ...base, file, resources: ["resources", "data"] })).toThrow(
        /`resources` names data, which is not a directory/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are relative to the file defineConfig was called from", () => {
    const config = defineConfig({ ...base, resources: ["fixtures/resources", "./fixtures/resources/"] });
    expect(config.file).toBe(fileURLToPath(import.meta.url));
    expect(resolveConfig(config).resources).toEqual([join(fixtures, ".")]);
  });
});
