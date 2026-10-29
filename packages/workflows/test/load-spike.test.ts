// The L0 spike for sanoma#473 (read by loading): the mechanism the loader builds on, proven on Node 26 inside vitest.
// Company files load synchronously through `require(esm)` and `module.registerHooks`; the loader lane turns this
// file into test/load.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callerFile, scriptPath } from "../src/define.ts";

const SCHEME = "sanoma-load:";
const QUERY = "sanoma-load";

interface Generation {
  virtual: Map<string, Record<string, unknown>>;
  made: { name: string; file: string | undefined; tag: string }[];
}
interface Registry {
  generations: Map<string, Generation>;
  hooked?: boolean;
}

const registry: Registry = ((globalThis as Record<symbol, unknown>)[Symbol.for("sanoma.load")] ??= {
  generations: new Map(),
}) as Registry;

/** The generation a module URL belongs to: the query on a company file, the first segment of a virtual one. */
function tagOf(url: string | undefined): string | null {
  if (url?.startsWith("file:")) return new URL(url).searchParams.get(QUERY);
  if (url?.startsWith(SCHEME)) return url.slice(SCHEME.length, url.indexOf("/"));
  return null;
}

if (!registry.hooked) {
  registry.hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(SCHEME)) return { url: specifier, shortCircuit: true };
      const tag = tagOf(context.parentURL);
      if (tag === null) return next(specifier, context);
      if (registry.generations.get(tag)?.virtual.has(specifier)) {
        return { url: `${SCHEME}${tag}/${specifier}`, shortCircuit: true };
      }
      const resolved = next(specifier, context);
      if (!resolved.url.startsWith("file:") || resolved.url.includes("/node_modules/")) return resolved;
      const url = new URL(resolved.url);
      url.searchParams.set(QUERY, tag);
      return { ...resolved, url: url.href };
    },
    load(url, context, next) {
      if (!url.startsWith(SCHEME)) return next(url, context);
      const tag = tagOf(url)!;
      const rest = url.slice(url.indexOf("/") + 1);
      // An entry: require() of a `file:` URL drops its query (the CJS loader caches by filename), so the tagged file
      // is imported from a virtual ES module, where the ESM loader keys by the whole URL.
      if (rest.startsWith("file:")) {
        const target = new URL(rest);
        target.searchParams.set(QUERY, tag);
        return { format: "module", source: `export * as ns from ${JSON.stringify(target.href)};`, shortCircuit: true };
      }
      const from = `globalThis[Symbol.for("sanoma.load")].generations.get(${JSON.stringify(tag)}).virtual.get(${JSON.stringify(rest)})`;
      const names = Object.keys(registry.generations.get(tag)!.virtual.get(rest)!);
      const source = [
        `const m = ${from};`,
        ...names.map(
          (name, i) => `const e${i} = m[${JSON.stringify(name)}]; export { e${i} as ${JSON.stringify(name)} };`,
        ),
      ].join("\n");
      return { format: "module", source, shortCircuit: true };
    },
  });
}

const require = createRequire(import.meta.url);
let seq = 0;

/** A new generation whose `sanoma/resources` records each declaration with the file that made it. */
function generation(): string {
  const tag = `spike-${++seq}`;
  const made: Generation["made"] = [];
  const repository = (name: string) => {
    const declared = { name, file: callerFile(), tag };
    made.push(declared);
    return declared;
  };
  registry.generations.set(tag, {
    virtual: new Map([["sanoma/resources", { repository, default: "D", "kebab-name": "K" }]]),
    made,
  });
  return tag;
}

const load = (tag: string, file: string) =>
  (require(`${SCHEME}${tag}/${pathToFileURL(file).href}`) as { ns: Record<string, unknown> }).ns;

/** What `run` throws; undefined when it returns. */
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

let root: string;
const at = (rel: string) => join(root, rel);
const write = (rel: string, text: string) => {
  mkdirSync(dirname(at(rel)), { recursive: true });
  writeFileSync(at(rel), text);
};

