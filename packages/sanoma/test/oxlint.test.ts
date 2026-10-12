import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, ensureBuilt, repo } from "./fixture.ts";

// The `oxlint.json` this package's build writes, extended from a fixture copy's `.oxlintrc.json`
// by its path in `node_modules`, as a company repo does.
const shipped = join(repo, "packages/sanoma/oxlint.json");

let dir = "";
let found: { file: string; line?: number; rule: string; text: string }[] = [];
beforeAll(() => {
  ensureBuilt();
  dir = copyFixture();
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify({ extends: ["./node_modules/sanoma/oxlint.json"] }));
  writeFileSync(
    join(dir, "workflows/via-sanoma.ts"),
    `import { defineWorkflow, z, defineConfig } from "sanoma";
import type { Ctx } from "sanoma";
import { main } from "sanoma/dist/cli.js";
export const all = [defineWorkflow, z, defineConfig, main, Date.now()] as [unknown, unknown, Ctx<[]>, unknown, number];
`,
  );
  mkdirSync(join(dir, "resources"));
  writeFileSync(
    join(dir, "resources/shop.ts"),
    `import { ghost } from "@sanoma/connector-ghost/resources";\nexport const p = ghost.post({ title: "X".toLowerCase() });\n`,
  );
  const oxlint = join(repo, "packages/sanoma/node_modules/.bin/oxlint");
  const out = spawnSync(oxlint, ["-f", "json", "workflows", "resources"], { cwd: dir, encoding: "utf8" });
  const { diagnostics } = JSON.parse(out.stdout) as {
    diagnostics: {
      filename: string;
      code: string;
      message: string;
      help?: string;
      labels: { span: { line: number } }[];
    }[];
  };
  found = diagnostics
    .map((d) => ({
      file: d.filename,
      line: d.labels[0]?.span.line,
      rule: d.code,
      text: `${d.message} ${d.help ?? ""}`,
    }))
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.line! - b.line!);
}, 600_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the shipped oxlint.json", () => {
  it("extends nothing, and loads its plugin from inside this package", () => {
    const config = JSON.parse(readFileSync(shipped, "utf8")) as {
      extends?: unknown;
      overrides: { jsPlugins?: string[] }[];
    };
    expect(config.extends).toBeUndefined();
    expect(config.overrides.flatMap((o) => o.jsPlugins ?? [])).toEqual(["./dist/oxlint-plugin.js"]);
  });

  it("allows the same names from sanoma as from @sanoma/workflows", () => {
    const { overrides } = JSON.parse(readFileSync(shipped, "utf8")) as {
      overrides: { rules: Record<string, [string, { paths: { name: string; allowImportNames?: string[] }[] }]> }[];
    };
    const paths = overrides.flatMap((o) => o.rules["no-restricted-imports"]?.[1].paths ?? []);
    const names = (pkg: string) => paths.find((p) => p.name === pkg)?.allowImportNames;
    expect(names("sanoma")).toEqual(names("@sanoma/workflows"));
    expect(names("sanoma")).toContain("z");
  });

  it("refuses what a workflow may not import from sanoma, the clock, and a data file outside the subset", () => {
    const imports = "eslint(no-restricted-imports)";
    expect(found).toEqual([
      {
        file: "resources/shop.ts",
        line: 2,
        rule: "sanoma(data-file)",
        text: expect.stringMatching(/^a call is not allowed in a data file/),
      },
      {
        file: "workflows/via-sanoma.ts",
        line: 1,
        rule: imports,
        text: expect.stringMatching(/'defineConfig'.*belongs in sanoma\.config\.ts/),
      },
      {
        file: "workflows/via-sanoma.ts",
        line: 3,
        rule: imports,
        text: expect.stringMatching(/sanoma\/dist\/cli\.js.*no entry points for a workflow/),
      },
      {
        file: "workflows/via-sanoma.ts",
        line: 4,
        rule: "eslint(no-restricted-globals)",
        text: expect.stringMatching(/'Date'.*ctx\.now/),
      },
    ]);
  });
});
