import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, defineResource, resolveConfig, type SandboxSpec } from "../src/index.ts";
import { loadDataFiles } from "../src/resources.ts";

// The `Sandbox` contract: what `defineResource` refuses of a sandbox type, and the declared
// sandboxes `ResolvedConfig.sandboxes()` finds, one at most.

const schema = z.object({ name: z.string(), image: z.string(), size: z.number(), region: z.string() });
const sandbox: SandboxSpec = {
  capabilities: { snapshot: true, pause: true, port: true },
  inputs: { image: "image", size: "size" },
  outputs: (state) => ({ id: String(state.id), healthy: state.status === "running" }),
};
type Overrides = Partial<SandboxSpec> & { writable?: boolean };
const instanceOf = ({ writable = true, ...overrides }: Overrides = {}) =>
  defineResource({
    vendor: "acme",
    type: "instance",
    title: "Instance",
    identity: "name",
    schema,
    fields: { immutable: ["region"], vendorOwned: [], writeOnly: [] },
    find: ({ name }) => name,
    writable,
    sandbox: { ...sandbox, ...overrides },
  });

describe("a sandbox type", () => {
  it("meets the contract and keeps its sandbox", () => {
    expect(instanceOf().sandbox).toMatchObject({
      capabilities: { snapshot: true, pause: true, port: true },
      inputs: { image: "image", size: "size" },
    });
  });

  it.each<[string, Overrides, RegExp]>([
    ["it is not writable", { writable: false }, /must be writable/],
    [
      "a capability is missing",
      { capabilities: { snapshot: true, pause: true } as SandboxSpec["capabilities"] },
      /capabilities\.port must be true or false/,
    ],
    ["the image names no field", { inputs: { image: "picture", size: "size" } }, /image names no field \(picture\)/],
    ["the size names no field", { inputs: { image: "image", size: "cpus" } }, /size names no field \(cpus\)/],
    ["outputs is not a function", { outputs: undefined as never }, /outputs must be a function/],
  ])("is refused when %s", (_why, overrides, message) => {
    expect(() => instanceOf(overrides)).toThrow(message);
    expect(() => instanceOf(overrides)).toThrow(/^acme\.instance: its sandbox: /);
  });
});

describe("ResolvedConfig.sandboxes", () => {
  it("gives the resource the data files declare whose type is a sandbox, read at each call, and none of several", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-sandboxes-"));
    try {
      writeFileSync(join(root, "package.json"), '{ "name": "sandboxes", "private": true, "type": "module" }\n');
      mkdirSync(join(root, "resources"));
      const acme = defineConnector("acme", { instance: instanceOf() }, { package: "@acme/connector" });
      const resolved = resolveConfig({ workflows: [], connectors: [acme], root });
      expect(await resolved.sandboxes()).toEqual([]);
      writeFileSync(
        join(root, "resources/infra.ts"),
        'import { acme } from "@acme/connector/resources";\nexport const box = acme.instance({ name: "box", image: "base", size: 2, region: "us" });\n',
      );
      expect(await resolved.sandboxes()).toMatchObject([
        {
          id: "resources/infra.ts#box",
          vendor: "acme",
          type: "instance",
          desired: { name: "box", image: "base", size: 2, region: "us" },
        },
      ]);
      expect(await resolved.hosts()).toEqual([]);
      // An instance opens its boxes in one sandbox: a second is a problem, and neither is used.
      writeFileSync(
        join(root, "resources/more.ts"),
        'import { acme } from "@acme/connector/resources";\nexport const other = acme.instance({ name: "other", image: "base", size: 2, region: "us" });\n',
      );
      expect(await resolved.sandboxes()).toEqual([]);
      expect(loadDataFiles(root, [acme]).problems.map((p) => p.message)).toEqual([
        "an instance has one sandbox: leave out this one or resources/more.ts#other",
        "an instance has one sandbox: leave out this one or resources/infra.ts#box",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