beforeAll(() => {
  // Real path: the ESM resolver realpaths children (macOS tmpdir is a symlink), so the entry must be real too.
  root = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-load-spike-")));
  write(
    "resources/helper.ts",
    `export const counter = { n: 0 };\nexport const where = (): string => import.meta.url;\n`,
  );
  write(
    "resources/github.ts",
    [
      `import { repository } from "sanoma/resources";`,
      `import { getCallSites } from "node:util";`,
      `import { counter, where } from "./helper.ts";`,
      `counter.n++;`,
      `type Name = string;`,
      `const name: Name = "site";`,
      `export const site = repository(name);`,
      `export const helperUrl = where();`,
      `export const selfUrl = import.meta.url;`,
      `export const script = getCallSites()[0]?.scriptName;`,
      `export const stack = new Error("here").stack;`,
      `export const count = counter.n;`,
      ``,
    ].join("\n"),
  );
  write("resources/default.ts", `import { repository } from "sanoma/resources";\nexport default repository("main");\n`);
  write(
    "resources/names.ts",
    `import fallback, { "kebab-name" as kebab } from "sanoma/resources";\nexport const both = [fallback, kebab];\n`,
  );
  write("resources/tla.ts", `await Promise.resolve();\nexport const x = 1;\n`);
  write("resources/throws.ts", `export const a = 1;\nthrow new Error("boom");\n`);
  write("resources/dependent.ts", `import { a } from "./throws.ts";\nexport const b = a + 1;\n`);
  write("resources/syntax.ts", `export const a = ;\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("loading company files synchronously (spike)", () => {
  it("requires an ES module .ts file, stripping its types", () => {
    const tag = generation();
    expect(load(tag, at("resources/github.ts")).site).toMatchObject({ name: "site", tag });
  });

  it("gives one instance per generation and a fresh one, helpers too, per new generation", () => {
    const one = generation();
    const a = load(one, at("resources/github.ts"));
    expect(load(one, at("resources/github.ts"))).toBe(a);
    const two = generation();
    const b = load(two, at("resources/github.ts"));
    expect(b).not.toBe(a);
    expect([a.count, b.count]).toEqual([1, 1]);
    expect(a.helperUrl).toBe(`${pathToFileURL(at("resources/helper.ts")).href}?${QUERY}=${one}`);
    expect(b.helperUrl).toBe(`${pathToFileURL(at("resources/helper.ts")).href}?${QUERY}=${two}`);
  });

  it("reads a helper edited between generations from disk", () => {
    write("resources/edited-helper.ts", `export const value = 1;\n`);
    write("resources/edited.ts", `export { value } from "./edited-helper.ts";\n`);
    expect(load(generation(), at("resources/edited.ts")).value).toBe(1);
    write("resources/edited-helper.ts", `export const value = 2;\n`);
    expect(load(generation(), at("resources/edited.ts")).value).toBe(2);
  });

  it("serves virtual constructors from the registry, by string names too", () => {
    const tag = generation();
    const { site } = load(tag, at("resources/github.ts"));
    expect(site).toBe(registry.generations.get(tag)!.made[0]);
    expect(load(tag, at("resources/default.ts")).default).toMatchObject({ name: "main" });
    expect(load(tag, at("resources/names.ts")).both).toEqual(["D", "K"]);
  });

  it("shows the tagged URL in call sites and stacks, so callerFile and scriptPath keep working", () => {
    const tag = generation();
    const file = at("resources/github.ts");
    const mod = load(tag, file);
    const tagged = `${pathToFileURL(file).href}?${QUERY}=${tag}`;
    expect(mod.selfUrl).toBe(tagged);
    expect(mod.script).toBe(tagged);
    expect(String(mod.stack).split("\n")[1]).toContain(`${tagged}:11:22`);
    expect(fileURLToPath(tagged)).toBe(file);
    expect(scriptPath(tagged)).toBe(file);
    expect(mod.site).toMatchObject({ file });
  });

  it("refuses top-level await with a catchable ERR_REQUIRE_ASYNC_MODULE", () => {
    expect(() => load(generation(), at("resources/tla.ts"))).toThrow(
      expect.objectContaining({ code: "ERR_REQUIRE_ASYNC_MODULE" }),
    );
  });

  it("places a thrown error at its file and line, and a dependent rethrows the same object", () => {
    const tag = generation();
    const thrown = caught(() => load(tag, at("resources/throws.ts")));
    expect(String((thrown as Error).stack)).toContain(`throws.ts?${QUERY}=${tag}:2:7`);
    expect(caught(() => load(tag, at("resources/dependent.ts")))).toBe(thrown);
  });

  it("reports a syntax error with the untagged path and line in its stack", () => {
    expect(() => load(generation(), at("resources/syntax.ts"))).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_TYPESCRIPT_SYNTAX",
        stack: expect.stringContaining(`${at("resources/syntax.ts")}:1`),
      }),
    );
  });
});
