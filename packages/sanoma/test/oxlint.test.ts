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
    `import { ghost } from "@sanoma-ai/connector-ghost/resources";\nexport const p = ghost.post({ title: "X".toLowerCase() });\n`,
  );
  // A site: what it may import (types from anywhere among them), then one problem per line from line 7 on.
  mkdirSync(join(dir, "sites/x/routes"), { recursive: true });
  mkdirSync(join(dir, "sites/x/components"));
  writeFileSync(join(dir, "sites/x/components/card.tsx"), "export const Card = 1;\n");
  writeFileSync(
    join(dir, "sites/x/routes/index.tsx"),
    `import { createFileRoute } from "sanoma/site";
import { Button } from "@sanoma-ai/app/ui";
import { useState } from "react";
import { Card } from "../components/card";
import type { Ctx } from "sanoma";
import type { hello as Hello } from "../../../workflows/hello";
import { Client } from "pg";
import { ghost } from "@sanoma-ai/connector-ghost";
import { createIsomorphicFn } from "@tanstack/react-start";
import { serverOnly } from "@tanstack/react-start/server";
import { defineWorkflow } from "sanoma";
import { main } from "sanoma/dist/cli.js";
import { startApp } from "@sanoma-ai/app";
import { startWorker } from "@sanoma-ai/workflows";
import { fake } from "@sanoma-ai/testing";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { readFileSync } from "node:fs";
import { hello } from "../../../workflows/hello";
import { handler } from "@sanoma-ai/app/server";
export const all = [createFileRoute, Button, useState, Card, Client, ghost, createIsomorphicFn, serverOnly, defineWorkflow, main, startApp, startWorker, fake, DBOS, readFileSync, hello, handler, process.env.KEY];
export const pg = require("pg");
export type Types = [Ctx<[]>, typeof Hello];
`,
  );
  writeFileSync(join(dir, "sites/x/routes/a.server.ts"), "export const a = 1;\n");
  writeFileSync(
    join(dir, "sites/x/routes/fn.ts"),
    `import { createFileRoute } from "sanoma/site";
export const f = createServerFn({ method: "GET" });
export const Route = createFileRoute("/fn")({ server: { handlers: {} } });
`,
  );
  // The build's listing, which the site rules do not read.
  writeFileSync(join(dir, "sites/__virtual.ts"), "export const key = process.env.KEY;\n");
  const oxlint = join(repo, "packages/sanoma/node_modules/.bin/oxlint");
  const out = spawnSync(oxlint, ["-f", "json", "workflows", "resources", "sites"], { cwd: dir, encoding: "utf8" });
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
    expect(new Set(config.overrides.flatMap((o) => o.jsPlugins ?? []))).toEqual(new Set(["./dist/oxlint-plugin.js"]));
  });

  it("allows the same names from sanoma as from @sanoma-ai/workflows", () => {
    const { overrides } = JSON.parse(readFileSync(shipped, "utf8")) as {
      overrides: { rules: Record<string, [string, { paths: { name: string; allowImportNames?: string[] }[] }]> }[];
    };
    const paths = overrides.flatMap((o) => o.rules["no-restricted-imports"]?.[1].paths ?? []);
    const names = (pkg: string) => paths.find((p) => p.name === pkg)?.allowImportNames;
    expect(names("sanoma")).toEqual(names("@sanoma-ai/workflows"));
    expect(names("sanoma")).toContain("z");
  });

  it("refuses what a workflow may not import from sanoma, the clock, and a data file outside the subset", () => {
    const imports = "eslint(no-restricted-imports)";
    expect(found.filter((f) => !f.file.startsWith("sites/"))).toEqual([
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
        rule: "sanoma(date)",
        text: expect.stringMatching(/`await ctx\.now\(\)` for the time, `new Date\(await ctx\.now\(\)\)` for a date/),
      },
    ]);
  });

  it("refuses a site's server code, one problem each, and passes what a site may import and the build's listing", () => {
    const imports = "eslint(no-restricted-imports)";
    const site = "sanoma(site-file)";
    const globals = "eslint(no-restricted-globals)";
    const index = "sites/x/routes/index.tsx";
    const server = /A site has no server code: call an operation or start a workflow through `api` from `sanoma\/site`/;
    expect(found.filter((f) => f.file.startsWith("sites/"))).toEqual([
      {
        file: "sites/x/routes/a.server.ts",
        line: 1,
        rule: site,
        text: expect.stringMatching(/no \*\.server\.\* file/),
      },
      { file: "sites/x/routes/fn.ts", line: 2, rule: site, text: expect.stringMatching(/no createServerFn/) },
      {
        file: "sites/x/routes/fn.ts",
        line: 3,
        rule: site,
        text: expect.stringMatching(/route has no `server` handlers/),
      },
      { file: index, line: 7, rule: imports, text: expect.stringMatching(/^'pg'.*/) },
      {
        file: index,
        line: 8,
        rule: imports,
        text: expect.stringMatching(/'@sanoma-ai\/connector-ghost'.*calls no vendor/),
      },
      {
        file: index,
        line: 9,
        rule: imports,
        text: expect.stringMatching(/^'@tanstack\/react-start' .*come from `sanoma\/site`/),
      },
      { file: index, line: 10, rule: imports, text: expect.stringMatching(server) },
      { file: index, line: 11, rule: imports, text: expect.stringMatching(/^'sanoma' /) },
      { file: index, line: 12, rule: imports, text: expect.stringMatching(/^'sanoma\/dist\/cli\.js'/) },
      { file: index, line: 13, rule: imports, text: expect.stringMatching(/`@sanoma-ai\/app\/ui`/) },
      { file: index, line: 14, rule: imports, text: expect.stringMatching(server) },
      { file: index, line: 15, rule: imports, text: expect.stringMatching(/belong in tests/) },
      { file: index, line: 16, rule: imports, text: expect.stringMatching(/^'@dbos-inc\/dbos-sdk'/) },
      { file: index, line: 17, rule: imports, text: expect.stringMatching(/^'node:fs'.*runs in the browser/) },
      {
        file: index,
        line: 18,
        rule: site,
        text: expect.stringMatching(/\.\.\/\.\.\/\.\.\/workflows\/hello leaves sites\//),
      },
      {
        file: index,
        line: 19,
        rule: imports,
        text: expect.stringMatching(/^'@sanoma-ai\/app\/server'.*`@sanoma-ai\/app\/ui`/),
      },
      { file: index, line: 20, rule: globals, text: expect.stringMatching(/'process'.*no credentials/) },
      { file: index, line: 21, rule: globals, text: expect.stringMatching(/'require'.*imports with `import`/) },
    ]);
  });
});
