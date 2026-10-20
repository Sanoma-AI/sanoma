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
/** The fixture copy's config, loaded and resolved, as the bin does. */
const load = async (): Promise<Loaded> => {
  const loaded = await loadConfig(dir);
  return { ...loaded, resolved: resolveConfig(loaded.config) };
};
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
    });
    expect(log.slice(0, 5)).toEqual([
      "tsc",
      "wrote .oxlintrc.json",
      "oxlint workflows policies",
      "config",
      "scenarios",
    ]);
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
    const { ok, problems } = await check(await load(), { databaseUrl, log: () => {} });
    expect(ok).toBe(false);
    expect(problems).toEqual([
      // tsc: the entry does not exist.
      expect.stringMatching(
        /^resources\/shop\.ts:1:23: error TS2307: Cannot find module '@sanoma-ai\/connector-ghost\/resources'/,
      ),
      // oxlint: the unused import, and Date from @sanoma-ai/workflows's rules.
      expect.stringMatching(/^workflows\/hello\.ts:16:10: Identifier 'readFileSync' is imported but never used/),
      expect.stringMatching(
        /^workflows\/hello\.ts:17:18: Unexpected use of 'Date'\. Workflows are replayed: use `await ctx\.now\(\)`/,
      ),
      // describeConfig: the data file, then the workflow's file.
      "resources/shop.ts:2:1: ghost has no resource type post: its types are ",
      expect.stringMatching(
        /^workflows\/hello\.ts:16:30: import "node:fs" is not allowed in a workflow: import only from `sanoma`/,
      ),
    ]);
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
    expect(log).toContain("oxlint workflows policies resources sites");
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^sites\/x\/routes\/index\.ts:1:20: Unexpected use of 'process'\. A site runs in the browser/,
      ),
    );
  }, 180_000);
});
