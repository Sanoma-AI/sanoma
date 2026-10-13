import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { github } from "@sanoma/connector-github";
import { resend } from "@sanoma/connector-resend";
import { stripe } from "@sanoma/connector-stripe";
import { testRoot } from "@sanoma/testing";
import { afterAll, describe, expect, it } from "vitest";
import { allowAll, type Connector, memoryLedger, resolveConfig, type SanomaConfig, withSetup } from "../src/index.ts";
import { setupOf, VENDOR } from "../src/op.ts";
import announce from "./fixtures/announce.ts";

// The packages' connectors, as a company's config names them: the setup is theirs.
const config = (options: Partial<SanomaConfig> = {}): SanomaConfig => ({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  policy: allowAll,
  ledger: memoryLedger(),
  ...options,
});

const dir = mkdtempSync(join(tmpdir(), "sanoma-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A directory under `dir`, made with `files` (relative path to text) in it. */
function tree(name: string, files: Record<string, string> = {}): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

/** A driver maker other than the package's. */
const driver = () => ({ vendor: "ghost", ops: {} });

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

  it("takes another driver over the one it carries, and keeps its fake", () => {
    const swapped = withSetup(ghost, { driver });
    expect(setupOf(swapped)).toEqual({ driver, fake: setupOf(ghost).fake });
    expect(setupOf(ghost).driver).not.toBe(driver);
    expect(swapped.post.create).toBe(ghost.post.create);
  });
});

describe("resolveConfig on the connectors' setups", () => {
  it("makes each vendor's driver once, and keeps the makers of the fakes, in the connectors' order", () => {
    const resolved = resolveConfig(config());
    expect([...resolved.driversByVendor.keys()]).toEqual(["ghost", "resend", "bluesky"]);
    expect([...resolved.drivers.keys()].toSorted()).toEqual([...resolved.ops.keys()].toSorted());
    expect([...resolved.fakes]).toEqual([ghost, resend, bluesky].map((c) => [c[VENDOR].id, setupOf(c).fake]));
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

  it("refuses a workflow using an operation whose connector attaches no driver", () => {
    const bare = { ...ghost, [VENDOR]: { ...ghost[VENDOR], setup: { fake: fakeGhost } } };
    expect(() => resolveConfig(config({ connectors: [bare, resend, bluesky] }))).toThrow(
      "`ghost.post.create` has no driver: the connector package must attach one",
    );
  });
});

describe("resolveConfig's conventions", () => {
  it("finds the scenarios in scenarios/ in the root, when there is one", () => {
    const root = tree("with-scenarios", { "scenarios/a.feature": "Feature: A\n" });
    expect(resolveConfig(config({ root })).scenarios).toEqual(pathToFileURL(`${join(root, "scenarios")}/`));
    expect(resolveConfig(config({ root: tree("without-scenarios") })).scenarios).toBeUndefined();
    expect(resolveConfig(config()).scenarios).toBeUndefined();
  });

  it("names the app from the nearest package.json at or above the root that has a name, kept whole", () => {
    const named = tree("named", { "package.json": JSON.stringify({ name: "@acme/ops" }) });
    expect(resolveConfig(config({ root: named })).appName).toBe("@acme/ops");
    expect(resolveConfig(config({ root: named })).queueName).toBe("sanoma:@acme/ops");
    // A nested directory, and one whose package.json names nothing, take the name above.
    const nested = tree("named/workspace/deep", { "../package.json": JSON.stringify({ private: true }) });
    expect(resolveConfig(config({ root: nested })).appName).toBe("@acme/ops");
    // Its file's directory when it has no root.
    expect(resolveConfig(config({ file: join(named, "sanoma.config.ts") })).appName).toBe("@acme/ops");
    expect(resolveConfig(config({ root: testRoot("acme") })).version).toMatch(/^acme@[0-9a-f]{64}$/);
  });

  it("names the app sanoma when no package.json names it, or the config has no root", () => {
    // Nothing above the temporary directory is a package.
    expect(resolveConfig(config({ root: tree("nameless", { "package.json": "{}" }) })).appName).toBe("sanoma");
    expect(resolveConfig(config()).appName).toBe("sanoma");
  });

  it("refuses a package.json that is not JSON, naming it", () => {
    const root = tree("broken", { "package.json": "{ name: " });
    expect(() => resolveConfig(config({ root }))).toThrow(`${join(root, "package.json")} is not JSON`);
  });
});
