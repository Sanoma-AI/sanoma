import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

describe("defineWorkflow", () => {
  it("records the file that called it", () => {
    const wf = defineWorkflow({
      name: "here",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: async () => undefined,
    });
    expect(wf.file).toBe(fileURLToPath(import.meta.url));
    expect(announce.file).toMatch(/test\/fixtures\/announce\.ts$/);
  });
});
