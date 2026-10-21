import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintResources, lintWorkflow } from "../src/lint.ts";
import { BAD_DATA_FILES } from "./bad-data-files.ts";
import { ensureBuilt } from "./build.ts";

const messages = (src: string, filename?: string) => lintWorkflow(src, filename).map((p) => p.message);

describe("lintWorkflow", () => {
  it("passes the example workflow", () => {
    const src = readFileSync(new URL("./fixtures/announce.ts", import.meta.url), "utf8");
    expect(lintWorkflow(src)).toEqual([]);
  });

  it.each(["drift", "apply", "call-workflow"])(
    "passes the built-in %s workflow, which is held to the same rules",
    (name) => {
      const path = fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url));
      expect(lintWorkflow(readFileSync(path, "utf8"), path)).toEqual([]);
    },
  );

  it("passes a policy file", () => {
    expect(
      lintWorkflow(
        `
        import { allow, approve, definePolicy } from "@sanoma-ai/workflows";
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
      import { defineWorkflow } from "@sanoma-ai/workflows";
      import { ghost } from "@sanoma-ai/connector-ghost";
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
      import { startTestWorker } from "@sanoma-ai/testing";
      import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
      import { ghostDriver } from "@sanoma-ai/connector-ghost/driver";
      import { startApp } from "@sanoma-ai/app";
      import config from "../sanoma.config.ts";
    `,
      "workflows/announce.ts",
    );
    expect(problems).toEqual([
      expect.stringMatching(/^import "@sanoma-ai\/testing" .*through ctx, so the policy sees every call/),
      expect.stringMatching(/^import "@sanoma-ai\/connector-ghost\/fake" .*through ctx, so the policy sees every call/),
      expect.stringMatching(/^import "@sanoma-ai\/connector-ghost\/driver" .*through ctx/),
      expect.stringMatching(/^import "@sanoma-ai\/app" .*approve itself/),
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

  it("allows the one file outside workflows/ and policies/ that holds the collections, resources/data.ts, by its real path", () => {
    const src = `import { outbound } from "../resources/data.ts";`;
    expect(messages(src, "/repo/workflows/next.ts")).toEqual([]);
    expect(messages(src, "/repo/policies/policy.ts")).toEqual([]);
    expect(messages(`import { outbound } from "../../resources/data.ts";`, "/repo/workflows/sub/next.ts")).toEqual([]);
    expect(
      messages(
        `import { site } from "../resources/github.ts";\nimport { x } from "../resources/area/data.ts";\nimport config from "../sanoma.config.ts";`,
        "/repo/workflows/next.ts",
      ),
    ).toEqual(
      ["../resources/github.ts", "../resources/area/data.ts", "../sanoma.config.ts"].map((spec) =>
        expect.stringMatching(
          new RegExp(
            `^import "${spec.replaceAll(".", "\\.")}" .*outside workflows/.*only resources/data\\.ts \\(the collections\\) may be imported$`,
          ),
        ),
      ),
    );
    // Without a workflows/ or policies/ tree, there is no company root to find it in.
    expect(messages(src, "/repo/src/next.ts")).toEqual([expect.stringMatching(/outside this directory/)]);
    // By real path: a link to the collections is them, and a link to another file is not.
    const root = mkdtempSync(join(tmpdir(), "sanoma-lint-"));
    const at = (path: string) => join(root, path);
    try {
      mkdirSync(at("resources"));
      writeFileSync(at("resources/data.ts"), "");
      writeFileSync(at("resources/other.ts"), "");
      symlinkSync(at("resources/data.ts"), at("resources/collections.ts"));
      symlinkSync(at("resources/other.ts"), at("resources/linked.ts"));
      const linked = (name: string) => messages(`import { x } from "../resources/${name}";`, at("workflows/next.ts"));
      expect(linked("collections.ts")).toEqual([]);
      expect(linked("linked.ts")).toEqual([expect.stringMatching(/outside workflows\//)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses the runtime's client, worker and app, which a workflow could use to approve itself", () => {
    expect(
      messages(`
        import { defineWorkflow, SanomaClient } from "@sanoma-ai/workflows";
        import { startWorker as go } from "@sanoma-ai/workflows";
        import { startApp } from "@sanoma-ai/workflows";
        export { SanomaClient as C } from "@sanoma-ai/workflows";
        import * as sanoma from "@sanoma-ai/workflows";
        export * from "@sanoma-ai/workflows";
      `),
    ).toEqual([
      expect.stringMatching(/^SanomaClient is not allowed in a workflow: .*approve its own approvals/),
      expect.stringMatching(/^startWorker is not allowed in a workflow/),
      expect.stringMatching(/^startApp is not allowed in a workflow/),
      expect.stringMatching(/^SanomaClient is not allowed in a workflow/),
      expect.stringMatching(/^import \* from "@sanoma-ai\/workflows" is not allowed/),
      expect.stringMatching(/^export \* from "@sanoma-ai\/workflows" is not allowed/),
    ]);
  });

  it("accepts sanoma as the import source, with the same names, and refuses its subpaths", () => {
    expect(
      messages(`
        import { defineWorkflow, definePolicy, allow, deny, approve, approvedFor, allowAll } from "sanoma";
        import { mayDecide, errorCode, z, type Ctx } from "sanoma";
        import { defineConfig } from "sanoma";
        import * as s from "sanoma";
        import { main } from "sanoma/dist/cli.js";
      `),
    ).toEqual([
      expect.stringMatching(/^defineConfig is not allowed in a workflow: .*types from @sanoma-ai\/workflows or sanoma/),
      expect.stringMatching(/^import \* from "sanoma" is not allowed/),
      expect.stringMatching(
        /^import "sanoma\/dist\/cli\.js" is not allowed in a workflow: `sanoma` has no entry points/,
      ),
    ]);
  });

  it("allows only the names a workflow or policy needs from @sanoma-ai/workflows, and any type", () => {
    expect(
      messages(`
        import { defineWorkflow, definePolicy, allow, deny, approve, approvedFor, allowAll } from "@sanoma-ai/workflows";
        import { mayDecide, errorCode } from "@sanoma-ai/workflows";
        import type { Ctx, PolicyCall, SanomaClient } from "@sanoma-ai/workflows";
        import { type ApprovalState } from "@sanoma-ai/workflows";
        export type { Principal } from "@sanoma-ai/workflows";
      `),
    ).toEqual([]);
  });

  it("refuses the ledger stores, which could forge the audit record, and config helpers, which read credentials", () => {
    expect(
      messages(`
        import { jsonlLedger, memoryLedger } from "@sanoma-ai/workflows";
        import { resolveDatabaseUrl, resolveConfig, defineConfig } from "@sanoma-ai/workflows";
        import whole from "@sanoma-ai/workflows";
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
        import { DriverError, errorCode } from "@sanoma-ai/workflows";
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

/** A workflow file whose `run` has `body`, for the run rules. */
const workflow = (body: string, params = "ctx, input") => `
  import { defineWorkflow, errorCode } from "@sanoma-ai/workflows";
  import { ghost } from "@sanoma-ai/connector-ghost";
  import { z } from "zod";
  const helper = (ctx: any) => ctx.ghost.post.create({ title: "h" });
  const DRAFT = "Draft the post";
  export default defineWorkflow({
    name: "x",
    trigger: "manual",
    input: z.object({ ts: z.array(z.string()), k: z.string(), skip: z.boolean(), ok: z.boolean() }),
    uses: [ghost.post.create, "all", "sleep"],
    run: async (${params}) => {
      ${body}
    },
  });
`;

const inRun = (body: string, params?: string) => messages(workflow(body, params), "workflows/x.ts");

/** The problem a name given that unnamed calls are called is. */
const defaultLike = (name: string) =>
  expect.stringMatching(new RegExp(`^"${name}" is what a call without a name is called .*name it in words`));

/** The problem two steps given one name are, and the fix it names. */
const twice = (name: string, fix: string) =>
  expect.stringMatching(
    new RegExp(
      `^two steps of this workflow are named "${name}": a name given is one step's, so a test or the graph can tell them apart; ${fix}$`,
    ),
  );

describe("lintWorkflow on run, which the worker holds to the outline", () => {
  it("passes loops, a switch with break, a try with a rethrow, ctx.all over .map, ctx.runId and ctx.now, and a return at the end", () => {
    expect(
      inRun(`
        for (const t of input.ts) await ctx.ghost.post.create({ title: t });
        switch (input.k) {
          case "a":
            await ctx.sleep({ ms: 1 });
            break;
        }
        try {
          await ctx.ghost.post.create({ title: "t" });
        } catch (err) {
          if (errorCode(err) === "run_ended") throw err;
        }
        await ctx.all(input.ts.map((t) => () => ctx.ghost.post.create({ title: t })));
        console.log(ctx.runId, await ctx.now());
        return input.ts.length;
      `),
    ).toEqual([]);
  });

  it("lets unnamed calls share their default name, and holds a name given, or an approval's title, to one step", () => {
    // Defaults may repeat: one operation in two arms, a retry in a catch, two sleeps.
    expect(
      inRun(`
        if (input.ok) await ctx.ghost.post.create({ title: "a" });
        else await ctx.ghost.post.create({ title: "b" });
        try {
          await ctx.ghost.post.create({ title: "c" });
        } catch {
          await ctx.ghost.post.create({ title: "c" });
        }
        await (ctx as any)[input.k].post.create({ title: "d" });
        await ctx.sleep({ ms: 1 });
        await ctx.sleep({ ms: 2 });
        await ctx.ghost.post.create({ title: "e" }, { name: "First" });
        await ctx.ghost.post.create({ title: "f" }, { name: DRAFT });
        await ctx.sleep({ ms: 3 }, { name: "Again" });
      `),
    ).toEqual([]);
    expect(
      inRun(`await ctx.sleep({ ms: 1 }, { name: "X" }); await ctx.ghost.post.create({ title: "a" }, { name: "X" });`),
    ).toEqual([twice("X", "rename one")]);
    expect(
      inRun(`await ctx.approval("Go?", { approver: "a" }); await ctx.approval("Go?", { approver: "b" });`),
    ).toEqual([twice("Go\\?", "give each approval a title of its own")]);
    // An approval's title is a name given, as a { name } is.
    expect(inRun(`await ctx.approval("Go?", { approver: "a" }); await ctx.sleep({ ms: 1 }, { name: "Go?" });`)).toEqual(
      [twice("Go\\?", "rename one")],
    );
    // A name given may not be what unnamed calls are called: an operation's id, or Sleep.
    expect(inRun(`await ctx.sleep({ ms: 1 }, { name: "ghost.post.create" });`)).toEqual([
      defaultLike("ghost\\.post\\.create"),
    ]);
    expect(inRun(`await ctx.ghost.post.create({ title: "a" }, { name: "Sleep" });`)).toEqual([defaultLike("Sleep")]);
    // A name the outline cannot read.
    const unread = expect.stringMatching(/^a step's name must be a string literal, or a top-level const holding one/);
    expect(inRun(`await ctx.sleep({ ms: 1 }, { name: input.k });`)).toEqual([unread]);
    expect(inRun("await ctx.sleep({ ms: 1 }, { name: `at ${input.k}` });")).toEqual([unread]);
    expect(inRun(`const opts = { name: "x" }; await ctx.sleep({ ms: 1 }, opts);`)).toEqual([unread]);
    expect(inRun(`await ctx.ghost.post.create({ title: "a" }, { name: "a", other: 1 } as never);`)).toEqual([unread]);
    expect(inRun(`await ctx.ghost.post.create({ title: "a" }, { name: "" });`)).toEqual([unread]);
  });

  it("checks only the literal defineWorkflow is called with: another object with a name and a run is not a workflow", () => {
    expect(
      messages(
        `export const jobs = [{ name: "nightly", run: (job: { enabled: boolean }) => { if (!job.enabled) return; return 1; } }];`,
        "workflows/jobs.ts",
      ),
    ).toEqual([]);
  });

  it("leaves a function without ctx calls its control flow: it computes, the graph does not draw it", () => {
    expect(
      inRun(`
        const pick = () => {
          for (const t of input.ts) {
            if (t) return t;
          }
          throw new Error("none");
        };
        const sizes = input.ts.map((t) => {
          if (!t) return 0;
          return t.length;
        });
        await ctx.sleep({ ms: pick().length + sizes.length });
      `),
    ).toEqual([]);
  });

  it("refuses ctx passed on, aliased, read for anything but runId, or destructured", () => {
    const only = expect.stringMatching(
      /^ctx is only called, directly .*or read for ctx\.runId: passed on, aliased or destructured/,
    );
    expect(inRun(`await helper(ctx);`)).toEqual([only]);
    expect(inRun(`const c = ctx; await c.ghost.post.create({ title: "a" });`)).toEqual([only]);
    expect(inRun(`const create = ctx.ghost.post.create; await create({ title: "a" });`)).toEqual([only]);
    expect(inRun(`const { ghost } = ctx; await ghost.post.create({ title: "a" });`)).toEqual([only]);
    expect(inRun(`console.log(ctx.ghost);`)).toEqual([only]);
    expect(inRun(`await ctx.ghost.post({ title: "a" }); await ctx.log("x");`)).toEqual([
      expect.stringMatching(/^ctx\.ghost\.post is not a call the graph can draw: an operation is ctx\.<vendor>/),
      expect.stringMatching(/^ctx\.log is not a call the graph can draw/),
    ]);
    // Members made before the call: the closures are not read where they are made, and the call says nothing.
    expect(inRun(`const members = input.ts.map((t) => () => ctx.sleep({ ms: t })); await ctx.all(members);`)).toEqual([
      expect.stringMatching(/^a function defined in run uses ctx, and the outline does not read it/),
      expect.stringMatching(/^ctx\.all's members must be written in the call, so the graph shows what each does/),
    ]);
    expect(inRun(`await ctx.sleep({ ms: 1 });`, "{ sleep }, input")).toEqual([
      expect.stringMatching(/^run must take ctx as its first parameter, by one name: destructured/),
    ]);
  });

  it("refuses a function defined in run that uses ctx where the outline does not read it, and ctx in a finally", () => {
    const notInOutline =
      /^a function defined in run uses ctx, and the outline does not read it: inline its calls, or pass it to ctx\.all, \.map, \.forEach or \.reduce, so the run's graph shows them$/;
    expect(inRun(`const send = async () => ctx.ghost.post.create({ title: "a" }); await send();`)).toEqual([
      expect.stringMatching(notInOutline),
    ]);
    expect(inRun(`const titles = input.ts.filter((t) => ctx.ghost.post.create({ title: t }));`)).toEqual([
      expect.stringMatching(notInOutline),
    ]);
    expect(
      inRun(`
        try {
          await ctx.sleep({ ms: 1 });
        } finally {
          await ctx.ghost.post.create({ title: "f" });
        }
      `),
    ).toEqual([expect.stringMatching(/^ctx is not allowed in a finally: the graph does not draw one/)]);
  });

  it("refuses control flow the graph cannot draw: an early return, a throw outside a catch, a break out of a loop, continue", () => {
    expect(inRun(`if (input.skip) return; await ctx.sleep({ ms: 1 });`)).toEqual([
      expect.stringMatching(
        /^`return` before the end of run is not allowed in a workflow: .*use if\/else around the rest/,
      ),
    ]);
    expect(inRun(`if (!input.ok) throw new Error("no"); await ctx.sleep({ ms: 1 });`)).toEqual([
      expect.stringMatching(/^`throw` outside a catch is not allowed in a workflow/),
    ]);
    expect(inRun(`for (const t of input.ts) { await ctx.sleep({ ms: 1 }); if (t) break; }`)).toEqual([
      expect.stringMatching(/^`break` out of a loop, or to a label, is not allowed in a workflow/),
    ]);
    expect(
      inRun(
        `outer: for (const t of input.ts) { for (const u of t) { await ctx.sleep({ ms: 1 }); if (u) break outer; } }`,
      ),
    ).toEqual([expect.stringMatching(/^`break` out of a loop, or to a label, is not allowed in a workflow/)]);
    expect(
      inRun(`work: { await ctx.sleep({ ms: 1 }); if (input.skip) break work; await ctx.sleep({ ms: 2 }); }`),
    ).toEqual([expect.stringMatching(/^`break` out of a loop, or to a label, is not allowed in a workflow/)]);
    // A finally keeps to the same rules.
    expect(inRun(`try { await ctx.sleep({ ms: 1 }); } finally { return "done"; }`)).toEqual([
      expect.stringMatching(/^`return` before the end of run is not allowed/),
    ]);
    expect(inRun(`for (const t of input.ts) { if (!t) continue; await ctx.sleep({ ms: 1 }); }`)).toEqual([
      expect.stringMatching(/^`continue` is not allowed in a workflow: .*use if\/else around the rest of it/),
    ]);
    // In a member the outline reads, the same rules.
    expect(inRun(`await ctx.all([async () => { if (input.skip) return 1; return ctx.sleep({ ms: 1 }); }]);`)).toEqual([
      expect.stringMatching(/^`return` before the end of run is not allowed/),
    ]);
  });
});

const fixture = (path: string) => fileURLToPath(new URL(`./fixtures/company/${path}`, import.meta.url));
const GOOD = ["resources/identity/github.ts", "resources/identity/rules.ts", "resources/billing/stripe.ts"];

/** The lines, columns and messages lintResources gives a data file. */
const dataFile = (src: string, filename = "/repo/resources/area/file.ts") =>
  lintResources(src, filename).map((p) => `${p.line}:${p.column} ${p.message}`);

describe("lintResources", () => {
  it.each(GOOD)("passes %s", (path) => {
    expect(lintResources(readFileSync(fixture(path), "utf8"), fixture(path))).toEqual([]);
  });

  it.each(BAD_DATA_FILES)("refuses %s at %s, saying what to write instead", (name, source, at, message) => {
    const problems = lintResources(source, `/repo/resources/bad/${name}.ts`);
    expect(problems.map((p) => `${p.line}:${p.column}`)).toEqual([at]);
    expect(problems[0]?.message).toMatch(message);
  });

  it("reads every import first, as they are hoisted", () => {
    expect(
      dataFile(`export const rule = github.branch_protection({ repository_id: site, pattern: "main" });
import { github } from "@sanoma-ai/connector-github/resources";
import { site } from "./site.ts";
`),
    ).toEqual([]);
  });

  it("refuses an import of anything but constructors and data files", () => {
    expect(
      dataFile(`import * as gh from "@sanoma-ai/connector-github/resources";
import site from "./site.ts";
import "./setup.ts";
import type { Declared } from "@sanoma-ai/workflows";
import { docs } from "./docs";
import { team } from "../../people/team.ts";
`),
    ).toEqual([
      '1:8 import * as gh is not allowed in a data file: import the names you use, `import { name } from "@sanoma-ai/connector-github/resources"`',
      '2:8 import site is not allowed in a data file: import the names you use, `import { name } from "./site.ts"`',
      '3:1 import "./setup.ts" is not allowed in a data file: it imports nothing, and a data file runs no code',
      "4:1 `import type` is not allowed in a data file: it holds values only, and the constructors type them",
      '5:22 import "./docs" is not allowed in a data file: name the data file with its `.ts` extension',
      '6:22 import "../../people/team.ts" is not allowed in a data file: it reaches outside resources/; import only other data files',
    ]);
    // Inside resources/, a sibling area is a data file like any other.
    expect(
      dataFile(`import { team } from "../people/team.ts";
export default [];
`),
    ).toEqual([]);
  });

  it("holds resources/data.ts to collections, imported from sanoma/data, and refuses them in any other data file", () => {
    const data = "/repo/resources/data.ts";
    const outbound = fileURLToPath(new URL("./fixtures/outbound/resources/data.ts", import.meta.url));
    expect(dataFile(readFileSync(outbound, "utf8"), data)).toEqual([]);
    const ONLY =
      'resources/data.ts holds collections only, since workflows and the runtime import it: `import { collection } from "sanoma/data"` and `export const <name> = collection({ name: "…", key: "…", fields: { … } })`; declare a connector\'s resources in another data file';
    // Any import but sanoma/data, a connector's constructors among them, and anything but a collection.
    expect(
      dataFile(
        `import { collection, z } from "sanoma/data";
import { github } from "@sanoma-ai/connector-github/resources";
import { secret } from "sanoma/resources";
import { team } from "./people/team.ts";
export const leads = collection({ name: "leads", key: "id", fields: { id: "text" } });
export const site = github.repository({ name: "site" });
export const odd = collection({ name: "odd", key: "id", fields: { id: leads }, extra: 1 });
export default [leads];
`,
        data,
      ),
    ).toEqual([
      '1:22 a data file imports only `collection` from "sanoma/data": `import { collection } from "sanoma/data"`',
      `2:24 import "@sanoma-ai/connector-github/resources" is not allowed in resources/data.ts: ${ONLY}`,
      `3:24 import "sanoma/resources" is not allowed in resources/data.ts: ${ONLY}`,
      `4:22 import "./people/team.ts" is not allowed in resources/data.ts: ${ONLY}`,
      expect.stringMatching(/^7:31 collection\(\) takes `\{ name, key, fields, title\? \}`, its values written out: /),
      `8:1 export default is not allowed in resources/data.ts: ${ONLY}`,
    ]);
    expect(dataFile(`export const n = 1;\n`, data)).toEqual([`1:18 export const n must be a collection: ${ONLY}`]);
    // What collection() refuses, as it says it; and the advice for an unexported const is a collection's.
    expect(
      dataFile(
        `import { collection } from "sanoma/data";
export const leads = collection({ name: "Leads", key: "id", fields: { id: "text" } });
export const deals = collection({ name: "deals", key: "won", fields: { id: "string", won: "boolean" } });
export const owners = collection({ name: "owners", key: "won", fields: { id: "text", won: "boolean" } });
const stages = ["new", "won"];
`,
        data,
      ),
    ).toEqual([
      '2:33 collection("Leads"): the name must be a lowercase letter, then letters and digits, such as "outbound"',
      '3:33 collection("deals"): the field "id" is "string"; a field is one of "text", "number", "boolean", "date", "person", { type, optional: true } or { enum: [...] }',
      '4:34 collection("owners"): the key "won" must be one of its fields, a required "text" one',
      "5:1 `const stages` is not allowed in a data file: export it as a collection, `export const stages = collection({ … })`, or write its value where it is used",
    ]);
    // Anywhere else, a collection is refused where it is imported, and resources/data.ts is no data file to import from.
    expect(
      dataFile(`import { collection } from "sanoma/data";
import { leads } from "../data.ts";
export const more = collection({ name: "more", key: "id", fields: { id: "text" } });
`),
    ).toEqual([
      '1:28 import "sanoma/data" is not allowed here: collections are declared in resources/data.ts, the one data file workflows and the runtime import; move it there',
      '2:23 import "../data.ts" is not allowed in a data file: resources/data.ts holds collections, which no resource names; import resources from other data files',
    ]);
    // Only the file directly under resources/ is the collections'.
    expect(dataFile(`import { collection } from "sanoma/data";\n`, "/repo/resources/area/data.ts")).toEqual([
      expect.stringMatching(/^1:28 import "sanoma\/data" is not allowed here/),
    ]);
  });

  it("refuses exports that are not one resource each", () => {
    expect(
      dataFile(`import { github } from "@sanoma-ai/connector-github/resources";
import { docs } from "./docs.ts";
export { docs };
export * from "./docs.ts";
export const a = github.repository({ name: "a" }), b = github.repository({ name: "b" });
export const { c } = github.repository({ name: "c" });
export const d = github?.repository({ name: "d" });
export const e = github.repository({ name: "e" }, {});
export const f = github.repository("f");
export const g = docs.repository({ name: "g" });
export const h = github.branch_protection({ repository_id: github.repository({ name: "h" }), pattern: "main" });
export const i = github.repository({ name: "i", get wiki() { return true; }, topics: [1, , 2], name: "j" });
export const k = github.repository({ name: "k", pattern: /x/, size: 1n, has_wiki: !0, team: github });
export default [a, ...docs];
`),
    ).toEqual([
      "3:1 export { … } is not allowed in a data file: export each resource where it is declared, `export const name = <vendor>.<type>({ … })`",
      "4:1 export * is not allowed in a data file: a data file holds only imports, `export const <name> = <vendor>.<type>({ … })` and `export default [ … ]`",
      "5:1 declare one resource per `export const`",
      "6:14 an `export const` names one resource: `export const name = <vendor>.<type>({ … })`",
      "7:18 export const d must be a resource constructor call, `<vendor>.<type>({ … })`, with <vendor> imported from a connector's resources entry",
      "8:18 github.repository takes one object literal: `github.repository({ … })`",
      "9:18 github.repository takes one object literal: `github.repository({ … })`",
      "10:18 docs is not a connector's resource constructors: import it from the connector's resources entry, `import { docs } from \"@sanoma-ai/connector-docs/resources\"`",
      "11:60 a resource is declared at the top of a data file: give it its own `export const` and name it here",
      "12:49 a method or accessor is not allowed in a data file: a field holds a value",
      "12:86 an empty array slot is not allowed in a data file: write null",
      "12:96 name is given twice: give each field once",
      "13:58 a regular expression is not allowed in a data file: write it as a string",
      "13:69 a bigint is not allowed in a data file: write a number, or a string",
      "13:83 `!` is not allowed in a data file: write the value out",
      "13:93 github is a connector's resource constructors, not a resource: name a declared resource",
      "14:20 export default must list this file's resources by name: `export default [a, b]`",
    ]);
  });

  it("reports a syntax error", () => {
    expect(dataFile(`export const a = github.repository({ name: "a" ;`)).toEqual([
      expect.stringMatching(/^1:\d+ syntax: /),
    ]);
  });
});

/**
 * A workflow that does everything the checks refuse, one thing per line, so each diagnostic
 * names its line. Some lines are refused by oxlint, some by lintWorkflow, some by both.
 */
const BAD = `import { SanomaClient, jsonlLedger, DriverError } from "@sanoma-ai/workflows";
import x from "@sanoma-ai/testing";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
const t = Date.now();
await fetch("https://example.com");
const r = Math.random();
const k = process.env.KEY;
import { resolveDatabaseUrl } from "@sanoma-ai/workflows";
import { ghostDriver } from "@sanoma-ai/connector-ghost/driver";
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
      [2, 'import "@sanoma-ai/testing"'],
      [3, 'import "@sanoma-ai/connector-ghost/fake"'],
      [8, "resolveDatabaseUrl"],
      [9, 'import "@sanoma-ai/connector-ghost/driver"'],
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
    // The fragment loads the data-file rule from dist/, as an installed package does.
    ensureBuilt();
    dir = mkdtempSync(join(tmpdir(), "sanoma-oxlint-"));
    write(".oxlintrc.json", JSON.stringify({ extends: [fragment] }));
    write("workflows/bad.ts", BAD);
    write("policies/bad.ts", `export const hour = new Date().getUTCHours();\n`);
    write(
      "workflows/good.ts",
      `import { defineWorkflow, errorCode } from "@sanoma-ai/workflows";
import type { Ctx, SanomaClient } from "@sanoma-ai/workflows";
import { ghost } from "@sanoma-ai/connector-ghost";
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
    write(
      "workflows/sandbox.ts",
      `import { check } from "@sanoma-ai/workflows/scenario";\nexport const checks = [check];\n`,
    );
    // The built-in workflows, as if they were the company's: oxlint finds nothing in them.
    for (const name of ["drift", "apply"]) {
      write(`workflows/${name}.ts`, readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"));
    }
    // Outside workflows/ and policies/, nothing is restricted.
    write("lib/clock.ts", `export const now = () => Date.now() + Math.random();\n`);
    for (const path of GOOD) write(path, readFileSync(fixture(path), "utf8"));
    // The collections' file: the rule finds nothing in it.
    write("resources/data.ts", readFileSync(new URL("./fixtures/outbound/resources/data.ts", import.meta.url), "utf8"));
    for (const [name, source] of BAD_DATA_FILES) write(`resources/bad/${name}.ts`, source);
    found = lint();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // oxlint runs once, over the whole project: each test reads its part.
  let found: ReturnType<typeof lint> = [];
  const lint = () => {
    const out = spawnSync(join(repo, "node_modules/.bin/oxlint"), ["-f", "json", "."], { cwd: dir, encoding: "utf8" });
    const { diagnostics } = JSON.parse(out.stdout) as {
      diagnostics: {
        filename: string;
        code: string;
        message: string;
        help?: string;
        labels: { span: { line: number; column: number } }[];
      }[];
    };
    return diagnostics.map((d) => ({
      file: d.filename,
      line: d.labels[0]?.span.line,
      column: d.labels[0]?.span.column,
      rule: d.code,
      text: `${d.message} ${d.help ?? ""}`,
    }));
  };

  it("reports the clock, randomness, the network, timers, the environment, globals and the bypass imports", () => {
    const problems = found
      .filter((d) => !d.file.startsWith("resources/"))
      .map(({ file, line, rule, text }) => ({ file, line, rule, text }))
      .toSorted((a, b) => a.file.localeCompare(b.file) || a.line! - b.line!);
    expect(problems).toEqual([
      { file: "policies/bad.ts", line: 1, rule: globals, text: expect.stringMatching(/'Date'.*ctx\.now/) },
      bad(1, imports, /'SanomaClient'.*approve its own approvals/),
      bad(1, imports, /'jsonlLedger'.*forge the ledger/),
      bad(1, imports, /'DriverError'/),
      bad(2, imports, /@sanoma-ai\/testing.*through ctx/),
      bad(3, imports, /@sanoma-ai\/connector-ghost\/fake.*through ctx/),
      bad(4, globals, /'Date'.*ctx\.now/),
      bad(5, globals, /'fetch'.*connector operation/),
      bad(6, "eslint(no-restricted-properties)", /Math\.random.*ctx\.runId/),
      bad(7, globals, /'process'.*workflow input/),
      bad(8, imports, /'resolveDatabaseUrl'.*read credentials/),
      bad(9, imports, /@sanoma-ai\/connector-ghost\/driver.*through ctx/),
      bad(10, globals, /'setTimeout'.*ctx\.sleep/),
      bad(11, globals, /'crypto'.*ctx\.runId/),
      bad(12, globals, /'globalThis'.*bypass/),
      bad(13, globals, /'WebSocket'.*connector operation/),
      bad(14, globals, /'performance'.*ctx\.now/),
      bad(16, "eslint(no-restricted-properties)", /Promise\.all\b.*one at a time.*ctx\.all\(\[\.\.\.\]\)/),
      bad(17, "eslint(no-restricted-properties)", /Promise\.allSettled.*ctx\.all/),
      // A race has no ctx.all to point at: nothing races.
      bad(18, "eslint(no-restricted-properties)", /Promise\.race.*nothing races: pick one call, or sleep/),
      bad(19, "eslint(no-restricted-properties)", /Promise\.any.*nothing races/),
      {
        file: "workflows/sandbox.ts",
        line: 1,
        rule: imports,
        text: expect.stringMatching(/@sanoma-ai\/workflows\/scenario.*through ctx/),
      },
    ]);
  });

  it("holds files under resources/ to the data-file subset, with the plugin from dist/", () => {
    const rule = "sanoma(data-file)";
    expect(
      found
        .filter((d) => d.rule === rule)
        .toSorted((a, b) => a.file.localeCompare(b.file))
        .map((d) => [d.file, `${d.line}:${d.column}`, d.rule, d.text]),
    ).toEqual(
      // A name declared twice oxlint reports itself, as a syntax error, before any rule runs.
      BAD_DATA_FILES.filter(([name]) => name !== "twice").map(([name, , at, message]) => [
        `resources/bad/${name}.ts`,
        at,
        rule,
        expect.stringMatching(message),
      ]),
    );
  });
});
