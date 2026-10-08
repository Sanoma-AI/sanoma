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
      import { defineWorkflow } from "@sanoma/workflows";
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
      expect.stringMatching(/^SanomaClient is not allowed in a workflow: .*approve its own approvals/),
      expect.stringMatching(/^startWorker is not allowed in a workflow/),
      expect.stringMatching(/^startApp is not allowed in a workflow/),
      expect.stringMatching(/^SanomaClient is not allowed in a workflow/),
      expect.stringMatching(/^import \* from "@sanoma\/workflows" is not allowed/),
      expect.stringMatching(/^export \* from "@sanoma\/workflows" is not allowed/),
    ]);
  });

  it("allows only the names a workflow or policy needs from @sanoma/workflows, and any type", () => {
    expect(
      messages(`
        import { defineWorkflow, definePolicy, allow, deny, approve, approvedFor, allowAll } from "@sanoma/workflows";
        import { mayDecide, errorCode } from "@sanoma/workflows";
        import type { Ctx, PolicyCall, SanomaClient } from "@sanoma/workflows";
        import { type ApprovalState } from "@sanoma/workflows";
        export type { Principal } from "@sanoma/workflows";
      `),
    ).toEqual([]);
  });

  it("refuses the ledger stores, which could forge the audit record, and config helpers, which read credentials", () => {
    expect(
      messages(`
        import { jsonlLedger, memoryLedger } from "@sanoma/workflows";
        import { resolveDatabaseUrl, resolveConfig, defineConfig } from "@sanoma/workflows";
        import whole from "@sanoma/workflows";
      `),
    ).toEqual([
      expect.stringMatching(/^jsonlLedger is not allowed in a workflow: .*forge the ledger/),
      expect.stringMatching(/^memoryLedger is not allowed/),
      expect.stringMatching(/^resolveDatabaseUrl is not allowed.*read credentials/),
      expect.stringMatching(/^resolveConfig is not allowed/),
      expect.stringMatching(/^defineConfig is not allowed/),
      expect.stringMatching(/^default is not allowed/),
    ]);
  });

  it("refuses the runtime's error classes, and instanceof against them, whose replayed copies are no instances", () => {
    expect(
      messages(`
        import { DriverError, errorCode } from "@sanoma/workflows";
        import * as errors from "./errors.ts";
        export const a = (e: unknown) => e instanceof DriverError;
        export const b = (e: unknown) => e instanceof SanomaError;
        export const c = (e: unknown) => e instanceof errors.RejectedError;
        export const d = (e: unknown) => e instanceof PolicyDeniedError;
        export const ok = (e: unknown) => e instanceof Error || errorCode(e) === "driver_failed";
      `),
    ).toEqual([
      expect.stringMatching(/^DriverError is not allowed in a workflow/),
      expect.stringMatching(/^instanceof DriverError is not allowed in a workflow: .*errorCode\(err\)/),
      expect.stringMatching(/^instanceof SanomaError is not allowed/),
      expect.stringMatching(/^instanceof RejectedError is not allowed/),
      expect.stringMatching(/^instanceof PolicyDeniedError is not allowed/),
    ]);
  });

  it("leaves the clock, randomness and the network to oxlint", () => {
    expect(messages(`export const t = Date.now() + Math.random();`)).toEqual([]);
  });
});

/**
 * A workflow that does everything the checks refuse, one thing per line, so each diagnostic
 * names its line. Some lines are refused by oxlint, some by lintWorkflow, some by both.
 */
const BAD = `import { SanomaClient, jsonlLedger, DriverError } from "@sanoma/workflows";
import x from "@sanoma/testing";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
const t = Date.now();
await fetch("https://example.com");
const r = Math.random();
const k = process.env.KEY;
import { resolveDatabaseUrl } from "@sanoma/workflows";
import { ghostDriver } from "@sanoma/connector-ghost/driver";
setTimeout(() => {}, 1);
const id = crypto.randomUUID();
const g = globalThis;
const ws = new WebSocket("wss://example.com");
const p = performance.now();
const vendor = (e: unknown) => e instanceof DriverError;
const fanned = await Promise.all([t, r]);
const settled = await Promise.allSettled([t, r]);
const raced = await Promise.race([t, r]);
const first = await Promise.any([t, r]);
export const all = [SanomaClient, jsonlLedger, x, fakeGhost, t, r, k, resolveDatabaseUrl, ghostDriver, id, g, ws, p, vendor, fanned, settled, raced, first];
`;

