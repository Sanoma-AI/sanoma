import { type Driver, DriverError, memorySecrets, type Op, type Secrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readPins } from "@sanoma-ai/bridge";
import { fixturesDir } from "@sanoma-ai/bridge/fake";
import { BridgeError } from "../src/bridge.ts";
import { resourcePath, tfConnector } from "../src/connector.ts";
import type { TfResourceType, TfShape } from "../src/tfschema/types.ts";
import { changeReplay } from "./change-replay.ts";

const provider = { ...readPins()["hashicorp/null"]!, protocol: 5 };

/** `null_resource`, as `resources.gen.ts` would declare it: a provider id, and `triggers`, whose change replaces it. */
const null_resource: TfResourceType = {
  typeName: "null_resource",
  schemaVersion: 0,
  schema: z.object({ id: z.string().nullish(), triggers: z.record(z.string(), z.string()).nullish() }),
  fields: { immutable: ["triggers"], vendorOwned: ["id"], writeOnly: [] },
  shape: { attributes: ["id", "triggers"] },
};

/** The `id`s the recorded applies gave the objects they made. */
const FIRST = "7464986431894282090";
const SECOND = "1619236683285190585";

const connector = (writeOnly?: string[]) =>
  tfConnector({
    vendor: "nulls",
    provider,
    types: { thing: { tf: null_resource, title: "Thing", writable: true, ...(writeOnly && { writeOnly }) } },
    info: { package: "@sanoma-ai/connector-nulls" },
  });

let seq = 0;
const stored = () => memorySecrets({ TRIGGER: "1" });
const call = (driver: Driver, op: string, input: unknown, secrets: Secrets = memorySecrets()): Promise<any> =>
  driver.ops[op]!(input, { idempotencyKey: `run:${++seq}`, runId: "run", opId: `nulls.${op}`, attempt: 1, secrets });

