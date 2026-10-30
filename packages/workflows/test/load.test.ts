// The loader (`src/load.ts`): a company's files loaded synchronously, one generation per state of
// its files, with the runtime's modules served from the loader's own objects. Fixtures are written
// to a fresh directory per test, with no `node_modules`: nothing they import from the runtime is
// installed.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isCollection } from "../src/collection.ts";
import { defineConnector, defineResource } from "../src/index.ts";
import { type Loaded, loadModules, madeOf } from "../src/load.ts";
import { peopleConnector } from "../src/person.ts";

// A connector whose package does not exist: the loader serves `@acme/connector/resources` itself.
const widget = defineResource({
  vendor: "acme",
  type: "widget",
  title: "Widget",
  identity: "name",
  schema: z.object({ name: z.string(), parts: z.array(z.string()).nullish() }),
  fields: { immutable: [], vendorOwned: [], writeOnly: [], references: { parts: { type: "acme.widget" } } },
  find: ({ name }) => name,
});
const acme = defineConnector("acme", { widget }, { package: "@acme/connector" });
const CONNECTORS = [acme, peopleConnector];
const ACME = `import { acme } from "@acme/connector/resources";\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A company with these files, at a real path (macOS's tmpdir is a symlink). */
function company(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-load-")));
  roots.push(root);
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** Loads these files of `root`, by their paths relative to it. */
const load = (root: string, rels: string[], options?: Parameters<typeof loadModules>[3]) =>
  loadModules(
    root,
    rels.map((rel) => join(root, rel)),
    CONNECTORS,
    options,
  );

/** A file's exports, which it must have loaded. */
function exportsOf(loaded: Map<string, Loaded>, rel: string): Record<string, unknown> {
  const l = loaded.get(rel);
  if (!l || !("exports" in l)) throw new Error(`${rel} did not load: ${JSON.stringify(l)}`);
  return Object.fromEntries(l.exports);
}

const namesOf = (loaded: Map<string, Loaded>, rel: string) => Object.keys(exportsOf(loaded, rel));

describe("loadModules", () => {
  it("loads each file, its made values first in the order made, and says where each was made", () => {
    const root = company({
      "resources/b.ts": `${ACME}type Name = string;\nconst name: Name = "zed";\nexport const zed = acme.widget({ name });\nexport const alpha = acme.widget({ name: "alpha", parts: [zed] });\nexport const NOTE = "a note";\n`,
      "resources/a.ts": `${ACME}export const solo = acme.widget({ name: "solo" });\n`,
    });
    const loaded = load(root, ["resources/b.ts", "resources/a.ts"]);
    expect([...loaded.keys()]).toEqual(["resources/a.ts", "resources/b.ts"]);
    expect(namesOf(loaded, "resources/b.ts")).toEqual(["zed", "alpha", "NOTE"]);
    const { zed, alpha } = exportsOf(loaded, "resources/b.ts");
    expect(alpha).toMatchObject({ vendor: "acme", type: "widget", name: "alpha", desired: { parts: ["zed"] } });
    expect(madeOf(zed)).toEqual({ file: "resources/b.ts", seq: 1, refers: {} });
    expect(madeOf(alpha)).toEqual({ file: "resources/b.ts", seq: 2, refers: { "parts.0": zed } });
    expect(madeOf(exportsOf(loaded, "resources/a.ts").solo)).toMatchObject({ file: "resources/a.ts", seq: 3 });
    expect(madeOf("a note")).toBeUndefined();
  });

  it("serves the runtime's modules by every name, defineApp only to an app's app.ts", () => {
    const root = company({
      "resources/people.ts": `import { sanoma, secret } from "sanoma/resources";\nexport const ada = sanoma.person({ id: "ada", name: "Ada" });\nexport const token = secret("TOKEN");\n`,
      "resources/team.ts": `import { sanoma } from "@sanoma-ai/workflows/resources";\nimport { ada } from "./people.ts";\nexport const team = sanoma.group({ name: "team", members: [ada] });\n`,
      "resources/data.ts": `import { collection } from "sanoma/data";\nexport const leads = collection({ name: "leads", key: "email", fields: { email: "text" } });\n`,
      "apps/crm/resources/data.ts": `import { collection } from "@sanoma-ai/workflows/data";\nexport const contacts = collection({ name: "contacts", key: "email", fields: { email: "text" } });\n`,
      "apps/crm/app.ts": `import { defineApp } from "sanoma";\nexport default defineApp({ source: "https://github.com/acme/crm" });\n`,
      "apps/shop/app.ts": `import { defineApp } from "@sanoma-ai/workflows";\nexport default defineApp({});\n`,
      "sites/help/site.ts": `import { defineSite } from "sanoma/site";\nexport default defineSite({ title: "Help" });\n`,
      "sites/www/site.ts": `import { defineSite } from "@sanoma-ai/app/site";\nexport default defineSite({ public: true, locales: ["en", "fr"] });\n`,
      "resources/not-an-app.ts": `import { defineApp } from "sanoma";\nexport default defineApp({});\n`,
    });
    const loaded = load(root, [
      "resources/people.ts",
      "resources/team.ts",
      "resources/data.ts",
      "apps/crm/resources/data.ts",
      "apps/crm/app.ts",
      "apps/shop/app.ts",
      "sites/help/site.ts",
      "sites/www/site.ts",
      "resources/not-an-app.ts",
    ]);
    const { ada, token } = exportsOf(loaded, "resources/people.ts");
    expect(ada).toMatchObject({ vendor: "sanoma", type: "person", name: "ada" });
    expect(token).toEqual({ $secret: "TOKEN" });
    const { team } = exportsOf(loaded, "resources/team.ts");
    expect(madeOf(team)).toMatchObject({ file: "resources/team.ts", refers: { "members.0": ada } });
    // An app's collection is named with its app, as the runtime names it.
    const { leads } = exportsOf(loaded, "resources/data.ts");
    const { contacts } = exportsOf(loaded, "apps/crm/resources/data.ts");
    expect([isCollection(leads), isCollection(contacts)]).toEqual([true, true]);
    expect([(leads as { name: string }).name, (contacts as { name: string }).name]).toEqual(["leads", "crm.contacts"]);
    expect(madeOf(contacts)).toMatchObject({ file: "apps/crm/resources/data.ts" });
    expect(exportsOf(loaded, "apps/crm/app.ts").default).toEqual({ source: "https://github.com/acme/crm" });
    expect(madeOf(exportsOf(loaded, "apps/shop/app.ts").default)).toMatchObject({ file: "apps/shop/app.ts" });
    expect(exportsOf(loaded, "sites/help/site.ts").default).toEqual({ title: "Help" });
    expect(exportsOf(loaded, "sites/www/site.ts").default).toEqual({ public: true, locales: ["en", "fr"] });
    // Anywhere else, `sanoma` is the package, which this company has not installed.
    expect(loaded.get("resources/not-an-app.ts")).toEqual({
      error: expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }),
    });
  });

  it("keeps a generation while nothing changed, and starts one when a file or a helper does", () => {
    const root = company({
      "resources/helper.ts": `export const size = 1;\n`,
      "resources/a.ts": `${ACME}import { size } from "./helper.ts";\nexport const a = acme.widget({ name: "a" });\nexport const n = size;\n`,
      "lib/far.ts": `export const far = "far";\n`,
      "resources/b.ts": `${ACME}import { far } from "../lib/far.ts";\nexport const b = acme.widget({ name: far });\n`,
    });
    const files = ["resources/a.ts", "resources/b.ts"];
    const first = load(root, files);
    expect(load(root, files)).toBe(first);
    expect(exportsOf(load(root, ["resources/a.ts"]), "resources/a.ts").a).toBe(exportsOf(first, "resources/a.ts").a);

    // A helper outside the data files' folder, edited: a new generation reads it from disk.
    write(root, { "lib/far.ts": `export const far = "farther";\n` });
    const second = load(root, files);
    expect(second).not.toBe(first);
    expect(exportsOf(second, "resources/b.ts").b).toMatchObject({ name: "farther" });
    expect(exportsOf(second, "resources/a.ts").a).not.toBe(exportsOf(first, "resources/a.ts").a);
    expect(exportsOf(second, "resources/a.ts").n).toBe(1);

    write(root, { "resources/helper.ts": `export const size = 22;\n` });
    expect(exportsOf(load(root, files), "resources/a.ts").n).toBe(22);
  });

  it("loads only the files whose text `only` passes", () => {
    const root = company({
      "resources/people.ts": `import { sanoma } from "sanoma/resources";\nexport const ada = sanoma.person({ id: "ada", name: "Ada" });\n`,
      "resources/a.ts": `${ACME}export const a = acme.widget({ name: "a" });\n`,
    });
    const loaded = load(root, ["resources/a.ts", "resources/people.ts"], { only: (text) => text.includes("sanoma") });
    expect([...loaded.keys()]).toEqual(["resources/people.ts"]);
  });

  it("lists a value at the file that made it, and leaves out its re-exports elsewhere", () => {
    const root = company({
      "resources/a.ts": `${ACME}export const a = acme.widget({ name: "a" });\nexport default a;\n`,
      "resources/b.ts": `export { a, a as again } from "./a.ts";\nexport const b = 1;\n`,
    });
    const loaded = load(root, ["resources/a.ts", "resources/b.ts"]);
    // Two names in its own file are both listed: which one declares it is the reader's to say.
    expect(namesOf(loaded, "resources/a.ts")).toEqual(["a", "default"]);
    expect(namesOf(loaded, "resources/b.ts")).toEqual(["b"]);
  });

  it("places an error at the file and line that threw it, and reports it once", () => {
    const root = company({
      "resources/dependent.ts": `import { a } from "./throws.ts";\nexport const b = a + 1;\n`,
      "resources/throws.ts": `export const a = 1;\nthrow new Error("boom");\n`,
      "resources/refused.ts": `${ACME}export const fine = acme.widget({ name: "fine" });\nexport const bad = acme.widget({ name: 1 as never });\n`,
      "resources/uses-lib.ts": `import { x } from "../lib/broken.ts";\nexport const y = x;\n`,
      "lib/broken.ts": `export const x = 1;\n\nthrow new Error("lib");\n`,
    });
    const loaded = load(root, [
      "resources/dependent.ts",
      "resources/refused.ts",
      "resources/throws.ts",
      "resources/uses-lib.ts",
    ]);
    expect(Object.fromEntries(loaded)).toEqual({
      // A file that imports one that threw rethrows its error: reported where it was thrown.
      "resources/dependent.ts": { failedIn: "resources/throws.ts" },
      "resources/throws.ts": { error: expect.objectContaining({ message: "boom" }), line: 2, column: 7 },
      // A constructor's refusal, at its call (V8 places a method's call at its name).
      "resources/refused.ts": {
        error: expect.objectContaining({ message: expect.stringContaining("acme.widget") }),
        line: 3,
        column: 25,
      },
      // A helper outside the files asked for is listed when it threw.
      "lib/broken.ts": { error: expect.objectContaining({ message: "lib" }), line: 3, column: 7 },
      "resources/uses-lib.ts": { failedIn: "lib/broken.ts" },
    });
  });

  it("places an error a helper throws at the file whose top level called it, keeping the helper's file", () => {
    const root = company({
      "resources/lib.ts": `${ACME}export const make = (name: unknown) => acme.widget({ name } as never);\nexport const good = make("good");\n`,
      "resources/bad.ts": `import { make } from "./lib.ts";\n\nexport const bad = make(1);\n`,
    });
    const loaded = load(root, ["resources/bad.ts", "resources/lib.ts"]);
    expect(loaded.get("resources/bad.ts")).toEqual({
      error: expect.objectContaining({ message: expect.stringContaining("acme.widget") }),
      line: 3,
      column: 20,
    });
    expect(Object.keys(exportsOf(loaded, "resources/lib.ts"))).toEqual(["good", "make"]);
  });

  it("places a syntax error at its line and column", () => {
    const root = company({ "resources/syntax.ts": `export const a = 1;\nexport const b = ;\n` });
    expect(load(root, ["resources/syntax.ts"]).get("resources/syntax.ts")).toEqual({
      error: expect.objectContaining({ code: "ERR_INVALID_TYPESCRIPT_SYNTAX" }),
      line: 2,
      column: 18,
    });
  });

  it("refuses top-level await, at the file asked for", () => {
    const root = company({
      "resources/helper.ts": `await Promise.resolve();\nexport const x = 1;\n`,
      "resources/a.ts": `import { x } from "./helper.ts";\nexport const a = x;\n`,
    });
    expect(load(root, ["resources/a.ts"]).get("resources/a.ts")).toEqual({
      error: expect.objectContaining({ code: "ERR_REQUIRE_ASYNC_MODULE" }),
    });
  });
});

describe("two copies of the package", () => {
  it("share one registry and one set of hooks", async () => {
    vi.resetModules();
    const other = await import("../src/load.ts");
    expect(other.loadModules).not.toBe(loadModules);
    const root = company({ "resources/a.ts": `${ACME}export const a = acme.widget({ name: "a" });\n` });
    const loaded = other.loadModules(root, [join(root, "resources/a.ts")], CONNECTORS);
    const { a } = exportsOf(loaded, "resources/a.ts");
    // What the other copy's constructors made, this copy reads where it was made.
    expect(madeOf(a)).toEqual(other.madeOf(a));
    expect(madeOf(a)).toMatchObject({ file: "resources/a.ts" });
    // And this copy loads the same generation.
    expect(load(root, ["resources/a.ts"])).toBe(loaded);
  });
});