describe("lintWorkflow on a workflow that tries everything", () => {
  it("refuses each import and instanceof it can see, on its line", () => {
    const refused = lintWorkflow(BAD, "workflows/bad.ts").map((p) => [p.line, p.message.split(" is not allowed")[0]]);
    expect(refused).toEqual([
      [1, "SanomaClient"],
      [1, "jsonlLedger"],
      [1, "DriverError"],
      [2, 'import "@sanoma/testing"'],
      [3, 'import "@sanoma/connector-ghost/fake"'],
      [8, "resolveDatabaseUrl"],
      [9, 'import "@sanoma/connector-ghost/driver"'],
      [15, "instanceof DriverError"],
    ]);
  });
});

const globals = "eslint(no-restricted-globals)";
const imports = "eslint(no-restricted-imports)";
/** A diagnostic oxlint reports on a line of BAD. */
const bad = (line: number, rule: string, text: RegExp) => ({
  file: "workflows/bad.ts",
  line,
  rule,
  text: expect.stringMatching(text),
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
    write("workflows/bad.ts", BAD);
    write("policies/bad.ts", `export const hour = new Date().getUTCHours();\n`);
    write(
      "workflows/good.ts",
      `import { defineWorkflow, errorCode } from "@sanoma/workflows";
import type { Ctx, SanomaClient } from "@sanoma/workflows";
import { ghost } from "@sanoma/connector-ghost";
import { z } from "zod";

// Local bindings, property names and types that share a restricted name are fine.
const process = { step: 1 };
const o = { Date: 1, fetch: 2 };
type T = { crypto: string };
const n = o.Date + o.fetch + process.step + Math.floor(1.5);

export default defineWorkflow({ name: "good", input: z.object({}), uses: [ghost.post.create], run: async () => n });
export type { T };
export type Both = [Ctx<[]>, SanomaClient, typeof errorCode];
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

  it("reports the clock, randomness, the network, timers, the environment, globals and the bypass imports", () => {
    const problems = lint().toSorted((a, b) => a.file.localeCompare(b.file) || a.line! - b.line!);
    expect(problems).toEqual([
      { file: "policies/bad.ts", line: 1, rule: globals, text: expect.stringMatching(/'Date'.*ctx\.now/) },
      bad(1, imports, /'SanomaClient'.*approve its own approvals/),
      bad(1, imports, /'jsonlLedger'.*forge the ledger/),
      bad(1, imports, /'DriverError'/),
      bad(2, imports, /@sanoma\/testing.*through ctx/),
      bad(3, imports, /@sanoma\/connector-ghost\/fake.*through ctx/),
      bad(4, globals, /'Date'.*ctx\.now/),
      bad(5, globals, /'fetch'.*connector operation/),
      bad(6, "eslint(no-restricted-properties)", /Math\.random.*ctx\.runId/),
      bad(7, globals, /'process'.*workflow input/),
      bad(8, imports, /'resolveDatabaseUrl'.*read credentials/),
      bad(9, imports, /@sanoma\/connector-ghost\/driver.*through ctx/),
      bad(10, globals, /'setTimeout'.*ctx\.sleep/),
      bad(11, globals, /'crypto'.*ctx\.runId/),
      bad(12, globals, /'globalThis'.*bypass/),
      bad(13, globals, /'WebSocket'.*connector operation/),
      bad(14, globals, /'performance'.*ctx\.now/),
      bad(16, "eslint(no-restricted-properties)", /Promise\.all\b.*one at a time.*ctx\.all\(\[\.\.\.\]\)/),
      bad(17, "eslint(no-restricted-properties)", /Promise\.allSettled.*ctx\.all/),
      bad(18, "eslint(no-restricted-properties)", /Promise\.race.*ctx\.all/),
      bad(19, "eslint(no-restricted-properties)", /Promise\.any.*ctx\.all/),
    ]);
  });
});
