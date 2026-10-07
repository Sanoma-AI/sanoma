import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintWorkflow } from "../src/lint.ts";

const messages = (src: string, filename?: string) => lintWorkflow(src, filename).map((p) => p.message);

describe("lintWorkflow", () => {
  it("passes the example workflow", () => {
    const src = readFileSync(new URL("./fixtures/announce.ts", import.meta.url), "utf8");
    expect(lintWorkflow(src)).toEqual([]);
  });

  it("passes a policy file", () => {
    expect(
      lintWorkflow(
        `
        import { allow, approve, definePolicy } from "@sanoma/workflows";
        export default definePolicy(({ effect, run }) =>
          effect === "publish" && !run.approvals.some((a) => a.approver === "lead") ? approve("lead") : allow(),
        );
      `,
        "policies/policy.ts",
      ),
    ).toEqual([]);
  });

  it("refuses imports outside the allowlist, and dynamic imports", () => {
    const problems = messages(`
      import axios from "axios";
      import { x } from "node:fs";
      import { ok } from "@sanoma/workflows";
      import { ghost } from "@sanoma/connector-ghost";
      import { z } from "zod";
      import { other } from "./other.ts";
      const m = await import("./lazy.ts");
    `);
    expect(problems).toEqual([
      expect.stringMatching(/^import "axios" is not allowed in a workflow/),
      expect.stringMatching(/^import "node:fs" is not allowed in a workflow/),
      expect.stringMatching(/dynamic import/),
    ]);
  });

  it("refuses the ways around the policy: test fakes, drivers, the app and the config", () => {
    const problems = messages(
      `
      import { fakeMarketingVendors } from "@sanoma/testing";
      import { fakeGhost } from "@sanoma/connector-ghost/fake";
      import { ghostDriver } from "@sanoma/connector-ghost/driver";
      import { startApp } from "@sanoma/app";
      import config from "../sanoma.config.ts";
    `,
      "workflows/announce.ts",
    );
    expect(problems).toEqual([
      expect.stringMatching(/^import "@sanoma\/testing" .*through ctx, so the policy sees every call/),
      expect.stringMatching(/^import "@sanoma\/connector-ghost\/fake" .*through ctx, so the policy sees every call/),
      expect.stringMatching(/^import "@sanoma\/connector-ghost\/driver" .*through ctx/),
      expect.stringMatching(/^import "@sanoma\/app" .*approve itself/),
      expect.stringMatching(/^import "\.\.\/sanoma\.config\.ts" .*outside workflows\/.*through ctx/),
    ]);
  });

  it("allows relative imports that stay inside the file's workflows/ or policies/ tree", () => {
    const src = `
      import { a } from "./shared.ts";
      import { b } from "../lib/b.ts";
      import { c } from "./sub/c.ts";
    `;
    expect(messages(src, "workflows/sub/announce.ts")).toEqual([]);
    expect(messages(src, "/repo/policies/sub/policy.ts")).toEqual([]);
    expect(messages(`import { d } from "../../d.ts";`, "/repo/workflows/sub/x.ts")).toEqual([
      expect.stringMatching(/^import "\.\.\/\.\.\/d\.ts" .*outside workflows\//),
    ]);
    // Without a workflows/ or policies/ ancestor, the file's own directory is the tree.
    expect(messages(`import { e } from "./e.ts";`, "src/flow.ts")).toEqual([]);
    expect(messages(`import { f } from "../f.ts";`, "src/flow.ts")).toEqual([
      expect.stringMatching(/^import "\.\.\/f\.ts" .*outside this directory/),
    ]);
  });

  it("refuses the runtime's client, worker and app, which a workflow could use to approve itself", () => {
    expect(
      messages(`
        import { defineWorkflow, SanomaClient } from "@sanoma/workflows";
        import { startWorker as go } from "@sanoma/workflows";
        import { startApp } from "@sanoma/workflows";
        export { SanomaClient as C } from "@sanoma/workflows";
        import * as sanoma from "@sanoma/workflows";
        export * from "@sanoma/workflows";
      `),
    ).toEqual([
      expect.stringMatching(/^SanomaClient is not allowed in a workflow: .*decide approvals.*ctx\.approval/),
      expect.stringMatching(/^startWorker is not allowed in a workflow/),
      expect.stringMatching(/^startApp is not allowed in a workflow: .*ctx\.approval/),
      expect.stringMatching(/^SanomaClient is not allowed in a workflow/),
      expect.stringMatching(/^import \* from "@sanoma\/workflows" is not allowed/),
      expect.stringMatching(/^export \* from "@sanoma\/workflows" is not allowed/),
    ]);
  });

  it("leaves the clock, randomness and the network to oxlint", () => {
    expect(messages(`export const t = Date.now() + Math.random();`)).toEqual([]);
  });
});

// The fragment consumers extend from their `.oxlintrc.json`. Its override globs resolve against
// the extending config, so the test writes one into a temp project the way a consumer would.
describe("oxlint.json", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const fragment = fileURLToPath(new URL("../oxlint.json", import.meta.url));
  let dir = "";
  const write = (path: string, src: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), src);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-oxlint-"));
    write(".oxlintrc.json", JSON.stringify({ extends: [fragment] }));
    write(
      "workflows/bad.ts",
      `import { SanomaClient } from "@sanoma/workflows";
import x from "@sanoma/testing";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
const t = Date.now();
await fetch("https://example.com");
const r = Math.random();
const k = process.env.KEY;
export const all = [SanomaClient, x, fakeGhost, t, r, k];
`,
    );
    write("policies/bad.ts", `export const hour = new Date().getUTCHours();\n`);
    write(
      "workflows/good.ts",
      `import { defineWorkflow } from "@sanoma/workflows";
import { ghost } from "@sanoma/connector-ghost";
import { z } from "zod";

// Local bindings, property names and types that share a restricted name are fine.
const process = { step: 1 };
const o = { Date: 1, fetch: 2 };
type T = { crypto: string };
const n = o.Date + o.fetch + process.step + Math.floor(1.5);

export default defineWorkflow({ name: "good", input: z.object({}), uses: [ghost.post.create], run: async () => n });
export type { T };
`,
    );
    // Outside workflows/ and policies/, nothing is restricted.
    write("lib/clock.ts", `export const now = () => Date.now() + Math.random();\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const lint = () => {
    const out = spawnSync(join(repo, "node_modules/.bin/oxlint"), ["-f", "json", "."], { cwd: dir, encoding: "utf8" });
    const { diagnostics } = JSON.parse(out.stdout) as {
      diagnostics: {
        filename: string;
        code: string;
        message: string;
        help?: string;
        labels: { span: { line: number } }[];
      }[];
    };
    return diagnostics.map((d) => ({
      file: d.filename,
      line: d.labels[0]?.span.line,
      rule: d.code,
      text: `${d.message} ${d.help ?? ""}`,
    }));
  };

  it("reports the clock, randomness, the network, the environment and the bypass imports in workflows and policies", () => {
    const problems = lint().toSorted((a, b) => a.file.localeCompare(b.file) || a.line! - b.line!);
    expect(problems).toEqual([
      {
        file: "policies/bad.ts",
        line: 1,
        rule: "eslint(no-restricted-globals)",
        text: expect.stringMatching(/'Date'.*ctx\.now/),
      },
      {
        file: "workflows/bad.ts",
        line: 1,
        rule: "eslint(no-restricted-imports)",
        text: expect.stringMatching(/'SanomaClient'.*approve itself/),
      },
      {
        file: "workflows/bad.ts",
        line: 2,
        rule: "eslint(no-restricted-imports)",
        text: expect.stringMatching(/@sanoma\/testing.*through ctx/),
      },
      {
        file: "workflows/bad.ts",
        line: 3,
        rule: "eslint(no-restricted-imports)",
        text: expect.stringMatching(/@sanoma\/connector-ghost\/fake.*through ctx/),
      },
      {
        file: "workflows/bad.ts",
        line: 4,
        rule: "eslint(no-restricted-globals)",
        text: expect.stringMatching(/'Date'.*ctx\.now/),
      },
      {
        file: "workflows/bad.ts",
        line: 5,
        rule: "eslint(no-restricted-globals)",
        text: expect.stringMatching(/'fetch'.*connector operation/),
      },
      {
        file: "workflows/bad.ts",
        line: 6,
        rule: "eslint(no-restricted-properties)",
        text: expect.stringMatching(/Math\.random.*ctx\.runId/),
      },
      {
        file: "workflows/bad.ts",
        line: 7,
        rule: "eslint(no-restricted-globals)",
        text: expect.stringMatching(/'process'.*workflow input/),
      },
    ]);
  });
});
