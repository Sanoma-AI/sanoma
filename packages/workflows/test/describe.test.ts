import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { docker } from "@sanoma-ai/connector-docker";
import { ghost } from "@sanoma-ai/connector-ghost";
import { github } from "@sanoma-ai/connector-github";
import { resend } from "@sanoma-ai/connector-resend";
import { stripe } from "@sanoma-ai/connector-stripe";
import { supabase } from "@sanoma-ai/connector-supabase";
import { withFake } from "@sanoma-ai/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig, defineConnector, defineWorkflow, memoryLedger, vendorInfo } from "../src/index.ts";
import { readPolicyFiles } from "../src/cedar.ts";
import { rootOf } from "../src/config.ts";
import { ConfigDescriptionSchema, describeConfig, outlineWorkflow } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
import { VENDOR } from "../src/op.ts";
import { apiNameOf, problemLine } from "../src/shared.ts";
import announce from "./fixtures/announce.ts";
import company from "./fixtures/company/sanoma.config.ts";
import companyApps from "./fixtures/company-apps/sanoma.config.ts";
import { customers as crmCustomers } from "./fixtures/company-apps/apps/crm/resources/data.ts";
import { customers as shopCustomers } from "./fixtures/company-apps/apps/shop/resources/data.ts";
import followUp from "./fixtures/company-apps/apps/crm/workflows/follow-up.ts";
import thank from "./fixtures/company-apps/apps/shop/workflows/follow-up.ts";
import introduce from "./fixtures/company-apps/workflows/introduce.ts";
import outbound from "./fixtures/outbound/sanoma.config.ts";
import people from "./fixtures/people/sanoma.config.ts";

