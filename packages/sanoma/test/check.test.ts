import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../src/check.ts";
import { loadConfig } from "../src/config.ts";
import { copyFixture, ensureBuilt } from "./fixture.ts";

// Without Postgres: `scenarios: false`. The fixture copy loads the packages from their builds.
let dir = "";
beforeAll(() => {
  ensureBuilt();
  dir = copyFixture();
}, 600_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("check", () => {
  it("reports what the lints and describeConfig find, each at its file and position, and nothing for the fixture", async () => {
    const log: string[] = [];
    expect(await check(await loadConfig(dir), { scenarios: false, log: (l) => log.push(l) })).toEqual({
      ok: true,
      problems: [],
    });
    expect(log).toEqual(["tsc", "oxlint workflows policies", "config", "scenarios skipped"]);

    // An import a workflow may not make (describeConfig, through lintWorkflow), the clock (oxlint,
    // with the shipped rules), and a data file naming a resource type its connector lacks (describeConfig).
    appendFileSync(
      join(dir, "workflows/hello.ts"),
      'import { readFileSync } from "node:fs";\nexport const t = Date.now();\n',
    );
    mkdirSync(join(dir, "resources"));
    writeFileSync(
      join(dir, "resources/shop.ts"),
      'import { ghost } from "@sanoma/connector-ghost/resources";\nexport const p = ghost.post({ title: "x" });\n',
    );
    const { ok, problems } = await check(await loadConfig(dir), { scenarios: false, log: () => {} });
    expect(ok).toBe(false);
    expect(problems).toEqual([
      // tsc: the entry does not exist.
      expect.stringMatching(
        /^resources\/shop\.ts:1:23: error TS2307: Cannot find module '@sanoma\/connector-ghost\/resources'/,
      ),
      // oxlint: the unused import, and Date from @sanoma/workflows's rules.
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
  }, 120_000);
});
