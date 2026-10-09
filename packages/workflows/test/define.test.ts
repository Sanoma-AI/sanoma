import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineWorkflow } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

describe("defineWorkflow", () => {
  it("records the file that called it", () => {
    expect(announce.file).toBe(fileURLToPath(new URL("./fixtures/announce.ts", import.meta.url)));
    expect(defineWorkflow({ ...announce, name: "here" }).file).toBe(fileURLToPath(import.meta.url));
  });
});
