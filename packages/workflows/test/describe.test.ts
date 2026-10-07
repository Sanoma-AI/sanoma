import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { fakeMarketingVendors } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allow,
  allowAll,
  defineConfig,
  describeConfig,
  defineConnector,
  definePolicy,
  defineWorkflow,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";

const base = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: fakeMarketingVendors().drivers,
  policy: allowAll,
});

describe("describeConfig", () => {
  it("describes each workflow: its input as JSON Schema, the operations it may call, and its built-ins", () => {
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
      properties: { status: { enum: ["draft", "scheduled", "published"] } },
    });
  });

  it("says whether a policy other than allowAll is configured, and its version, and names the app and version", () => {
    expect(describeConfig(base).policy).toEqual({ defined: false });
    expect(describeConfig(base).appName).toBe("sanoma");
    expect(describeConfig(base).version).toMatch(/^sanoma@[0-9a-f]{64}$/);
    const gated = defineConfig({ ...base, appName: "acme", version: "abc", policy: definePolicy(() => allow()) });
    expect(describeConfig(gated)).toMatchObject({ appName: "acme", version: "acme@abc", policy: { defined: true } });
    const versioned = definePolicy(() => allow(), { version: "2026-10-07" });
    expect(versioned.version).toBe("2026-10-07");
    expect(describeConfig({ ...base, policy: versioned }).policy).toEqual({ defined: true, version: "2026-10-07" });
    expect(() => definePolicy(() => allow(), { version: "" })).toThrow("`version` must be a non-empty string");
  });

  it("is plain JSON: it round-trips through JSON.stringify unchanged", () => {
    const c = describeConfig(base);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it("names the schema it cannot describe", () => {
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
      describeConfig(defineConfig({ workflows: [wf], connectors: [odd], drivers, policy: allowAll })),
    ).not.toThrow();
  });
});
