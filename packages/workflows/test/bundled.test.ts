import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readPolicyFiles } from "../src/cedar.ts";
import { BUNDLED_FILE } from "../src/bundled.ts";
import { defineConfig, defineWorkflow, readRootSnapshot, resolveConfig, useRootSnapshot } from "../src/index.ts";
import { readPeople } from "../src/resources.ts";

// What a bundle (the Cloudflare host's Worker) carries in place of the root's files: a root's
// snapshot, read beside its files and registered for it, and the file each company module says it is.
const root = mkdtempSync(join(tmpdir(), "sanoma-bundled-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hello = defineWorkflow({
  name: "hello",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => "hi",
});
const POLICY =
  'permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:hello", resource);';

describe("useRootSnapshot", () => {
  it("answers the root's app name, versions, policies and people from the snapshot, reading no file", () => {
    const config = defineConfig({ workflows: [hello], connectors: [], root });
    // As the container reads them, from the files (none here), then the bundle's own.
    const read = readRootSnapshot(config);
    expect(read).toMatchObject({ appName: "sanoma", policies: [], people: { people: [], problems: [] } });
    const people = { people: [], problems: [{ file: "resources/people.ts", message: "a problem" }] } as never;
    useRootSnapshot(root, {
      appName: "acme",
      version: "acme@from-the-container",
      changeCode: "code-from-the-container",
      policies: [{ file: "policies/visitors.cedar", text: POLICY }],
      people,
    });
    const resolved = resolveConfig(config);
    expect(resolved).toMatchObject({
      appName: "acme",
      queueName: "sanoma:acme",
      version: "acme@from-the-container",
      changeCode: "code-from-the-container",
    });
    expect(readPolicyFiles(root)).toEqual([{ file: "policies/visitors.cedar", text: POLICY }]);
    expect(readPeople(root)).toBe(people);
  });
});

describe("a bundled company file", () => {
  it("is a workflow's file where V8's call sites name none", () => {
    const at = join(root, "workflows", "greet.ts");
    (globalThis as Record<symbol, unknown>)[BUNDLED_FILE] = at;
    try {
      // Code with no script name, as a bundle's module is on workerd.
      const define = new Function(
        "defineWorkflow",
        "z",
        'return defineWorkflow({ name: "greet", trigger: "manual", input: z.object({}), uses: [], run: async () => 1 });',
      );
      expect((define(defineWorkflow, z) as { file: string }).file).toBe(at);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[BUNDLED_FILE];
    }
  });
});
