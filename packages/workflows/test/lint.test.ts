import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../src/lint.ts";

const messages = (src: string) => lintWorkflow(src).map((p) => p.message);

describe("lintWorkflow", () => {
  it("passes the example workflow", () => {
    const src = readFileSync(new URL("../../../examples/marketing/workflows/announce.ts", import.meta.url), "utf8");
    expect(lintWorkflow(src)).toEqual([]);
  });

  it("refuses the clock, randomness and the network, naming the ctx replacement", () => {
    const problems = messages(`
      export const run = async (ctx) => {
        const t = Date.now();
        const r = Math.random();
        await fetch("https://example.com");
        setTimeout(() => {}, 10);
        const key = process.env.KEY;
      };
    `);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/Date .*ctx\.now/);
    expect(problems[1]).toMatch(/Math\.random/);
    expect(problems[2]).toMatch(/fetch .*connector operation/);
    expect(problems[3]).toMatch(/setTimeout .*ctx\.sleep/);
    expect(problems[4]).toMatch(/process .*workflow input/);
  });

  it("refuses imports outside @sanoma and workflow files, and dynamic imports", () => {
    const problems = messages(`
      import axios from "axios";
      import { x } from "node:fs";
      import { ok } from "@sanoma/workflows";
      import { other } from "./other.ts";
      const m = await import("./lazy.ts");
    `);
    expect(problems).toEqual([
      expect.stringMatching(/import "axios"/),
      expect.stringMatching(/import "node:fs"/),
      expect.stringMatching(/dynamic import/),
    ]);
  });

  it("allows property names and local bindings that share a forbidden name", () => {
    expect(
      messages(`
        const process = { step: 1 };
        const o = { Date: 1, fetch: 2 };
        const v = o.Date + o.fetch + process.step;
        type T = { crypto: string };
      `),
    ).toEqual([]);
  });
});
