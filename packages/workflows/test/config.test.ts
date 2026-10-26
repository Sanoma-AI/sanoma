import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { github } from "@sanoma-ai/connector-github";
import { resend } from "@sanoma-ai/connector-resend";
import { stripe } from "@sanoma-ai/connector-stripe";
import { customProvider } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  changeOps,
  type Connector,
  defineSteps,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
  withSetup,
} from "../src/index.ts";
import { setupOf, VENDOR } from "../src/op.ts";
import announce from "./fixtures/announce.ts";
import { tree } from "./tree.ts";

// The packages' connectors, as a company's config names them: the setup is theirs.
const config = (options: Partial<SanomaConfig> = {}): SanomaConfig => ({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  ledger: memoryLedger(),
  ...options,
});

/** A driver maker other than the package's. */
const driver = () => ({ vendor: "ghost", ops: {} });
/** A login half's maker, which signs no one in. */
const login = () => ({ verify: async () => null, handle: async () => undefined });
const model = () => customProvider({});

describe("each connector package's root", () => {
  it.each([
    ["ghost", ghost],
    ["resend", resend],
    ["bluesky", bluesky],
    ["github", github],
    ["stripe", stripe],
  ] as [string, Connector<any, any>][])("%s carries the makers of its driver and of its fake", (vendor, c) => {
    const setup = setupOf(c);
    expect(setup.driver!().vendor).toBe(vendor);
    const [one, two] = [setup.fake!(), setup.fake!()];
    expect(one.driver.vendor).toBe(vendor);
    expect(two).not.toBe(one);
    // On its vendor record: keys and values see the connector's resources only.
    expect(Object.keys(c)).not.toContain("setup");
  });

  it("is kept on a copy, which declares the same operations", () => {
    const copy = { ...ghost };
    expect(setupOf(copy)).toBe(setupOf(ghost));
    expect(copy.post.create).toBe(ghost.post.create);
  });

  it("takes another driver over the one it carries, and keeps its fake and its steps", () => {
    const swapped = withSetup(ghost, { driver });
    expect(setupOf(swapped)).toEqual({ driver, fake: setupOf(ghost).fake, steps: setupOf(ghost).steps });
    expect(setupOf(ghost).driver).not.toBe(driver);
    expect(swapped.post.create).toBe(ghost.post.create);
  });
});

describe("a connector made by another copy of the package", () => {
  // Two copies load in one process when a connector's peer resolves into a sanoma checkout and
  // the app's comes from its tarball (a partial `pnpm link`).
  it("is read by a second instance of the module: its driver and its fake", async () => {
    vi.resetModules();
    const other = await import("../src/index.ts");
    expect(other.resolveConfig).not.toBe(resolveConfig);
    // The connectors were made by this file's instance; the other reads them.
    const resolved = other.resolveConfig(config());
    expect(resolved.driversByVendor.get("ghost")?.vendor).toBe("ghost");
    expect(resolved.fakes.get("ghost")!().driver.vendor).toBe("ghost");
    expect(resolved.ops.has("ghost.post.publish")).toBe(true);
  });

  it("is refused, saying so, when another build made it in another shape", () => {
    const build = "install the sanoma packages and connectors from one build";
    const later = { ...ghost, [VENDOR]: { ...ghost[VENDOR], format: 2 } } as unknown as Connector<any, any>;
    expect(() => resolveConfig(config({ connectors: [later] }))).toThrow(
      `The "ghost" connector was made by another build of @sanoma-ai/workflows: ${build}`,
    );
    // An older build's, its record under an unregistered symbol, is not a connector here at all.
    const older = { [Symbol("sanoma.vendor")]: { id: "ghost" } } as unknown as Connector<any, any>;
    expect(() => resolveConfig(config({ connectors: [older] }))).toThrow(
      `\`connectors\` holds something that is not a connector: list what the connector packages export (or one from an older build: ${build})`,
    );
  });
});

describe("resolveConfig on the connectors' setups", () => {
  it("makes each vendor's driver once, and keeps the makers of the fakes, in the connectors' order", () => {
    const resolved = resolveConfig(config());
    expect([...resolved.driversByVendor.keys()]).toEqual(["ghost", "resend", "bluesky"]);
    expect([...resolved.drivers.keys()].toSorted()).toEqual([...resolved.ops.keys()].toSorted());
    expect([...resolved.fakes]).toEqual([ghost, resend, bluesky].map((c) => [c[VENDOR].id, setupOf(c).fake]));
    // Their steps for scenarios, once each, then the config's own.
    expect(resolved.steps).toEqual([ghost, resend, bluesky].map((c) => setupOf(c).steps));
    const own = defineSteps("acme", () => {});
    const connectors = [ghost, { ...ghost }, resend, bluesky];
    expect(resolveConfig(config({ connectors, steps: [own] })).steps).toEqual([...resolved.steps, own]);
    // Another resolution makes its own drivers.
    expect(resolveConfig(config()).driversByVendor.get("ghost")).not.toBe(resolved.driversByVendor.get("ghost"));
  });

  it("takes one maker for copies of one connector, and refuses two for one vendor", () => {
    expect([
      ...resolveConfig(config({ connectors: [ghost, { ...ghost }, resend, bluesky] })).driversByVendor.keys(),
    ]).toEqual(["ghost", "resend", "bluesky"]);
    expect(() => resolveConfig(config({ connectors: [ghost, withSetup(ghost, { driver })] }))).toThrow(
      'Two connectors in `connectors` attach a driver for "ghost"; keep one per vendor',
    );
    expect(() => resolveConfig(config({ connectors: [ghost, withSetup(ghost, { fake: () => fakeGhost() })] }))).toThrow(
      'Two connectors in `connectors` attach a fake for "ghost"; keep one per vendor',
    );
  });

  it("keeps the makers of the login halves by vendor, one per vendor", () => {
    const signsIn = withSetup(resend, { login });
    expect([...resolveConfig(config({ connectors: [ghost, signsIn, { ...signsIn }, bluesky] })).logins]).toEqual([
      ["resend", login],
    ]);
    expect(resolveConfig(config()).logins.size).toBe(0);
    expect(() =>
      resolveConfig(config({ connectors: [ghost, signsIn, withSetup(resend, { login: () => login() }), bluesky] })),
    ).toThrow('Two connectors in `connectors` attach a login for "resend"; keep one per vendor');
  });

  it("keeps the makers of the model halves by vendor, as it keeps the login halves", () => {
    const answers = withSetup(resend, { model });
    expect([...resolveConfig(config({ connectors: [ghost, answers, { ...answers }, bluesky] })).models]).toEqual([
      ["resend", model],
    ]);
    expect(resolveConfig(config()).models.size).toBe(0);
    expect(() =>
      resolveConfig(config({ connectors: [ghost, answers, withSetup(resend, { model: () => model() }), bluesky] })),
    ).toThrow('Two connectors in `connectors` attach a model for "resend"; keep one per vendor');
  });

  it("refuses a workflow using an operation whose connector attaches no driver", () => {
    const bare = { ...ghost, [VENDOR]: { ...ghost[VENDOR], setup: { fake: fakeGhost } } };
    expect(() => resolveConfig(config({ connectors: [bare, resend, bluesky] }))).toThrow(
      "`ghost.post.create` has no driver: the connector package must attach one",
    );
  });
});

