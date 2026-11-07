import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError, createClient, createRouterTransport, type ServiceImpl } from "@connectrpc/connect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Bridge, BridgeError, type SchemaDocument } from "@sanoma-ai/bridge";
import { bridgeClient } from "../src/bridge.ts";
import {
  BridgeService,
  Diagnostic_Severity,
  DiagnosticSchema,
  PlanResponse_Action,
} from "../src/gen/bridge/v1/bridge_pb.ts";
import { fakeBridge } from "./fake-bridge.ts";
import { recorder } from "./record.ts";

// The recorder against an in-memory provider whose state holds every kind of secret.
const ref = { sessionId: "00000000-0000-0000-0000-000000000001", source: "example/widget", version: "1.0.0" };
const token = "TOKENVALUE123";
const apiKey = "api-key-abcdefgh";
const config = JSON.stringify({ api_key: apiKey, token, owner: "acme-corp" });

const schema: SchemaDocument = {
  source: "example/widget",
  version: "1.0.0",
  protocol: 6,
  formatVersion: 1,
  providerConfig: {
    attributes: {
      api_key: { type: "string", optional: true, sensitive: true },
      token: { type: "string", optional: true },
      owner: { type: "string", optional: true },
    },
    blocks: {},
  },
  resources: {
    widget_thing: {
      schemaVersion: 2,
      block: {
        attributes: {
          id: { type: "string", computed: true },
          count: { type: "number", computed: true },
          owner: { type: "string", optional: true },
          secret: { type: "string", computed: true, sensitive: true },
          url: { type: "string", computed: true },
          settings: {
            type: ["object", { mode: "string", password: "string" }],
            optional: true,
            nestedType: {
              nesting: "single",
              attributes: { mode: { type: "string", optional: true }, password: { type: "string", sensitive: true } },
            },
          },
        },
        blocks: {
          rule: { nesting: "list", block: { attributes: { key: { type: "string", sensitive: true } }, blocks: {} } },
        },
      },
    },
  },
  dataSources: {},
};

// Numbers stay as written: 2^64 + 1 would not survive a round trip through a JS number.
const state = (id: string) =>
  `{"count":18446744073709551617,"id":"${id}","owner":"acme-corp","rule":[{"key":"k1"}],"secret":"s3cr3t-value","settings":{"mode":"on","password":"hunter22"},"url":"https://x.example/?t=${token}"}`;

let applies = 0;
const provider: ServiceImpl<typeof BridgeService> = {
  getSchema: () => ({
    schemaJson: `${JSON.stringify(schema, null, 2)}\n`,
    protocol: 6,
    sessionProtocol: 1,
    sha256: "ab".repeat(32),
  }),
  configure: () => ({ warnings: [], sha256: "ab".repeat(32) }),
  import: (req) => {
    if (req.id === "leaky") {
      return {
        resources: [{ typeName: req.typeName, stateJson: state(req.id), private: new TextEncoder().encode(token) }],
      };
    }
    return {
      resources: [
        {
          typeName: req.typeName,
          stateJson: state(req.id),
          private: new TextEncoder().encode('{"v":1}'),
          schemaVersion: 2n,
        },
      ],
    };
  },
  read: (req) => {
    if (JSON.parse(req.stateJson).id === "broken") {
      throw new ConnectError(`401: bad key ${apiKey}`, Code.FailedPrecondition, undefined, [
        { desc: DiagnosticSchema, value: { severity: Diagnostic_Severity.ERROR, summary: `bad key ${apiKey}` } },
      ]);
    }
    return { resource: { typeName: req.typeName, stateJson: req.stateJson, private: req.private, schemaVersion: 2n } };
  },
  // A change: a new owner replaces the object; an owner of "half" fails half way, after creating it.
  plan: (req) => {
    if (!req.configJson) return { action: PlanResponse_Action.DELETE };
    const planned = new TextEncoder().encode(req.configJson);
    if (!req.priorStateJson)
      return { action: PlanResponse_Action.CREATE, plannedStateJson: req.configJson, unknownPaths: ["id"], planned };
    const same = JSON.parse(req.priorStateJson).owner === JSON.parse(req.configJson).owner;
    return same
      ? { action: PlanResponse_Action.NONE, plannedStateJson: req.priorStateJson, planned }
      : {
          action: PlanResponse_Action.REPLACE,
          plannedStateJson: req.configJson,
          unknownPaths: ["id"],
          requiresReplace: ["owner"],
          planned,
        };
  },
  apply: (req) => {
    applies++;
    if (!req.configJson) return {};
    const stateJson = JSON.stringify({ ...JSON.parse(req.configJson), id: "w:new" });
    const resource = { typeName: req.typeName, stateJson };
    if (JSON.parse(req.configJson).owner !== "half") return { resource };
    return { resource, errors: [{ severity: Diagnostic_Severity.ERROR, summary: "half way" }] };
  },
  close: () => ({}),
};

