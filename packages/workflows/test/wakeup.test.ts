import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import {
  declaredWakeup,
  defineConnector,
  defineResource,
  defineWorkflow,
  type HostSpec,
  resolveConfig,
  type SanomaConfig,
  startWorker,
  type WakeupSpec,
  wakeGeneration,
} from "../src/index.ts";
import { rootWith } from "./harness.ts";

// A host and a wakeup that wakes it, of one vendor: the wakeup names the host by its URL.
const service = defineResource({
  vendor: "acme",
  type: "service",
  title: "Service",
  identity: "name",
  schema: z.object({
    name: z.string(),
    repo: z.string(),
    branch: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    port: z.number().optional(),
    commit: z.string().optional(),
    url: z.string().optional(),
  }),
  fields: { immutable: [], vendorOwned: ["url"], writeOnly: ["env"] },
  find: ({ name }) => name,
  writable: true,
  host: {
    capabilities: { lifetime: "stops-on-exit", publicUrl: true, buildsFromGit: true, staticEgress: false },
    inputs: { source: "repo", ref: "branch", secrets: "env", port: "port" },
    revision: "commit",
    outputs: (state) => ({ url: String(state.url), healthy: true }),
  } satisfies HostSpec,
});

const wakeupSchema = z.object({ name: z.string(), host: z.string(), note: z.string().optional() });
const wakeup: WakeupSpec = {
  inputs: { host: "host" },
  register: "acme.wakeup.register",
  outputs: (state) => ({ healthy: state.healthy === true }),
};
const wakeupOf = (
  overrides: Partial<WakeupSpec> & { writable?: boolean; references?: boolean; by?: boolean; to?: string } = {},
) =>
  defineResource({
    vendor: "acme",
    type: "wakeup",
    title: "Wakeup",
    identity: "name",
    schema: wakeupSchema,
    fields: {
      immutable: [],
      vendorOwned: [],
      writeOnly: [],
      ...(overrides.references !== false && {
        references: { host: { type: overrides.to ?? "acme.service", ...(overrides.by !== false && { by: ["url"] }) } },
      }),
    },
    find: ({ name }) => name,
    writable: overrides.writable ?? true,
    wakeup: { ...wakeup, ...overrides },
  });

const registration = z.object({ at: z.iso.datetime(), generation: z.number().int().nonnegative() });
const register = (input: z.ZodType = registration) =>
  defineConnector("acme", {
    wakeup: { register: { effect: "write", idempotent: true, input, output: z.object({}), target: () => "w" } },
  });

/** The resource types alone, without the wakeup's `register`. */
const acmeTypes = () => defineConnector("acme", { service, wakeup: wakeupOf() }, { package: "@acme/connector" });
/** The connector as its package would export it: the types, with `register` merged into the wakeup's group. */
const acmeWith = (ops = register()) => {
  const types = acmeTypes();
  return { ...types, wakeup: { ...types.wakeup, ...ops.wakeup } } as typeof types;
};

const IMPORT = 'import { acme } from "@acme/connector/resources";\n';
const SERVICE =
  'export const app = acme.service({ name: "app", repo: "https://example.com/a.git", branch: "main" });\n';
const configAt = (root: string, extra: Partial<SanomaConfig> = {}): SanomaConfig => ({
  workflows: [],
  connectors: [acmeWith()],
  root,
  databaseUrl: "postgresql://unused@localhost:1/unused",
  ...extra,
});

describe("a wakeup type", () => {
  it("meets the contract and keeps its wakeup", () => {
    expect(wakeupOf().wakeup).toMatchObject({ inputs: { host: "host" }, register: "acme.wakeup.register" });
  });

  it.each([
    ["one apply cannot change", { writable: false }, /it must be writable/],
    ["a host that names no field", { inputs: { host: "service" } }, /inputs\.host names no field \(service\)/],
    ["a host that is no reference", { references: false }, /inputs\.host must be a reference to the host/],
    [
      "a register outside its own group",
      { register: "acme.service.register" },
      /register must name an operation of its own group, acme\.wakeup\.<op> \(acme\.service\.register\)/,
    ],
    ["a register that is no id", { register: "register" }, /register must name an operation of its own group/],
    [
      "a register that is one of its resource operations",
      { register: "acme.wakeup.update" },
      /register must be an operation of its own, not the type's update/,
    ],
    ["a host that is not resolved by a field", { by: false }, /inputs\.host must be resolved `by` the field/],
    ["outputs that are not a function", { outputs: undefined as never }, /outputs must be a function of the state/],
  ])("is refused with %s", (_, overrides, message) => {
    expect(() => wakeupOf(overrides)).toThrow(message);
  });

  it("is refused on a host, which is stopped when its wake is due", () => {
    expect(() =>
      defineResource({
        vendor: "acme",
        type: "service",
        title: "Service",
        schema: service.schema,
        fields: { ...service.fields, references: { repo: { type: "acme.service", by: ["url"] } } },
        writable: true,
        host: service.host!,
        wakeup: { ...wakeup, inputs: { host: "repo" }, register: "acme.service.register" },
      }),
    ).toThrow(/a host cannot be its own wakeup/);
  });

  it("is refused by resolveConfig when its host reference names a type of the config that is no host", () => {
    const types = defineConnector("acme", { service, wakeup: wakeupOf({ to: "acme.wakeup" }) }, { package: "@acme/x" });
    const merged = { ...types, wakeup: { ...types.wakeup, ...register().wakeup } } as typeof types;
    expect(() => resolveConfig({ workflows: [], connectors: [merged] })).toThrow(
      "acme.wakeup: its wakeup's host may name acme.wakeup, which is no host",
    );
  });

  it("is refused by resolveConfig when its connector lacks its register, or that takes no { at, generation }", () => {
    expect(() => resolveConfig({ workflows: [], connectors: [acmeTypes()] })).toThrow(
      "acme.wakeup: its wakeup's register, acme.wakeup.register, is no operation of its connector",
    );
    expect(() =>
      resolveConfig({ workflows: [], connectors: [acmeWith(register(z.object({ when: z.string() })))] }),
    ).toThrow("acme.wakeup: its wakeup's register, acme.wakeup.register, must take { at, generation }");
    // One that strips them takes neither.
    expect(() => resolveConfig({ workflows: [], connectors: [acmeWith(register(z.object({})))] })).toThrow(
      /must take \{ at, generation \}/,
    );
    expect(resolveConfig({ workflows: [], connectors: [acmeWith()] }).ops.has("acme.wakeup.register")).toBe(true);
  });
});

