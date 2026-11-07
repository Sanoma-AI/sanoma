import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type SandboxBackend } from "sanoma/workflows";
import { afterAll, describe, expect, it } from "vitest";
import { checkSandbox, fakeSandbox } from "../src/sandbox.ts";

// The sandbox conformance kit against the fake backend: boxes that are directories on this
// machine, their commands its children.

const sandbox = fakeSandbox();
afterAll(() => sandbox.remove());

describe("the sandbox conformance kit", () => {
  it("passes every check against a backend that snapshots and exposes ports", async () => {
    const results = await checkSandbox({ ...sandbox, image: "local", size: 1, timeoutMs: 10_000 });
    expect(results).toEqual([
      { name: "a box opens", ok: true },
      { name: "stdout arrives before the command exits", ok: true },
      { name: "stdin reaches cat", ok: true },
      { name: "a written file reads back, and runs with its mode", ok: true },
      { name: "a file and the home directory survive a stop and the next open", ok: true },
      { name: "an exposed port answers from outside the box", ok: true },
      { name: "a command killed mid-run exits non-zero", ok: true },
      { name: "discard leaves the next open empty", ok: true },
    ]);
    // It discards what it opened.
    expect(existsSync(join(sandbox.root, "sanoma-kit"))).toBe(false);
  });

  it("checks only what the backend declares, and fails the rest at once when no box opens", async () => {
    const broken: SandboxBackend = {
      open: async () => Promise.reject(new Error("no capacity")),
      discard: async () => undefined,
    };
    const results = await checkSandbox({
      backend: broken,
      capabilities: { snapshot: false, pause: false, port: false },
      image: "local",
      size: 1,
    });
    expect(results).toEqual([
      { name: "a box opens", ok: false, error: "no capacity" },
      { name: "stdout arrives before the command exits", ok: false, error: "no box opened" },
      { name: "stdin reaches cat", ok: false, error: "no box opened" },
      { name: "a written file reads back, and runs with its mode", ok: false, error: "no box opened" },
      { name: "a command killed mid-run exits non-zero", ok: false, error: "no box opened" },
      { name: "discard leaves the next open empty", ok: false, error: "no box opened" },
    ]);
  });
});

describe("fakeSandbox", () => {
  it("meets the contract in a config, its backend attached to its connector", () => {
    expect(() => resolveConfig({ workflows: [], connectors: [sandbox.connector] })).not.toThrow();
    expect(sandbox.type.sandbox).toMatchObject({
      capabilities: { snapshot: true, pause: false, port: true },
      inputs: { image: "image", size: "size" },
    });
    expect(sandbox.type.sandbox!.outputs({ name: "box" })).toEqual({ id: "box", healthy: true });
  });

  it("refuses a name that is not one path segment", async () => {
    await expect(sandbox.backend.open({ name: "../out", image: "local", size: 1 })).rejects.toThrow(/no box.s name/);
  });
});