const desired = (owner: string, secret: string | null = null) =>
  JSON.stringify({ count: 1, id: null, owner, rule: null, secret, settings: null, url: null });
const changes = "replies/example_widget_1.0.0/widget_thing";

const dir = mkdtempSync(join(tmpdir(), "sanoma-bridge-record-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function recordingBridge(): Bridge {
  const transport = createRouterTransport(({ service }) => service(BridgeService, provider), {
    transport: { interceptors: [recorder(dir)] },
  });
  return bridgeClient(createClient(BridgeService, transport), async () => {});
}

const fixture = (path: string) => JSON.parse(readFileSync(join(dir, path), "utf8"));
const text = (path: string) => readFileSync(join(dir, path), "utf8");

beforeEach(() => {
  vi.stubEnv("SANOMA_LIVE", "");
  vi.stubEnv("SANOMA_RECORD", "");
});

describe("recorder", () => {
  it("keeps secret scrubbing tied to the configured session", async () => {
    const bridge = recordingBridge();
    await bridge.configure(ref, config);
    const other = { ...ref, sessionId: "00000000-0000-0000-0000-000000000002" };
    await bridge.configure(other, JSON.stringify({ token: "OTHER-TOKEN-456" }));
    await bridge.import(ref, "widget_thing", "account-a");
    const saved = text("replies/example_widget_1.0.0/widget_thing/account-a/import.json");
    expect(saved).not.toContain(token);
    expect(saved).not.toContain(apiKey);
    expect(saved).not.toContain(ref.sessionId);
    expect(saved).toContain("<scrubbed:config.token>");
  });

  it("writes the schema, then scrubbed import and read fixtures", async () => {
    const bridge = recordingBridge();
    await bridge.schema(ref);
    await bridge.configure(ref, config);
    const { resources } = await bridge.import(ref, "widget_thing", "w:1");
    // The caller gets the provider's real state; only the fixture is scrubbed.
    expect(resources[0]?.stateJson).toBe(state("w:1"));
    await bridge.read(ref, "widget_thing", resources[0]!.stateJson, resources[0]!.private, 2);

    expect(JSON.parse(text("schemas/example_widget_1.0.0.json"))).toEqual(schema);

    const imported = fixture("replies/example_widget_1.0.0/widget_thing/w_1/import.json");
    expect(imported.provider).toEqual({
      source: ref.source,
      version: ref.version,
      sha256: "ab".repeat(32),
      protocol: 6,
    });
    expect(imported.request).toEqual({
      provider: { source: ref.source, version: ref.version },
      typeName: "widget_thing",
      id: "w:1",
    });
    expect(imported.scrubbed).toEqual([
      "config.owner",
      "widget_thing.rule.key",
      "widget_thing.secret",
      "widget_thing.settings.password",
      "config.api_key",
      "config.token",
    ]);
    const [resource] = imported.response.resources;
    expect(resource.private).toBe(Buffer.from('{"v":1}').toString("base64"));
    expect(resource.schemaVersion).toBe("2");
    expect(resource.stateJson).toBe(
      '{"count":18446744073709551617,"id":"w:1","owner":"<scrubbed>","rule":[{"key":"<scrubbed>"}],"secret":"<scrubbed>","settings":{"mode":"on","password":"<scrubbed>"},"url":"https://x.example/?t=<scrubbed:config.token>"}',
    );

    // The read lands beside its import, its request scrubbed as well.
    const read = fixture("replies/example_widget_1.0.0/widget_thing/w_1/read.json");
    expect(read.request.schemaVersion).toBe("2");
    expect(read.request.stateJson).toBe(resource.stateJson);
    expect(read.response.resource.stateJson).toBe(resource.stateJson);

    for (const file of ["w_1/import.json", "w_1/read.json"]) {
      const written = text(`replies/example_widget_1.0.0/widget_thing/${file}`);
      for (const secret of [token, apiKey, "s3cr3t-value", "hunter22", '"k1"']) expect(written).not.toContain(secret);
    }
  });

  it("records a failed call with its diagnostics, secrets replaced", async () => {
    const bridge = recordingBridge();
    await bridge.schema(ref);
    await bridge.configure(ref, config);
    await expect(bridge.read(ref, "widget_thing", '{"id":"broken"}')).rejects.toMatchObject({
      code: "failed_precondition",
    });
    const read = fixture("replies/example_widget_1.0.0/widget_thing/broken/read.json");
    expect(read.response).toEqual({
      error: {
        code: "failed_precondition",
        message: "401: bad key <scrubbed:config.api_key>",
        diagnostics: [{ severity: "SEVERITY_ERROR", summary: "bad key <scrubbed:config.api_key>" }],
      },
    });
  });

  it("rethrows the bridge's error when a failed call cannot be recorded", async () => {
    // A new recorder knows no schema or config yet, so it cannot scrub, and records nothing.
    const bridge = recordingBridge();
    const error = await bridge.read(ref, "widget_thing", '{"id":"broken"}').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "failed_precondition", message: `401: bad key ${apiKey}` });
  });

  it("refuses to record private data that holds a secret", async () => {
    const bridge = recordingBridge();
    await bridge.schema(ref);
    await bridge.configure(ref, config);
    const error = await bridge.import(ref, "widget_thing", "leaky").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).message).toContain("private data contains config.token; refusing to record");
  });

  it("records a change: its plan, and each apply beside it, a replace's delete first", async () => {
    const bridge = recordingBridge();
    await bridge.schema(ref);
    await bridge.configure(ref, config);
    const create = await bridge.plan(ref, "widget_thing", { configJson: desired("o1") });
    expect(create).toMatchObject({ action: "create", unknownPaths: ["id"], requiresReplace: [] });
    const made = await bridge.apply(ref, "widget_thing", { configJson: desired("o1"), planned: create.planned });
    const prior = made.resource!.stateJson;
    const replace = await bridge.plan(ref, "widget_thing", { priorStateJson: prior, configJson: desired("o2") });
    expect(replace).toMatchObject({ action: "replace", requiresReplace: ["owner"] });
    await bridge.apply(ref, "widget_thing", { priorStateJson: prior, priorSchemaVersion: 0 });
    await bridge.apply(ref, "widget_thing", { configJson: desired("o2"), planned: replace.planned });
    const deleted = await bridge.plan(ref, "widget_thing", { priorStateJson: prior });
    expect(deleted).toMatchObject({ action: "delete", plannedStateJson: "", planned: new Uint8Array() });

    const folders = readdirSync(join(dir, changes)).filter((name) => /^create-|^w_new-/.test(name));
    const files = Object.fromEntries(
      folders.map((name) => [name.replace(/[0-9a-f]{8}$/, "<hash>"), readdirSync(join(dir, changes, name)).toSorted()]),
    );
    expect(files).toEqual({
      "create-<hash>": ["apply.json", "plan.json"],
      "w_new-<hash>": ["apply-delete.json", "apply.json", "plan.json"],
      "w_new-delete": ["plan.json"],
    });
    const replaced = folders.find((name) => name.startsWith("w_new-") && name !== "w_new-delete")!;
    expect(fixture(`${changes}/${replaced}/apply-delete.json`)).toMatchObject({
      request: { priorStateJson: prior, priorSchemaVersion: "0" },
      response: {},
    });
    expect(fixture(`${changes}/${replaced}/apply.json`).request.configJson).toBe(desired("o2"));
  });

  it("returns an apply's provider errors beside the state, and records them", async () => {
    const bridge = recordingBridge();
    await bridge.schema(ref);
    await bridge.configure(ref, config);
    const half = await bridge.apply(ref, "widget_thing", { configJson: desired("half"), planned: new Uint8Array([1]) });
    expect(half).toEqual({
      resource: expect.objectContaining({ stateJson: expect.stringContaining('"id":"w:new"') }),
      errors: [{ severity: "error", summary: "half way", detail: "", attributePath: "" }],
      warnings: [],
    });
  });

  it("refuses to record a change whose config holds a sensitive value", async () => {
    const bridge = recordingBridge();
    await bridge.schema(ref);
    await bridge.configure(ref, config);
    const error = await bridge
      .plan(ref, "widget_thing", { configJson: desired("o3", "s3cr3t-value") })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain("widget_thing.secret is sensitive");
    // Refused before it reaches the provider, so nothing is changed unrecorded.
    const before = applies;
    const apply = bridge.apply(ref, "widget_thing", {
      configJson: desired("o3", "s3cr3t-value"),
      planned: new Uint8Array([1]),
    });
    await expect(apply).rejects.toThrow("widget_thing.secret is sensitive");
    expect(applies).toBe(before);
  });

  it("writes fixtures the fake replays", async () => {
    const bridge = fakeBridge({ fixtures: dir });
    expect((await bridge.schema(ref)).schema).toEqual(schema);
    await bridge.configure(ref, "{}");
    const { resources } = await bridge.import(ref, "widget_thing", "w:1");
    expect(resources[0]).toMatchObject({ typeName: "widget_thing", schemaVersion: 2 });
    const read = await bridge.read(ref, "widget_thing", resources[0]!.stateJson);
    expect(JSON.parse(read.resource!.stateJson)).toMatchObject({ id: "w:1", secret: "<scrubbed>" });
    const failed = await bridge.read(ref, "widget_thing", '{"id":"broken"}').catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: "failed_precondition", diagnostics: [{ severity: "error" }] });
    // A change replays by its prior state and config.
    const create = await bridge.plan(ref, "widget_thing", { configJson: desired("o1") });
    expect(create).toMatchObject({ action: "create", unknownPaths: ["id"] });
    const made = await bridge.apply(ref, "widget_thing", { configJson: desired("o1"), planned: create.planned });
    const prior = made.resource!.stateJson;
    expect(await bridge.plan(ref, "widget_thing", { priorStateJson: prior, configJson: desired("o2") })).toMatchObject({
      action: "replace",
    });
    expect(await bridge.apply(ref, "widget_thing", { priorStateJson: prior })).toEqual({ errors: [], warnings: [] });
    const half = await bridge.apply(ref, "widget_thing", { configJson: desired("half"), planned: new Uint8Array([1]) });
    expect(half.errors).toMatchObject([{ summary: "half way" }]);
    await expect(bridge.plan(ref, "widget_thing", { configJson: desired("o9") })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("no recorded plan"),
    });
    // The release is in no pins.json: its pin is checked against the sha256 its replies recorded.
    expect((await bridge.schema({ ...ref, sha256: "ab".repeat(32) })).sha256).toBe("ab".repeat(32));
    await expect(bridge.schema({ ...ref, sha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "failed_precondition",
      message: expect.stringContaining("refusing release"),
    });
  });
});
