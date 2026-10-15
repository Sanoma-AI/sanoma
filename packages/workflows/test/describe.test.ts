import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { ghost } from "@sanoma-ai/connector-ghost";
import { resend } from "@sanoma-ai/connector-resend";
import blueskyPkg from "../../../connectors/bluesky/package.json" with { type: "json" };
import ghostPkg from "../../../connectors/ghost/package.json" with { type: "json" };
import resendPkg from "../../../connectors/resend/package.json" with { type: "json" };
import { withFake } from "@sanoma-ai/testing";
import { afterEach, describe, expect, it } from "vitest";
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
import { defineFake } from "../src/fake.ts";
import { VENDOR } from "../src/op.ts";
import { problemLine } from "../src/shared.ts";
import announce from "./fixtures/announce.ts";

// On the connectors as their packages export them, with their own drivers and fakes.
const base = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
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
    // How a scenario's steps name it; an operation without phrases has none.
    expect(publish.phrases).toHaveProperty("expect", "post {id} is published");
    expect(ops.find((o) => o.id === "resend.broadcast.create")).not.toHaveProperty("phrases");
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
    const { ops } = describeConfig({ ...base, workflows: [], connectors: [counter] });
    const [add] = ops;
    // A default makes an input field optional to send, and an output field always there.
    expect(add?.input).not.toHaveProperty("required");
    expect(add?.output).toMatchObject({ required: ["total", "unit"] });
  });

  it("describes each vendor once, its logo as data: URLs, its package and homepage; a connector that names no vendor gets its id as title", () => {
    const counter = defineConnector("counter", {
      tally: { add: { effect: "write", input: z.object({}), output: z.object({}) } },
    });
    const { vendors } = describeConfig({ ...base, connectors: [ghost, resend, bluesky, counter] });
    expect(Object.keys(vendors).toSorted()).toEqual(["bluesky", "counter", "ghost", "resend"]);
    // counter's connector attaches no fake; the packages' connectors do.
    expect(vendors.counter).toEqual({ title: "counter", fake: false });
    expect(vendors.ghost?.fake).toBe(true);
    expect(vendors.resend).toMatchObject({
      title: "Resend",
      package: "@sanoma-ai/connector-resend",
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
    const plain = describeConfig(base);
    expect(plain.policy).toEqual({ defined: false });
    // No package.json in the directory of this file, which defined the config: the app is "sanoma".
    expect(plain.appName).toBe("sanoma");
    expect(plain.version).toMatch(/^sanoma@[0-9a-f]{64}$/);
    const gated = defineConfig({ ...base, policy: definePolicy(() => allow()) });
    expect(describeConfig(gated).policy).toEqual({ defined: true });
    const versioned = definePolicy(() => allow(), { version: "2026-10-07" });
    expect(versioned.version).toBe("2026-10-07");
    expect(describeConfig({ ...base, policy: versioned }).policy).toEqual({
      defined: true,
      version: "2026-10-07",
    });
    expect(() => definePolicy(() => allow(), { version: "" })).toThrow("`version` must be a non-empty string");
  });

  it("is plain JSON: it round-trips through JSON.stringify unchanged", () => {
    for (const config of [base, { ...base, workflows: [], connectors: [defineConnector("bare", {})] }]) {
      const c = describeConfig(config);
      expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    }
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
    const fake = defineFake(odd, { initial: () => ({}), ops: () => ({ thing: { get: async () => new Map() } }) });
    // `unrepresentable: "any"` keeps custom types as {}; only a schema that throws is reported.
    expect(() =>
      describeConfig(
        defineConfig({ workflows: [wf], connectors: [withFake(odd, fake)], policy: allowAll, ledger: memoryLedger() }),
      ),
    ).not.toThrow();
  });

  it("names the schema it cannot describe at all", () => {
    // zod refuses two schemas with one id in a single conversion, whatever `unrepresentable` says.
    const twice = z.object({ a: z.string().meta({ id: "twice" }), b: z.number().meta({ id: "twice" }) });
    const clash = defineConnector("clash", { thing: { get: { effect: "read", input: z.object({}), output: twice } } });
    expect(() => describeConfig({ ...base, workflows: [], connectors: [clash] })).toThrow(
      /^Cannot describe clash\.thing\.get output as JSON Schema: Duplicate schema id "twice"/,
    );
  });
});

