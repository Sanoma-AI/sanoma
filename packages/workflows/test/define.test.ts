import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineWorkflow } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

describe("defineWorkflow", () => {
  it("records the file that called it", () => {
    expect(announce.file).toBe(fileURLToPath(new URL("./fixtures/announce.ts", import.meta.url)));
    expect(defineWorkflow({ ...announce, name: "here" }).file).toBe(fileURLToPath(import.meta.url));
  });

  it("refuses a definition from code with no file, which could not be outlined", () => {
    // Code made with the Function constructor has no script name.
    const define = new Function("defineWorkflow", "def", "return defineWorkflow(def)") as (
      d: typeof defineWorkflow,
      def: unknown,
    ) => unknown;
    expect(() => define(defineWorkflow, { ...announce, name: "nowhere" })).toThrow(
      /^Workflow "nowhere" was defined from code with no file .*: its outline is read from the file/,
    );
  });
});