describe("a change's operations, built in", () => {
  it("are in every config, with no connector, each with the placeholder driver", async () => {
    const resolved = resolveConfig({ workflows: [], connectors: [] });
    const ids = ["sanoma.change.open", "sanoma.change.review", "sanoma.change.merge", "sanoma.change.close"];
    expect([...resolved.ops.keys()]).toEqual(ids);
    expect(ids.map((id) => resolved.ops.get(id)!.effect)).toEqual(["write", "write", "write", "write"]);
    expect(resolved.ops.get("sanoma.change.merge")!.target!({ id: "c1" })).toBe("change:c1");
    await expect(resolved.drivers.get("sanoma.change.merge")!({}, {} as never)).rejects.toThrow("not built");
    // Not a vendor with credentials to set.
    expect(resolved.driversByVendor.size).toBe(0);
  });

  it("refuses a company workflow that calls one, and one named change", () => {
    const merging = defineWorkflow({
      name: "merging",
      trigger: "manual",
      input: z.object({}),
      uses: [changeOps.change.merge],
      run: async () => 1,
    });
    expect(() => resolveConfig(config({ workflows: [merging] }))).toThrow(
      'Workflow "merging": sanoma.change.merge changes the company\'s repository, which only change does: send a draft for review instead',
    );
    const named = defineWorkflow({
      name: "change",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: async () => 1,
    });
    expect(() => resolveConfig(config({ workflows: [named] }))).toThrow(
      'A workflow is named "change", the name of a built-in workflow',
    );
  });
});

describe("resolveConfig's conventions", () => {
  it("finds the scenarios in scenarios/ in the root, when it is a directory", () => {
    const root = tree("with-scenarios", { "scenarios/a.feature": "Feature: A\n" });
    expect(resolveConfig(config({ root })).scenarios).toEqual(pathToFileURL(`${join(root, "scenarios")}/`));
    expect(resolveConfig(config({ root: tree("without-scenarios") })).scenarios).toBeUndefined();
    expect(resolveConfig(config({ root: tree("scenarios-file", { scenarios: "" }) })).scenarios).toBeUndefined();
    expect(resolveConfig(config()).scenarios).toBeUndefined();
  });

  it("names the app from the root's own package.json, kept whole", () => {
    const named = tree("named", { "package.json": JSON.stringify({ name: "@acme/ops" }) });
    expect(resolveConfig(config({ root: named })).appName).toBe("@acme/ops");
    expect(resolveConfig(config({ root: named })).queueName).toBe("sanoma:@acme/ops");
    expect(resolveConfig(config({ root: named })).version).toMatch(/^@acme\/ops@[0-9a-f]{64}$/);
    // Its file's directory when it has no root.
    expect(resolveConfig(config({ file: join(named, "sanoma.config.ts") })).appName).toBe("@acme/ops");
  });

  it("names the app sanoma when the root's package.json names none, never taking a name from above", () => {
    expect(resolveConfig(config({ root: tree("nameless", { "package.json": "{}" }) })).appName).toBe("sanoma");
    // A directory below a named one, with no package.json or one naming nothing: the parent's name does not leak in.
    expect(resolveConfig(config({ root: tree("named-parent/child") })).appName).toBe("sanoma");
    tree("named-parent", { "package.json": JSON.stringify({ name: "parent" }) });
    expect(resolveConfig(config({ root: tree("named-parent/child") })).appName).toBe("sanoma");
    const unnamed = tree("named-parent/unnamed", { "package.json": JSON.stringify({ private: true }) });
    expect(resolveConfig(config({ root: unnamed })).appName).toBe("sanoma");
    expect(resolveConfig(config()).appName).toBe("sanoma");
  });

  it("refuses a package.json that is not JSON, naming it", () => {
    const root = tree("broken", { "package.json": "{ name: " });
    expect(() => resolveConfig(config({ root }))).toThrow(`${join(root, "package.json")} is not JSON`);
  });
});