describe("a writable type's change operations, over hashicorp/null's recorded plans and applies", () => {
  let bridge: ReturnType<typeof changeReplay>;
  let driver: Driver;
  const methods = () => bridge.calls.map((c) => c.action ?? c.method).filter((m) => m !== "configure");
  beforeEach(() => {
    bridge = changeReplay(fixturesDir, provider);
    driver = connector().driver(bridge, () => ({}));
  });

  it("lists plan, create, update and delete beside read and import, and only on a writable type", () => {
    const { resources, connector: ops } = connector();
    expect(Object.keys(resources.thing.ops).toSorted()).toEqual([
      "create",
      "delete",
      "import",
      "plan",
      "read",
      "update",
    ]);
    // A tf type's change operations are not in its static type (that says only `read` and `import`).
    const thing = (ops as unknown as Record<string, Record<string, Op>>).thing!;
    expect(thing.create).toMatchObject({ effect: "write", idempotent: false });
    expect(thing.delete).toMatchObject({ effect: "write", idempotent: true });
    expect(thing.plan).toMatchObject({ effect: "read", idempotent: true });
    expect(thing.create!.target!({ desired: {} })).toBe("new:nulls.thing");
    expect(thing.plan!.target!({ desired: {} })).toBe("new:nulls.thing");
    expect(thing.update!.target!({ id: FIRST, desired: {} })).toBe(FIRST);
    const readOnly = tfConnector({
      vendor: "nulls",
      provider,
      types: { thing: { tf: null_resource, title: "Thing" } },
      info: { package: "@sanoma-ai/connector-nulls" },
    });
    expect(Object.keys(readOnly.resources.thing.ops).toSorted()).toEqual(["import", "read"]);
  });

  it("plans a create, with what is known only after it", async () => {
    const plan = await call(driver, "thing.plan", { desired: { triggers: { v: "1" } } });
    expect(plan).toEqual({
      action: "create",
      planned: { id: null, triggers: { v: "1" } },
      unknown: ["id"],
      replace: [],
    });
    expect(methods()).toEqual(["create"]);
  });

  it("creates, updates in place when nothing changed, replaces, and deletes", async () => {
    const created = await call(driver, "thing.create", { desired: { triggers: { v: "1" } } });
    expect(created).toEqual({ id: FIRST, state: { id: FIRST, triggers: { v: "1" } }, handle: "0:" });
    expect(methods()).toEqual(["create", "apply"]);

    const same = await call(driver, "thing.update", { ...created, desired: { triggers: { v: "1" } } });
    expect(same).toEqual(created);

    const planned = await call(driver, "thing.plan", { ...created, desired: { triggers: { v: "2" } } });
    const replace = { action: "replace", replace: ["triggers"] };
    expect(planned).toEqual({ ...replace, planned: { id: null, triggers: { v: "2" } }, unknown: ["id"] });

    bridge.calls.length = 0;
    const replaced = await call(driver, "thing.update", {
      ...created,
      desired: { triggers: { v: "2" } },
      expect: replace,
    });
    // A replace is a new object: a delete of the old one, then a create of the plan's new one.
    expect(replaced).toEqual({ id: SECOND, state: { id: SECOND, triggers: { v: "2" } }, handle: "0:" });
    expect(methods()).toEqual(["read", "replace", "apply", "apply"]);

    bridge.calls.length = 0;
    expect(await call(driver, "thing.delete", replaced)).toEqual({ id: SECOND, gone: true });
    expect(methods()).toEqual(["read", "delete", "apply"]);
    // Gone already: nothing to plan or apply.
    bridge.calls.length = 0;
    expect(await call(driver, "thing.delete", replaced)).toEqual({ id: SECOND, gone: true });
    expect(methods()).toEqual(["read"]);
    expect(await call(driver, "thing.plan", { ...replaced })).toEqual({ action: "none", unknown: [], replace: [] });
  });

  it("only creates when a replace is tried again after its delete (the bridge restarted between the applies)", async () => {
    const created = await call(driver, "thing.create", { desired: { triggers: { v: "1" } } });
    const { apply } = bridge;
    let applies = 0;
    bridge.apply = async (...args) => {
      // The create half of the replace: the provider is not configured, and `ensureConfigured` tries again.
      if (++applies === 2) throw new BridgeError("failed_precondition", "hashicorp/null 3.3.2 is not configured");
      return apply(...args);
    };
    bridge.calls.length = 0;
    const replaced = await call(driver, "thing.update", { ...created, desired: { triggers: { v: "2" } } });
    expect(replaced).toMatchObject({ id: SECOND, state: { id: SECOND, triggers: { v: "2" } } });
    expect(methods()).toEqual(["read", "replace", "apply", "apply"]);
  });

  it("refuses an update whose fresh plan is not the one expected, changing nothing", async () => {
    const created = await call(driver, "thing.create", { desired: { triggers: { v: "1" } } });
    bridge.calls.length = 0;
    const update = call(driver, "thing.update", {
      ...created,
      desired: { triggers: { v: "2" } },
      expect: { action: "update", replace: [] },
    });
    await expect(update).rejects.toBeInstanceOf(DriverError);
    await expect(update).rejects.toMatchObject({ vendorCode: "plan_changed", retryable: false });
    expect(methods()).toEqual(["read", "replace"]);
  });

  it("refuses to update an object that is gone", async () => {
    const created = await call(driver, "thing.create", { desired: { triggers: { v: "1" } } });
    const replaced = await call(driver, "thing.update", { ...created, desired: { triggers: { v: "2" } } });
    await call(driver, "thing.delete", replaced);
    await expect(
      call(driver, "thing.update", { ...replaced, desired: { triggers: { v: "2" } } }),
    ).rejects.toMatchObject({
      vendorCode: "gone",
    });
  });

  describe("a secret in desired, at a field the type marks write-only though the provider does not", () => {
    beforeEach(() => {
      driver = connector(["triggers"]).driver(bridge, () => ({}));
    });

    it("reaches the provider resolved, and no output", async () => {
      const desired = { triggers: { v: { $secret: "TRIGGER" } } };
      const plan = await call(driver, "thing.plan", { desired }, stored());
      expect(plan).toEqual({ action: "create", planned: { id: null }, unknown: ["id"], replace: [] });
      const created = await call(driver, "thing.create", { desired }, stored());
      expect(created).toEqual({ id: FIRST, state: { id: FIRST, triggers: null }, handle: "0:" });
      const read = await call(driver, "thing.read", created);
      expect(read).toEqual({ id: FIRST, gone: false, state: { id: FIRST, triggers: null }, handle: "0:" });
      expect(JSON.stringify([plan, created, read])).not.toContain('"v"');
    });

    it("fails for good when the secret is not stored", async () => {
      const create = call(driver, "thing.create", { desired: { triggers: { v: { $secret: "TRIGGER" } } } });
      await expect(create).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("TRIGGER") });
      expect(bridge.calls.filter((c) => c.method === "plan")).toEqual([]);
    });
  });
});

describe("resourcePath", () => {
  const shape: TfShape = {
    attributes: ["id", "tags"],
    blocks: {
      reviews: { nesting: "list", one: true, shape: { attributes: ["count"] } },
      rules: { nesting: "list", shape: { attributes: ["name"] } },
    },
  };

  it("drops the index of a block of one item, and keeps a list's and a map's keys as segments", () => {
    expect(resourcePath(shape, "id")).toBe("id");
    expect(resourcePath(shape, "reviews[0].count")).toBe("reviews.count");
    expect(resourcePath(shape, "rules[2].name")).toBe("rules.2.name");
    expect(resourcePath(shape, 'tags["env"]')).toBe("tags.env");
    expect(resourcePath(shape, 'tags["a.\\"b"]')).toBe('tags.a."b');
  });
});
