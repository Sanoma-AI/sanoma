import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import blueskyPkg from "../../../connectors/bluesky/package.json" with { type: "json" };
import ghostPkg from "../../../connectors/ghost/package.json" with { type: "json" };
import resendPkg from "../../../connectors/resend/package.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allow,
  allowAll,
  defineConfig,
  defineConnector,
  definePolicy,
  defineWorkflow,
  memoryLedger,
} from "../src/index.ts";
import { describeConfig, outlineWorkflow } from "../src/describe.ts";
import { VENDOR } from "../src/op.ts";
import announce from "./fixtures/announce.ts";
import { marketingFakes } from "./harness.ts";

const base = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: marketingFakes().drivers,
  policy: allowAll,
  ledger: memoryLedger(),
});

describe("describeConfig", () => {
  it("describes each workflow: its input as JSON Schema, the operations it may call, its built-ins and outline", () => {
    const wf = describeConfig(base).workflows[0]!;
    expect(wf.name).toBe("announce");
    expect(wf.title).toBe("Announce a launch");
    expect(wf.input).toMatchObject({
      type: "object",
      properties: { title: { type: "string", minLength: 1 }, launchAt: { type: "string", format: "date-time" } },
      required: ["title", "body", "launchAt"],
    });
    expect(wf.ops).toEqual([
      "ghost.post.create",
      "ghost.post.publish",
      "resend.broadcast.create",
      "resend.broadcast.send",
      "bluesky.post.create",
    ]);
    expect(wf.builtins).toEqual(["approval", "sleep"]);
    expect(wf.outline).toEqual(outlineWorkflow(announce));
    expect(wf.outline).toMatchObject({ file: expect.stringMatching(/fixtures\/announce\.ts$/) });
    expect(wf.source).toContain("defineWorkflow");
  });

  it("lists ctx.all among a workflow's built-ins", () => {
    const fan = defineWorkflow({
      name: "fan",
      trigger: "manual",
      input: z.object({}),
      uses: [bluesky.post.create, "all"],
      run: async (ctx) => ctx.all([() => ctx.bluesky.post.create({ text: "x" })]),
    });
    const wf = describeConfig({ ...base, workflows: [fan] }).workflows[0]!;
    expect(wf.builtins).toEqual(["all"]);
  });

  it("describes every operation the connectors declare, with its effect and contract, sorted by id", () => {
    const { ops } = describeConfig(base);
    expect(ops.map((o) => o.id)).toEqual([
      "bluesky.post.create",
      "ghost.post.create",
      "ghost.post.publish",
      "resend.broadcast.create",
      "resend.broadcast.send",
    ]);
    const publish = ops.find((o) => o.id === "ghost.post.publish")!;
    expect(publish).toMatchObject({
      vendor: "ghost",
      resource: "post",
      name: "publish",
      effect: "publish",
      idempotent: true,
    });
    expect(publish.input).toMatchObject({ type: "object", required: ["id"] });
    expect(publish.output).toMatchObject({
      type: "object",
      properties: { status: { enum: ["draft", "scheduled", "published", "sent"] } },
    });
  });

  it("describes an operation's input as a caller sends it and its output as parsed", () => {
    const counter = defineConnector("counter", {
      tally: {
        add: {
          effect: "write",
          input: z.object({ by: z.number().default(1) }),
          output: z.object({ total: z.number(), unit: z.string().default("items") }),
        },
      },
    });
    const drivers = [{ vendor: "counter", ops: { "tally.add": async () => ({ total: 1 }) } }];
    const { ops } = describeConfig({ ...base, workflows: [], connectors: [counter], drivers });
    const [add] = ops;
    // A default makes an input field optional to send, and an output field always there.
    expect(add?.input).not.toHaveProperty("required");
    expect(add?.output).toMatchObject({ required: ["total", "unit"] });
  });

  it("describes each vendor once, its logo as data: URLs, its package and homepage; a connector that names no vendor gets its id as title", () => {
    const counter = defineConnector("counter", {
      tally: { add: { effect: "write", input: z.object({}), output: z.object({}) } },
    });
    const drivers = [...base.drivers, { vendor: "counter", ops: { "tally.add": async () => ({}) } }];
    const { vendors } = describeConfig({ ...base, connectors: [ghost, resend, bluesky, counter], drivers });
    expect(Object.keys(vendors).toSorted()).toEqual(["bluesky", "counter", "ghost", "resend"]);
    expect(vendors.counter).toEqual({ title: "counter" });
    expect(vendors.resend).toMatchObject({
      title: "Resend",
      package: "@sanoma/connector-resend",
      homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/resend#readme",
      logo: {
        src: expect.stringMatching(/^data:image\/svg\+xml,/),
        dark: expect.stringMatching(/^data:image\/svg\+xml,/),
      },
    });
    expect(decodeURIComponent(vendors.resend!.logo!.src.slice("data:image/svg+xml,".length))).toMatch(
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*>.*<\/svg>$/,
    );
    for (const vendor of ["ghost", "bluesky"]) expect(vendors[vendor]?.logo?.src).toBeDefined();
  });

  it.each([
    { vendor: "resend", connector: resend, pkg: resendPkg },
    { vendor: "ghost", connector: ghost, pkg: ghostPkg },
    { vendor: "bluesky", connector: bluesky, pkg: blueskyPkg },
  ])("names the $vendor connector's package and homepage as its package.json does", ({ connector, pkg }) => {
    expect(connector[VENDOR].info).toMatchObject({ package: pkg.name, homepage: pkg.homepage });
  });

  it("refuses a homepage that is not an https URL", () => {
    const specs = { tally: { add: { effect: "write", input: z.object({}), output: z.object({}) } } } as const;
    for (const homepage of ["http://example.com/code", "javascript:alert(1)", "github.com/x", "https://", 42, null]) {
      expect(() => defineConnector("counter", specs, { homepage: homepage as string })).toThrow(
        'defineConnector("counter"): homepage must be an https URL',
      );
    }
    expect(() => defineConnector("counter", specs, { homepage: "https://example.com/code" })).not.toThrow();
  });

  it("refuses a logo that is not one inline <svg> element", () => {
    const specs = { tally: { add: { effect: "write", input: z.object({}), output: z.object({}) } } } as const;
    for (const svg of ["logo.svg", "https://example.com/logo.svg", "<img src=x>", "<svg></svg><script></script>"]) {
      expect(() => defineConnector("counter", specs, { logo: { svg } })).toThrow(
        'defineConnector("counter"): logo.svg must be inline SVG markup, one <svg>…</svg> element',
      );
    }
    expect(() => defineConnector("counter", specs, { logo: { svg: "<svg></svg>", dark: "x" } })).toThrow("logo.dark");
    expect(() => defineConnector("counter", specs, { logo: { svg: '<svg viewBox="0 0 1 1"></svg>' } })).not.toThrow();
    expect(() => defineConnector("counter", specs, { logo: { svg: "<svg></svg>", dark: undefined } })).not.toThrow();
  });

  it("keeps the logo it checked, whatever the caller changes later", () => {
    const specs = { tally: { add: { effect: "write", input: z.object({}), output: z.object({}) } } } as const;
    const info = { logo: { svg: "<svg></svg>" } };
    const counter = defineConnector("counter", specs, info);
    info.logo.svg = "<img src=x>";
    expect(counter[VENDOR].info?.logo).toEqual({ svg: "<svg></svg>" });
    expect(Object.isFrozen(counter[VENDOR].info?.logo)).toBe(true);
  });

  it("says whether a policy other than allowAll is configured, and its version, and names the app and version", () => {
    expect(describeConfig(base).policy).toEqual({ defined: false });
    expect(describeConfig(base).appName).toBe("sanoma");
    expect(describeConfig(base).version).toMatch(/^sanoma@[0-9a-f]{64}$/);
    const gated = defineConfig({ ...base, appName: "acme", policy: definePolicy(() => allow()) });
    expect(describeConfig(gated)).toMatchObject({
      appName: "acme",
      version: expect.stringMatching(/^acme@/),
      policy: { defined: true },
    });
    const versioned = definePolicy(() => allow(), { version: "2026-10-07" });
    expect(versioned.version).toBe("2026-10-07");
    expect(describeConfig({ ...base, policy: versioned }).policy).toEqual({ defined: true, version: "2026-10-07" });
    expect(() => definePolicy(() => allow(), { version: "" })).toThrow("`version` must be a non-empty string");
  });

  it("is plain JSON: it round-trips through JSON.stringify unchanged", () => {
    const c = describeConfig(base);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it("describes what JSON Schema cannot express as open, rather than failing", () => {
    const odd = defineConnector("odd", {
      thing: { get: { effect: "read", input: z.object({ id: z.string() }), output: z.custom<Map<string, string>>() } },
    });
    const wf = defineWorkflow({
      name: "odd",
      trigger: "manual",
      input: z.object({}),
      uses: [odd.thing.get],
      run: async () => {},
    });
    const drivers = [{ vendor: "odd", ops: { "thing.get": async () => new Map() } }];
    // `unrepresentable: "any"` keeps custom types as {}; only a schema that throws is reported.
    expect(() =>
      describeConfig(
        defineConfig({ workflows: [wf], connectors: [odd], drivers, policy: allowAll, ledger: memoryLedger() }),
      ),
    ).not.toThrow();
  });

  it("names the schema it cannot describe at all", () => {
    // zod refuses two schemas with one id in a single conversion, whatever `unrepresentable` says.
    const twice = z.object({ a: z.string().meta({ id: "twice" }), b: z.number().meta({ id: "twice" }) });
    const clash = defineConnector("clash", { thing: { get: { effect: "read", input: z.object({}), output: twice } } });
    const drivers = [{ vendor: "clash", ops: { "thing.get": async () => ({ a: "", b: 0 }) } }];
    expect(() => describeConfig({ ...base, workflows: [], connectors: [clash], drivers })).toThrow(
      /^Cannot describe clash\.thing\.get output as JSON Schema: Duplicate schema id "twice"/,
    );
  });
});
