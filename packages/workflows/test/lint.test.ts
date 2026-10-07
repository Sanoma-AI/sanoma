import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../src/lint.ts";

const messages = (src: string) => lintWorkflow(src).map((p) => p.message);

describe("lintWorkflow", () => {
  it("passes the example workflow", () => {
    const src = readFileSync(new URL("./fixtures/announce.ts", import.meta.url), "utf8");
    expect(lintWorkflow(src)).toEqual([]);
  });

  it("checks policy files the same way, since policies are replayed too", () => {
    const policy = `
      import { allow, definePolicy, deny } from "@sanoma/workflows";
      export default definePolicy(({ effect }) => {
        const hour = new Date(Date.now()).getUTCHours();
        return effect === "send" && hour < 9 ? deny("no email before 9") : allow();
      });
    `;
    expect(lintWorkflow(policy, "policy.ts")).toEqual([
      expect.objectContaining({ line: 4, message: expect.stringMatching(/^Date .*ctx\.now/) }),
      expect.objectContaining({ line: 4, message: expect.stringMatching(/^Date /) }),
    ]);
    expect(
      lintWorkflow(`
        import { allow, approve, definePolicy } from "@sanoma/workflows";
        export default definePolicy(({ effect, run }) =>
          effect === "publish" && !run.approvals.some((a) => a.approver === "lead") ? approve("lead") : allow(),
        );
      `),
    ).toEqual([]);
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

  it("refuses the runtime's client and worker, which a workflow could use to approve itself", () => {
    expect(
      messages(`
        import { defineWorkflow, SanomaClient } from "@sanoma/workflows";
        import { startWorker as go } from "@sanoma/workflows";
        export { SanomaClient as C } from "@sanoma/workflows";
      `),
    ).toEqual([
      expect.stringMatching(/^SanomaClient is not allowed in a workflow: .*decide approvals/),
      expect.stringMatching(/^startWorker is not allowed in a workflow/),
      expect.stringMatching(/^SanomaClient is not allowed in a workflow/),
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