// On the connectors as their packages export them, with their own drivers and fakes.
const base = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
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

  it("carries each workflow's trigger: manual, or its schedule", () => {
    const nightly = defineWorkflow({
      name: "nightly",
      trigger: { schedule: "0 3 * * *", timezone: "UTC" },
      input: z.object({}),
      uses: [],
      run: async () => 1,
    });
    const { workflows } = describeConfig({ ...base, workflows: [announce, nightly] });
    expect(workflows.filter((wf) => !wf.builtin).map(({ name, trigger }) => ({ name, trigger }))).toEqual([
      { name: "announce", trigger: "manual" },
      { name: "nightly", trigger: { schedule: "0 3 * * *", timezone: "UTC" } },
    ]);
  });

  it("lists ctx.all among a workflow's built-ins", () => {
    const fan = defineWorkflow({
      name: "fan",
      trigger: "manual",
      input: z.object({}),
      uses: [bluesky.post.create, "all"],
      run: async (ctx) => ctx.all([() => ctx.bluesky.post.create({ text: "x" })]),
    });
    const wf = describeConfig({ ...base, workflows: [fan] }).workflows.find((w) => w.name === "fan")!;
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
      "resend.emails.send",
      "sanoma.apps.list",
      "sanoma.change.close",
      "sanoma.change.merge",
      "sanoma.change.open",
      "sanoma.change.review",
      "sanoma.connection.activate",
      "sanoma.connection.bind",
      "sanoma.connection.configure",
      "sanoma.connection.create",
      "sanoma.connection.disconnect",
      "sanoma.connection.prepare",
      "sanoma.connection.test",
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

  // The app finds connectors not installed on npm by the keyword, and shows them by the `sanoma` field.
  it.each(Object.entries({ bluesky, docker, ghost, github, resend, stripe, supabase }))(
    "takes the %s connector's title, logo, package and homepage from its package.json, which npm can list",
    (vendor, connector) => {
      const dir = new URL(`../../../connectors/${vendor}/`, import.meta.url);
      const pkg = JSON.parse(readFileSync(new URL("package.json", dir), "utf8"));
      expect(pkg.keywords).toContain("sanoma-connector");
      // Its logos are shipped, so npm's copy has them too.
      expect(pkg.files).toEqual(expect.arrayContaining([pkg.sanoma.logo, pkg.sanoma.logoDark].filter(Boolean)));
      expect(connector[VENDOR].info).toMatchObject({
        title: pkg.sanoma.title,
        package: pkg.name,
        homepage: pkg.homepage,
      });
      expect(connector[VENDOR].info?.logo?.svg).toBeDefined();
    },
  );

  it("refuses a package.json without a sanoma field that names the vendor", () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-info-"));
    try {
      mkdirSync(join(root, "src"));
      const moduleUrl = new URL(`file://${root}/src/connector.ts`);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sanoma-connector-acme" }));
      expect(() => vendorInfo(moduleUrl)).toThrow(
        'sanoma-connector-acme: package.json needs a "sanoma" field with a title',
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "sanoma-connector-acme", sanoma: { title: "Acme" } }),
      );
      expect(vendorInfo(moduleUrl)).toEqual({ title: "Acme", package: "sanoma-connector-acme" });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "sanoma-connector-acme", sanoma: { title: "Acme", logo: "logo.svg" } }),
      );
      expect(() => vendorInfo(moduleUrl)).toThrow(
        'sanoma-connector-acme: the "sanoma" field\'s logo logo.svg is not in the package',
      );
    } finally {
      rmSync(root, { recursive: true });
    }
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

  it("says the policy is undefined without policies/*.cedar, and names the app and version", () => {
    const plain = describeConfig(base);
    // The root's policies, when it has any, are cedar.test.ts's.
    expect(plain.policy).toEqual({ defined: false, files: [] });
    // No package.json in the directory of this file, which defined the config: the app is "sanoma".
    expect(plain.appName).toBe("sanoma");
    expect(plain.version).toMatch(/^sanoma@[0-9a-f]{64}$/);
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
      describeConfig(defineConfig({ workflows: [wf], connectors: [withFake(odd, fake)], ledger: memoryLedger() })),
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
    expect(twice.filter((wf) => !wf.builtin).map((wf) => [wf.name, wf.problems])).toEqual([
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

/** `announce`, under another name. */
const renamed = (name: string) => ({ ...announce, name }) as typeof announce;

describe("a workflow's name in a site's api", () => {
  it("is its name in camelCase (apiNameOf)", () => {
    expect(["noop", "outbound-next", "send-2-leads", "a-b-c"].map(apiNameOf)).toEqual([
      "noop",
      "outboundNext",
      "send2Leads",
      "aBC",
    ]);
  });

  it("is a problem on a workflow when another workflow, a vendor or the collections have it", () => {
    const { workflows } = describeConfig({
      ...base,
      workflows: [
        announce,
        renamed("outbound-next"),
        renamed("outboundNext"),
        renamed("ghost"),
        renamed("data"),
        renamed("then"),
      ],
    });
    const apiProblems = workflows.map((wf) => [
      wf.name,
      wf.problems.filter((p) => p.message.includes("api.")).map((p) => [p.line, p.column, p.message]),
    ]);
    expect(apiProblems).toEqual([
      ["announce", []],
      ["call", []],
      ["change", []],
      ["data", [[1, 1, "A site calls this workflow api.data, which is the collections': rename it"]]],
      ["ghost", [[1, 1, "A site calls this workflow api.ghost, which is the vendor ghost's operations: rename it"]]],
      [
        "outbound-next",
        [[1, 1, 'A site calls this workflow api.outboundNext, as workflow "outboundNext" is: rename it']],
      ],
      [
        "outboundNext",
        [[1, 1, 'A site calls this workflow api.outboundNext, as workflow "outbound-next" is: rename it']],
      ],
      ["then", [[1, 1, "A site calls this workflow api.then, which a promise would take for its own: rename it"]]],
    ]);
  });
});

describe("problemLine", () => {
  it("is file:line:column: message, file: message without a position, the message alone without a file", () => {
    expect(problemLine({ file: "w.ts", line: 2, column: 3, message: "m" })).toBe("w.ts:2:3: m");
    expect(problemLine({ file: "w.ts", message: "m" })).toBe("w.ts: m");
    expect(problemLine({ message: "m" })).toBe("m");
  });
});

describe("ConfigDescriptionSchema", () => {
  // company-apps as the launcher finds its workflows and collections (`loadConfig`, in the sanoma package).
  const apps = {
    ...companyApps,
    workflows: [followUp, thank, introduce],
    collections: [crmCustomers, shopCustomers],
  };

  it.each(Object.entries({ base, company, "company-apps": apps, outbound, people }))(
    "holds the description of the %s fixture, as it is",
    (_name, config) => {
      const description = describeConfig(config);
      expect(ConfigDescriptionSchema.parse(description)).toEqual(description);
    },
  );

  it("refuses a description with a key it does not know, or without one it needs", () => {
    const description = describeConfig(base);
    expect(ConfigDescriptionSchema.safeParse({ ...description, extra: 1 }).success).toBe(false);
    const { policy: _, ...rest } = description;
    expect(ConfigDescriptionSchema.safeParse(rest).success).toBe(false);
  });

  it("says which contracts each resource type meets: a host, a database, and the repository a host's source names", () => {
    const { resourceTypes } = describeConfig({ ...base, workflows: [], connectors: [github, docker, supabase] });
    const capabilities = Object.fromEntries(resourceTypes.map((t) => [t.id, t.capabilities]));
    expect(capabilities).toMatchObject({
      "docker.container": ["host"],
      "supabase.project": ["database"],
      "github.repository": ["source"],
    });
    expect(capabilities["github.team"]).toBeUndefined();
  });

  it("names each variable a vendor's driver declares, with its manual, never a value or a status", () => {
    const { vendors } = describeConfig(base);
    expect(vendors.ghost?.credentials).toEqual([
      { name: "GHOST_ADMIN_URL", description: "the site's admin URL, such as https://example.ghost.io" },
      { name: "GHOST_ADMIN_API_KEY", description: "a custom integration's Admin API key, <id>:<secret>" },
    ]);
  });

  it("carries the policy's files as read, the root's then each app's, and none without a root", () => {
    const description = describeConfig(people);
    expect(description.policy.files).toEqual(readPolicyFiles(rootOf(people)!));
    expect(description.policy.files.map((f) => f.file)).toEqual(["policies/refunds.cedar", "policies/visitors.cedar"]);
    expect(describeConfig(base).policy.files).toEqual([]);
  });
});