/** `announce`, as if defined in `file`: its outline and lint read that file. */
const definedIn = (file: string) => ({ ...announce, file }) as typeof announce;

describe("describeConfig's workflow problems", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("are what lintWorkflow finds in the workflow's file, at their positions, on its entry", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-describe-"));
    const file = join(dir, "announce.ts");
    writeFileSync(
      file,
      `import { defineWorkflow, SanomaClient } from "@sanoma-ai/workflows";
import { readFileSync } from "node:fs";
import { ghost } from "@sanoma-ai/connector-ghost";
import { z } from "zod";
export default defineWorkflow({
  name: "announce",
  trigger: "manual",
  input: z.object({ title: z.string() }),
  uses: [ghost.post.create],
  run: async (ctx, { title }) => {
    const c = ctx;
    await c.ghost.post.create({ title, html: "" });
  },
});
`,
    );
    const { workflows, problems } = describeConfig({ ...base, workflows: [definedIn(file)], root: dir });
    expect(problems).toEqual([]);
    expect(workflows[0]!.file).toBe(file);
    expect(workflows[0]!.outline).toEqual({
      error: expect.stringMatching(/^.*announce\.ts:11:15: ctx is only called/),
    });
    const found = [
      { line: 1, column: 26, message: expect.stringMatching(/^SanomaClient is not allowed in a workflow/) },
      { line: 2, column: 30, message: expect.stringMatching(/^import "node:fs" is not allowed in a workflow/) },
      { line: 11, column: 15, message: expect.stringMatching(/^ctx is only called, directly/) },
    ];
    expect(workflows[0]!.problems).toEqual(found);
    // A file defining two workflows gives each its problems; one it does not define, the outline's error too.
    const again = { ...definedIn(file), name: "again" } as typeof announce;
    const twice = describeConfig({ ...base, workflows: [definedIn(file), again], root: dir }).workflows;
    expect(twice.map((wf) => [wf.name, wf.problems])).toEqual([
      ["again", [...found, { line: 1, column: 1, message: expect.stringMatching(/holds no workflow named "again"$/) }]],
      ["announce", found],
    ]);
  });

  it("are the syntax problems for a file that does not parse, and the outline's error for one that cannot be read", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-describe-"));
    const broken = join(dir, "broken.ts");
    writeFileSync(broken, 'export default defineWorkflow({ name: "announce", run: async (ctx) => { ctx. } });\n');
    const [parsed] = describeConfig({ ...base, workflows: [definedIn(broken)], root: dir }).workflows;
    expect(parsed!.outline).toEqual({ error: expect.stringMatching(/broken\.ts could not be parsed/) });
    expect(parsed!.problems).toEqual([
      { line: 1, column: expect.any(Number), message: expect.stringMatching(/^syntax: /) },
    ]);

    const gone = join(dir, "gone.ts");
    const [unread] = describeConfig({ ...base, workflows: [definedIn(gone)], root: dir }).workflows;
    expect(unread!.outline).toEqual({ error: expect.stringMatching(/could not be read/) });
    expect(unread!.problems).toEqual([
      { line: 1, column: 1, message: expect.stringMatching(/^.*gone\.ts could not be read/) },
    ]);
  });

  it("are empty for the example workflow", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-describe-"));
    const description = describeConfig({ ...base, root: dir });
    expect(description.problems).toEqual([]);
    expect(description.workflows.flatMap((wf) => wf.problems)).toEqual([]);
  });
});

describe("problemLine", () => {
  it("is file:line:column: message, file: message without a position, the message alone without a file", () => {
    expect(problemLine({ file: "w.ts", line: 2, column: 3, message: "m" })).toBe("w.ts:2:3: m");
    expect(problemLine({ file: "w.ts", message: "m" })).toBe("w.ts: m");
    expect(problemLine({ message: "m" })).toBe("m");
  });
});
