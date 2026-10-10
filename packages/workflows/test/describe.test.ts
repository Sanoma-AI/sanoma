import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import blueskyPkg from "../../../connectors/bluesky/package.json" with { type: "json" };
import ghostPkg from "../../../connectors/ghost/package.json" with { type: "json" };
import resendPkg from "../../../connectors/resend/package.json" with { type: "json" };
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allow,
  allowAll,
  defineConfig,
  defineConnector,
  definePolicy,
  defineResource,
  defineWorkflow,
  DriverError,
  memoryLedger,
} from "../src/index.ts";
import { describeConfig, outlineWorkflow } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
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
  it("describes each workflow: its input as JSON Schema, the operations it may call, its built-ins and outline", async () => {
    const wf = (await describeConfig(base)).workflows[0]!;
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

  it("lists ctx.all among a workflow's built-ins", async () => {
    const fan = defineWorkflow({
      name: "fan",
      trigger: "manual",
      input: z.object({}),
      uses: [bluesky.post.create, "all"],
      run: async (ctx) => ctx.all([() => ctx.bluesky.post.create({ text: "x" })]),
    });
    const wf = (await describeConfig({ ...base, workflows: [fan] })).workflows[0]!;
    expect(wf.builtins).toEqual(["all"]);
  });

  it("describes every operation the connectors declare, with its effect and contract, sorted by id", async () => {
    const { ops } = await describeConfig(base);
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
    // How a scenario's steps name it; an operation without phrases has none.
    expect(publish.phrases).toHaveProperty("expect", "post {id} is published");
    expect(ops.find((o) => o.id === "resend.broadcast.create")).not.toHaveProperty("phrases");
    expect(publish.output).toMatchObject({
      type: "object",
      properties: { status: { enum: ["draft", "scheduled", "published", "sent"] } },
    });
  });

  it("samples each operation of a vendor with a fake: made-up input, in declared order, earlier outputs carried", async () => {
    const { ops } = await describeConfig({ ...base, fakes: [fakeGhost(), fakeResend(), fakeBluesky()] });
    const mock = (id: string) => ops.find((o) => o.id === id)?.mock;
    expect(mock("ghost.post.create")).toMatchObject({ input: { status: "draft" }, output: { id: "post_0001" } });
    // publish runs after create on the same fresh fake, and publishes the post create made.
    expect(mock("ghost.post.publish")).toEqual({
      input: { id: "post_0001" },
      output: expect.objectContaining({ id: "post_0001", status: "published" }),
    });
    expect(mock("resend.broadcast.send")).toEqual({
      input: { id: "bc_0001" },
      output: { id: "bc_0001", status: "queued" },
    });
    expect(mock("bluesky.post.create")).toMatchObject({ output: { uri: expect.stringMatching(/^at:\/\//) } });
    // A vendor without a fake in `fakes` has no samples.
    expect((await describeConfig(base)).ops.every((o) => !("mock" in o))).toBe(true);
  });

  it("gives the same samples on every call, and leaves the configured fake's state, calls and file alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-describe-"));
    const file = join(dir, "ghost.json");
    try {
      const blog = fakeGhost({ file });
      blog.update((state) => {
        state.seq = 7;
      });
      const before = readFileSync(file, "utf8");
      const config = { ...base, fakes: [blog, fakeResend()] };
      // The fake stamps a publish with the time.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-01T09:00:00Z") });
      const first = (await describeConfig(config)).ops.map((o) => o.mock);
      const second = (await describeConfig(config)).ops.map((o) => o.mock);
      expect(second).toEqual(first);
      expect(first.filter(Boolean)).toHaveLength(4);
      expect(blog.calls).toEqual([]);
      expect(blog.state.seq).toBe(7);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says what a fake threw as the sample's error", async () => {
    const blog = fakeGhost();
    const fresh = blog.fresh;
    blog.fresh = () => {
      const copy = fresh();
      copy.failNext("ghost.post.create", new DriverError("ghost: down", { retryable: false }));
      return copy;
    };
    const { ops } = await describeConfig({ ...base, fakes: [blog] });
    const mock = (id: string) => ops.find((o) => o.id === id)?.mock;
    expect(mock("ghost.post.create")).toEqual({
      input: expect.objectContaining({ status: "draft" }),
      error: "ghost: down",
    });
    // With no post made, publish gets a made-up id, which the fake has no post for.
    expect(mock("ghost.post.publish")).toEqual({
      input: { id: expect.any(String) },
      error: expect.stringMatching(/^ghost: no post /),
    });
  });

  it("parses a sample's reply, and mocks a reply off the contract, one JSON cannot carry, or an operation the fake lacks as an error", async () => {
    const shop = defineConnector("shop", {
      item: {
        create: { effect: "write", input: z.object({}), output: z.object({ id: z.number() }) },
        get: {
          effect: "read",
          input: z.object({ id: z.string() }),
          output: z.object({ id: z.string(), unit: z.string().default("items") }),
        },
        bad: { effect: "read", input: z.object({}), output: z.object({ id: z.string() }) },
        count: { effect: "read", input: z.object({}), output: z.object({ n: z.bigint() }) },
      },
    });
    // The same vendor's other connector, which the fake is not for.
    const stock = defineConnector("shop", {
      stock: { take: { effect: "write", input: z.object({}), output: z.object({}) } },
    });
    const fake = defineFake(shop, {
      initial: () => ({}),
      ops: () => ({
        item: {
          create: async () => ({ id: 7 }),
          get: async ({ id }) => ({ id }) as never,
          bad: async () => ({ id: 1 }) as never,
          count: async () => ({ n: 3n }),
        },
      }),
    });
    const drivers = [fake.driver, { vendor: "shop", ops: { "stock.take": async () => ({}) } }];
    const { ops } = await describeConfig({ ...base, workflows: [], connectors: [shop, stock], drivers, fakes: [fake] });
    const mock = (id: string) => ops.find((o) => o.id === id)?.mock;
    // Parsed: the default filled in. The earlier `id`, a number, is no string: get makes up its own.
    expect(mock("shop.item.get")).toEqual({
      input: { id: expect.any(String) },
      output: { id: expect.any(String), unit: "items" },
    });
    expect(mock("shop.item.bad")).toEqual({
      input: {},
      error: expect.stringMatching(/^shop\.item\.bad's fake answered off its contract: id: /),
    });
    expect(mock("shop.item.count")).toEqual({
      input: {},
      error: expect.stringMatching(/^The reply is not plain JSON: /),
    });
    expect(mock("shop.stock.take")).toEqual({ input: null, error: "The shop fake does not implement shop.stock.take" });
  });

  it("samples workflow operations only: a resource type's read and import get no mock, even with a fake", async () => {
    const repo = defineResource({
      vendor: "forge",
      type: "repo",
      title: "Repo",
      identity: "name",
      schema: z.object({ name: z.string() }),
      fields: { immutable: [], vendorOwned: [], writeOnly: [] },
      find: ({ name }) => name,
    });
    const forge = defineConnector(
      "forge",
      { repo, issue: { open: { effect: "write", input: z.object({}), output: z.object({ id: z.string() }) } } },
      { package: "@forge/sanoma-connector" },
    );
    // The same vendor in a second connector, with a plain group named as the resource type.
    const forgeMore = defineConnector("forge", {
      repo: { archive: { effect: "write", input: z.object({}), output: z.object({}) } },
    });
    const fake = defineFake(forge, {
      initial: () => ({}),
      ops: () => ({
        repo: { import: async ({ id }) => ({ id, gone: true }), read: async ({ id }) => ({ id, gone: true }) },
        issue: { open: async () => ({ id: "issue_1" }) },
      }),
    });
    const { ops } = await describeConfig({
      ...base,
      workflows: [],
      connectors: [forge, forgeMore],
      drivers: [fake.driver],
      fakes: [fake],
    });
    const mock = (id: string) => ops.find((o) => o.id === id)?.mock;
    expect(mock("forge.issue.open")).toEqual({ input: {}, output: { id: "issue_1" } });
    expect(mock("forge.repo.archive")).toEqual({
      input: null,
      error: "The forge fake does not implement forge.repo.archive",
    });
    expect(ops.filter((o) => o.resource === "repo").map((o) => [o.id, "mock" in o])).toEqual([
      ["forge.repo.archive", true],
      ["forge.repo.import", false],
      ["forge.repo.read", false],
    ]);
  });

  it("refuses, naming the operation, a fake that crashes and an input faker cannot make up", async () => {
    const shop = defineConnector("shop", {
      item: { get: { effect: "read", input: z.object({}), output: z.object({}) } },
    });
    const crash = defineFake(shop, {
      initial: () => ({}),
      ops: () => ({
        item: {
          get: async () => {
            throw new TypeError("state.items is undefined");
          },
        },
      }),
    });
    const one = { ...base, workflows: [], connectors: [shop], drivers: [crash.driver] };
    await expect(describeConfig({ ...one, fakes: [crash] })).rejects.toThrow(
      /^Sampling shop\.item\.get on its fake: state\.items is undefined$/,
    );
    const note = defineConnector("note", {
      line: { put: { effect: "write", input: z.string(), output: z.object({}) } },
    });
    const notes = defineFake(note, { initial: () => ({}), ops: () => ({ line: { put: async () => ({}) } }) });
    await expect(
      describeConfig({ ...base, workflows: [], connectors: [note], drivers: [notes.driver], fakes: [notes] }),
    ).rejects.toThrow(/^Cannot make up an input for note\.line\.put: /);
  });

  it("describes an operation's input as a caller sends it and its output as parsed", async () => {
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
    const { ops } = await describeConfig({ ...base, workflows: [], connectors: [counter], drivers });
    const [add] = ops;
    // A default makes an input field optional to send, and an output field always there.
    expect(add?.input).not.toHaveProperty("required");
    expect(add?.output).toMatchObject({ required: ["total", "unit"] });
  });

  it("describes each vendor once, its logo as data: URLs, its package and homepage; a connector that names no vendor gets its id as title", async () => {
    const counter = defineConnector("counter", {
      tally: { add: { effect: "write", input: z.object({}), output: z.object({}) } },
    });
    const drivers = [...base.drivers, { vendor: "counter", ops: { "tally.add": async () => ({}) } }];
    const { vendors } = await describeConfig({ ...base, connectors: [ghost, resend, bluesky, counter], drivers });
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

  it("says whether a policy other than allowAll is configured, and its version, and names the app and version", async () => {
    const plain = await describeConfig(base);
    expect(plain.policy).toEqual({ defined: false });
    expect(plain.appName).toBe("sanoma");
    expect(plain.version).toMatch(/^sanoma@[0-9a-f]{64}$/);
    const gated = defineConfig({ ...base, appName: "acme", policy: definePolicy(() => allow()) });
    expect(await describeConfig(gated)).toMatchObject({
      appName: "acme",
      version: expect.stringMatching(/^acme@/),
      policy: { defined: true },
    });
    const versioned = definePolicy(() => allow(), { version: "2026-10-07" });
    expect(versioned.version).toBe("2026-10-07");
    expect((await describeConfig({ ...base, policy: versioned })).policy).toEqual({
      defined: true,
      version: "2026-10-07",
    });
    expect(() => definePolicy(() => allow(), { version: "" })).toThrow("`version` must be a non-empty string");
  });

  it("is plain JSON: it round-trips through JSON.stringify unchanged", async () => {
    for (const config of [base, { ...base, fakes: [fakeGhost(), fakeResend(), fakeBluesky()] }]) {
      const c = await describeConfig(config);
      expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    }
  });

  it("describes what JSON Schema cannot express as open, rather than failing", async () => {
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
    await expect(
      describeConfig(
        defineConfig({ workflows: [wf], connectors: [odd], drivers, policy: allowAll, ledger: memoryLedger() }),
      ),
    ).resolves.toBeDefined();
  });

  it("names the schema it cannot describe at all", async () => {
    // zod refuses two schemas with one id in a single conversion, whatever `unrepresentable` says.
    const twice = z.object({ a: z.string().meta({ id: "twice" }), b: z.number().meta({ id: "twice" }) });
    const clash = defineConnector("clash", { thing: { get: { effect: "read", input: z.object({}), output: twice } } });
    const drivers = [{ vendor: "clash", ops: { "thing.get": async () => ({ a: "", b: 0 }) } }];
    await expect(describeConfig({ ...base, workflows: [], connectors: [clash], drivers })).rejects.toThrow(
      /^Cannot describe clash\.thing\.get output as JSON Schema: Duplicate schema id "twice"/,
    );
  });
});
