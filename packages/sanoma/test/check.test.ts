import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { resolveConfig } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../src/check.ts";
import { type Loaded, loadConfig } from "../src/config.ts";
import { copyFixture, ensureBuilt } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) for the scenarios. The fixture copy loads the packages from their builds.
const databaseUrl = testDatabaseUrl("sanoma-check");

let dir = "";
/** A fixture copy's config, loaded and resolved, as the bin does. */
const loadIn = async (root: string): Promise<Loaded> => {
  const loaded = await loadConfig(root);
  return { ...loaded, resolved: resolveConfig(loaded.config) };
};
const load = () => loadIn(dir);
beforeAll(() => {
  ensureBuilt();
  dir = copyFixture();
}, 600_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("check", () => {
  it("reports what the lints and describeConfig find, each at its file and position, and nothing for the fixture", async () => {
    const log: string[] = [];
    expect(await check(await load(), { databaseUrl, log: (l) => log.push(l) })).toEqual({
      ok: true,
      problems: [],
      warnings: [],
      grid: expect.objectContaining({ groups: [null, "agents"] }),
    });
    // The generated SDK first, before tsc: the sites' tsc reads it.
    expect(log.slice(0, 7)).toEqual([
      "config",
      "wrote .sanoma/api.ts",
      "wrote .sanoma/schema.cedarschema",
      "tsc",
      "wrote .oxlintrc.json",
      "oxlint workflows",
      "scenarios",
    ]);
    expect(readFileSync(join(dir, ".sanoma/api.ts"), "utf8")).toContain("hello: WorkflowFn<");
    expect(readFileSync(join(dir, ".sanoma/schema.cedarschema"), "utf8")).toContain(
      'action "ghost.post.publish" in [Action::"effect:publish"]',
    );
    expect(log).toContain("passed hello/hello.feature › A post goes out");
    expect(readFileSync(join(dir, ".oxlintrc.json"), "utf8")).toBe(
      `{\n  "extends": [\n    "./node_modules/sanoma/oxlint.json"\n  ]\n}\n`,
    );

    // An import a workflow may not make (describeConfig, through lintWorkflow), the clock (oxlint,
    // with the shipped rules), and a data file naming a resource type its connector lacks (describeConfig).
    appendFileSync(
      join(dir, "workflows/hello.ts"),
      'import { readFileSync } from "node:fs";\nexport const t = Date.now();\n',
    );
    mkdirSync(join(dir, "resources"));
    writeFileSync(
      join(dir, "resources/shop.ts"),
      'import { ghost } from "@sanoma-ai/connector-ghost/resources";\nexport const p = ghost.post({ title: "x" });\n',
    );
    const again: string[] = [];
    const { ok, problems } = await check(await load(), { databaseUrl, log: (l) => again.push(l) });
    // The workflow's input is as it was: nothing to write.
    expect(again).not.toContain("wrote .sanoma/api.ts");
    expect(ok).toBe(false);
    expect(problems).toEqual([
      // tsc: the entry does not exist.
      expect.stringMatching(
        /^resources\/shop\.ts:1:23: error TS2307: Cannot find module '@sanoma-ai\/connector-ghost\/resources'/,
      ),
      // oxlint: the unused import, and Date from @sanoma-ai/workflows's rules.
      expect.stringMatching(/^workflows\/hello\.ts:16:10: Identifier 'readFileSync' is imported but never used/),
      expect.stringMatching(
        /^workflows\/hello\.ts:17:18: Workflows are replayed, so a workflow reads the clock with `await ctx\.now\(\)`/,
      ),
      // describeConfig: the data file, then the workflow's file.
      "resources/shop.ts:2:1: ghost has no resource type post: its types are ",
      expect.stringMatching(
        /^workflows\/hello\.ts:16:30: import "node:fs" is not allowed in a workflow: import only from `sanoma`/,
      ),
    ]);
  }, 180_000);

  it("passes collections in resources/data.ts, which the config lists not, and a workflow importing them", async () => {
    const own = copyFixture();
    try {
      writeFileSync(
        join(own, "sanoma.config.ts"),
        readFileSync(join(own, "sanoma.config.ts"), "utf8")
          .replace(
            'import hello from "./workflows/hello.ts";',
            'import hello from "./workflows/hello.ts";\nimport next from "./workflows/next.ts";',
          )
          .replace("workflows: [hello]", "workflows: [hello, next]"),
      );
      mkdirSync(join(own, "resources"));
      writeFileSync(
        join(own, "resources/data.ts"),
        'import { collection } from "sanoma/data";\n\nexport const leads = collection({ name: "leads", key: "id", fields: { id: "text", won: "boolean" } });\n',
      );
      writeFileSync(
        join(own, "workflows/next.ts"),
        `import { defineWorkflow, z } from "sanoma";
import { leads } from "../resources/data.ts";

export default defineWorkflow({
  name: "next",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [leads.get],
  run: async (ctx, { id }) => (await ctx.data.leads.get({ key: id }))?.record.won ?? false,
});
`,
      );
      const loaded = await loadConfig(own);
      expect(loaded.config.collections?.map((c) => c.name)).toEqual(["leads"]);
      const log: string[] = [];
      const result = await check(
        { ...loaded, resolved: resolveConfig(loaded.config) },
        { databaseUrl, log: (l) => log.push(l) },
      );
      expect(result).toEqual({ ok: true, problems: [], warnings: [], grid: expect.any(Object) });
      expect(log).toContain("oxlint workflows resources");
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  }, 180_000);

  it("decides with policies/*.cedar, and reports what is wrong with them at their place, running no scenario", async () => {
    const own = copyFixture();
    try {
      mkdirSync(join(own, "policies"));
      // A field the operation's input does not have, at its line and column.
      const cedar = join(own, "policies/publish.cedar");
      writeFileSync(
        cedar,
        '@reason("Not that post")\nforbid (principal, action == Sanoma::Action::"ghost.post.publish", resource)\nwhen { context.input.idd == "never" };\n',
      );
      const log: string[] = [];
      const bad = await check(await loadIn(own), { databaseUrl, log: (l) => log.push(l) });
      expect(bad.ok).toBe(false);
      expect(bad.problems).toEqual([
        expect.stringMatching(
          /^policies\/publish\.cedar:3:8: policies\/publish\.cedar#1: .*attribute `input\.idd` in context for Sanoma::Action::"ghost\.post\.publish" not found \(did you mean `id`\?\)$/,
        ),
      ]);
      expect(log).toContain("no scenarios: the policies do not hold");
      // No grid: every cell would be the refusing policy's deny.
      expect(bad).not.toHaveProperty("grid");

      // Valid: the scenario runs under it, and publishes.
      writeFileSync(cedar, readFileSync(cedar, "utf8").replace("input.idd", "input.id"));
      const loaded = await loadIn(own);
      const good = await check(loaded, { databaseUrl, log: () => {} });
      expect(good).toEqual({ ok: true, problems: [], warnings: [], grid: expect.any(Object) });
      // The grid under it: the publish, in the run, depends on the input.
      expect(good.grid!.workflows[0]!.ops.find((op) => op.id === "ghost.post.publish")!.cells).toEqual([
        expect.objectContaining({ answer: "depends" }),
        expect.objectContaining({ answer: "depends" }),
      ]);
      expect(loaded.resolved.policyProblems).toEqual([]);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  }, 180_000);

  it("passes a @hold for a group once resources/people.ts declares it", async () => {
    const own = copyFixture();
    try {
      mkdirSync(join(own, "policies"));
      writeFileSync(
        join(own, "policies/publish.cedar"),
        '@hold("finance")\nforbid (principal, action == Sanoma::Action::"ghost.post.publish", resource)\nwhen { context.input.id == "never" };\n',
      );
      expect((await check(await loadIn(own), { databaseUrl, log: () => {} })).problems).toEqual([
        'policies/publish.cedar:1:1: policies/publish.cedar#1: @hold("finance") names no declared group or person, nor "on-behalf-of"',
      ]);

      mkdirSync(join(own, "resources"));
      writeFileSync(
        join(own, "resources/people.ts"),
        'import { sanoma } from "sanoma/resources";\n\nexport const ada = sanoma.person({ id: "ada" });\nexport const finance = sanoma.group({ name: "finance", members: [ada] });\n',
      );
      expect(await check(await loadIn(own), { databaseUrl, log: () => {} })).toEqual({
        ok: true,
        problems: [],
        warnings: [],
        grid: expect.objectContaining({ groups: [null, "agents", "finance"] }),
      });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  }, 180_000);

  it("reports a scenario step that does not hold", async () => {
    const feature = join(dir, "scenarios/hello/hello.feature");
    writeFileSync(feature, readFileSync(feature, "utf8").replace("And the run succeeds", "And the run fails"));
    const { problems } = await check(await load(), { databaseUrl, log: () => {} });
    expect(problems).toContain("A post goes out › the run fails: the run finished");
  }, 180_000);

  it("lints sites/ when there is one", async () => {
    mkdirSync(join(dir, "sites/x/routes"), { recursive: true });
    writeFileSync(join(dir, "sites/x/routes/index.ts"), "export const key = process.env.KEY;\n");
    const log: string[] = [];
    const { problems } = await check(await load(), { databaseUrl, log: (l) => log.push(l) });
    expect(log).toContain("oxlint workflows resources sites");
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^sites\/x\/routes\/index\.ts:1:20: Unexpected use of 'process'\. A site runs in the browser/,
      ),
    );
  }, 180_000);
});