describe("declaredWakeup", () => {
  it("is the one wakeup the data files declare, with its binding from the lockfile", async () => {
    const root = rootWith({
      "resources/infra.ts": `${IMPORT}${SERVICE}export const wake = acme.wakeup({ name: "wake", host: app });\n`,
      "resources/sanoma.lock.json": JSON.stringify({ "resources/infra.ts#wake": { type: "acme.wakeup", id: "W_1" } }),
    });
    const found = await declaredWakeup(configAt(root));
    expect(found).toMatchObject({
      id: "resources/infra.ts#wake",
      binding: "W_1",
      declared: { vendor: "acme", type: "wakeup", desired: { name: "wake", host: "app" } },
    });
    expect(found?.type.wakeup?.register).toBe("acme.wakeup.register");
    expect(describeConfig(configAt(root)).problems).toEqual([]);
  });

  it("is undefined with none, and with two, which the data files' problems name at each", async () => {
    expect(await declaredWakeup(configAt(rootWith({ "resources/infra.ts": `${IMPORT}${SERVICE}` })))).toBeUndefined();
    const root = rootWith({
      "resources/infra.ts": [
        IMPORT + SERVICE,
        'export const one = acme.wakeup({ name: "one", host: app });',
        'export const two = acme.wakeup({ name: "two", host: app });',
        "",
      ].join("\n"),
    });
    expect(await declaredWakeup(configAt(root))).toBeUndefined();
    expect(describeConfig(configAt(root)).problems).toEqual([
      {
        file: "resources/infra.ts",
        line: 4,
        column: 1,
        message: "an instance has one wakeup: leave out this one or resources/infra.ts#two",
      },
      {
        file: "resources/infra.ts",
        line: 5,
        column: 1,
        message: "an instance has one wakeup: leave out this one or resources/infra.ts#one",
      },
    ]);
  });
});

describe("startWorker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses to run the wakeup service with a wakeup of its own declared, before it connects", async () => {
    const root = rootWith({
      "resources/infra.ts": `${IMPORT}${SERVICE}export const wake = acme.wakeup({ name: "wake", host: app });\n`,
    });
    await expect(startWorker(configAt(root, { wakeup: true }))).rejects.toThrow(
      /^The config runs the wakeup service \(`wakeup: true`\) and declares a wakeup of its own/,
    );
  });

  it("warns once for each workflow on a schedule, which it does not run yet", async () => {
    const nightly = defineWorkflow({
      name: "nightly",
      trigger: { schedule: "0 3 * * *", timezone: "Europe/Amsterdam" },
      input: z.object({}),
      uses: [],
      run: async () => 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const worker = await startWorker({
      workflows: [nightly],
      connectors: [defineConnector("none", {})],
      databaseUrl: testDatabaseUrl("wakeup"),
    });
    await worker.stop();
    expect(warn.mock.calls.filter(([line]) => String(line).includes("on a schedule"))).toEqual([
      ["sanoma: the workflow nightly is on a schedule, which the worker does not run yet: start it by hand"],
    ]);
  });
});

describe("wakeGeneration", () => {
  it("reads a /wake request's generation in digits alone, and nothing else", () => {
    expect(wakeGeneration("http://h/wake?generation=0")).toBe(0);
    expect(wakeGeneration(new URL("http://h/wake?generation=42"))).toBe(42);
    for (const query of [
      "",
      "?generation=",
      "?generation=-1",
      "?generation=1.0",
      "?generation=0x10",
      "?generation=1e3",
    ]) {
      expect(wakeGeneration(`http://h/wake${query}`), query).toBeUndefined();
    }
    expect(wakeGeneration(`http://h/wake?generation=${"9".repeat(20)}`)).toBeUndefined();
  });
});
