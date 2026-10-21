import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, generateApi, writeApi } from "../src/describe.ts";
import { defineConnector, defineWorkflow } from "../src/index.ts";
import outbound from "./fixtures/outbound/sanoma.config.ts";
import { tree } from "./tree.ts";

// The generated SDK, `.sanoma/api.ts`, on the outbound fixture with a vendor beside it, and
// type-checked as a site's tsconfig would.

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const shared = fileURLToPath(new URL("../src/shared.ts", import.meta.url));
const tscBin = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

const acme = defineConnector("acme", {
  customer: {
    get: {
      effect: "read",
      description: "A customer, by id.",
      input: z.object({
        id: z.string().describe("The customer's id."),
        include: z.array(z.enum(["orders", "invoices"])).optional(),
      }),
      output: z.object({ id: z.string() }),
    },
    rename: { effect: "write", input: z.object({ id: z.string(), name: z.string() }), output: z.object({}) },
  },
});

/** A workflow whose input has every kind a start form draws, and one it does not. */
const plan = defineWorkflow({
  name: "plan-launch",
  title: "Plan a launch",
  trigger: "manual",
  input: z.object({
    title: z.string().describe("What the launch is called."),
    at: z.iso.datetime(),
    channel: z.enum(["email", "social"]),
    budget: z.number().int().optional(),
    owner: z.object({ name: z.string(), email: z.string().optional() }),
    steps: z.array(z.object({ say: z.string(), done: z.boolean().default(false) })),
    extra: z.union([z.string(), z.number()]),
    note: z.string().nullable(),
    pairs: z.array(z.union([z.object({ a: z.string() }), z.literal("none")])),
    other: z.custom<Map<string, string>>(),
  }),
  uses: [],
  run: async () => {},
});

/** `plan` as if defined with this name: defineWorkflow takes no `planIt`. */
const named = (name: string) => ({ ...plan, name }) as typeof plan;

const config = { ...outbound, connectors: [acme], workflows: [...outbound.workflows, plan] };

describe("generateApi", () => {
  it("types each workflow, each direct operation and each collection, with their JSDoc", async () => {
    const { source, problems } = generateApi(describeConfig(config));
    expect(problems).toEqual([]);
    await expect(source).toMatchFileSnapshot("./fixtures/outbound/api.ts.snap");
    // A vendor's write is never called directly.
    expect(source).not.toContain("rename");
  });

  it("is deterministic: the same description gives the same text", () => {
    expect(generateApi(describeConfig(config)).source).toBe(generateApi(describeConfig(config)).source);
  });

  it("leaves out a workflow whose api name another has, with describeConfig's problem", () => {
    const { source, problems } = generateApi(
      describeConfig({ ...config, workflows: [named("plan-it"), named("planIt"), named("acme")] }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/sdk\.test\.ts:1:1: A site calls this workflow api\.acme, which is the vendor acme's/),
      expect.stringMatching(/sdk\.test\.ts:1:1: A site calls this workflow api\.planIt, as workflow "planIt" is/),
      expect.stringMatching(/sdk\.test\.ts:1:1: A site calls this workflow api\.planIt, as workflow "plan-it" is/),
    ]);
    expect(source).not.toMatch(/^ {2}(planIt|acme): WorkflowFn/m);
  });
});

describe("writeApi", () => {
  it("writes .sanoma/api.ts when its text changes, and a site type-checks against it", async () => {
    const root = tree("company", {
      "package.json": JSON.stringify({ type: "module" }),
      // `sanoma/site` in miniature: `Register`, and `api` typed by it, as the app's site.ts has them.
      "site.ts": `export type { CollectionApi, OpFn, Saved, WorkflowFn } from ${JSON.stringify(shared)};
export interface Register {}
export type Api = Register extends { api: infer A } ? A : never;
export declare const api: Api;
`,
      "caller.ts": `import { api, type Saved } from "sanoma/site";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Outbound = {
  company: string;
  contact: string;
  stage: "researched" | "contacted" | "replied" | "meeting" | "won" | "lost";
  owner: string;
  lastTouched?: string;
  seats?: number;
};

export async function page() {
  await api.outboundNext.start({ company: "x" });
  const leads = await api.data.outbound.list({ order: "-lastTouched" });
  const exact: Equal<typeof leads, Saved<Outbound>[]> = true;
  await api.acme.customer.get({ id: "c1", include: ["orders"] });
  await api.planLaunch({
    title: "Launch",
    at: "2026-10-20T09:00:00Z",
    channel: "email",
    owner: { name: "Ada" },
    steps: [{ say: "hello" }],
    extra: 1,
    note: null,
    pairs: [{ a: "x" }, "none"],
    other: new Map(),
  });
  // @ts-expect-error: no such workflow, operation or collection
  await api.nope();
  // @ts-expect-error: a company is text
  await api.outboundNext.start({ company: 1 });
  // @ts-expect-error: not a stage
  await api.data.outbound.save({ record: { company: "x", contact: "y", stage: "lunch", owner: "ada" } });
  // @ts-expect-error: a vendor's write is not called directly
  await api.acme.customer.rename({ id: "c1", name: "Acme" });
  return exact;
}
`,
      "tsconfig.json": JSON.stringify({
        extends: join(repo, "tsconfig.json"),
        compilerOptions: { paths: { "sanoma/site": ["./site.ts"] } },
        include: ["caller.ts", ".sanoma/api.ts"],
        exclude: [],
      }),
    });
    const description = describeConfig(config);
    const file = join(root, ".sanoma", "api.ts");
    expect(await writeApi(root, description)).toEqual({ wrote: true, file });
    expect(readFileSync(file, "utf8")).toBe(generateApi(description).source);
    const mtime = statSync(file).mtimeMs;
    expect(await writeApi(root, description)).toEqual({ wrote: false, file });
    expect(statSync(file).mtimeMs).toBe(mtime);

    const tsc = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(tsc.stdout).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);
});
