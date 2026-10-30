import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectionIn } from "./collection.ts";
import { callerFile } from "./define.ts";
import { defineApp, defineSite } from "./definitions.ts";
import { type Connector, VENDOR } from "./op.ts";
import { APPS_DIR, appOfPath, DATA_ENTRIES, inside, relPath, SECRET_ENTRIES, SITE_ENTRIES } from "./paths.ts";
import { type Declared, isDeclared, isObject, joinPath, type Resource, resourceTypesOf } from "./resource.ts";
import { secret } from "./secret.ts";
import { errorMessage } from "./shared.ts";

// A company's files, loaded: synchronously (`require` of an ES module, Node's type stripping and
// `module.registerHooks`), since what reads them is (`describeConfig`, `readPeople`). Each load
// is a *generation*: its files are modules of their own (`file:…?sanoma-load=<id>`), so an edit
// is read once a new generation starts, and what they import from the runtime (constructors,
// `collection`, `defineSite`, `defineApp`) is served from the loader's own objects, which record
// where each value was made. A superseded generation's modules stay in Node's cache: each edit
// costs one copy of the files it read.

/** The scheme of the loader's own modules: an entry, `sanoma-load:<id>/<file URL>`, and a runtime module, `sanoma-load:<id>/<specifier>`. */
const SCHEME = "sanoma-load:";
/** The query that tags a company file with its generation: `file:///…/github.ts?sanoma-load=<id>`. */
const QUERY = "sanoma-load";

/** Where a value a company file made was made, by the constructor that made it. */
export interface Made {
  /** The file that called the constructor, relative to the root, with `/`: `resources/github.ts`. */
  file: string;
  /** Its place among everything its generation made, from 1: in each file, the order written. */
  seq: number;
  /**
   * Each declared resource its fields name, by the field's dotted path (a list item's with its
   * index, `teams.0`), as the constructor's `refs` names them.
   */
  refers: Record<string, Declared>;
}

/**
 * What loading a file gave: its exports, the values it made first in the order made, then the
 * rest by name, less any value another file loaded with it made and exports (a re-export); or
 * the error it threw, placed in the file (from 1, UTF-16 columns) when its stack says where; or,
 * when the error is another file's (a file it imports threw), that file, where it is reported.
 */
export type Loaded =
  | { exports: [name: string, value: unknown][] }
  | { error: unknown; line?: number; column?: number }
  | { failedIn: string };

/** A load of a company's files: its modules, the runtime's modules it serves them, and what each file's stamp was. */
interface Generation {
  id: string;
  /** Real (`realpathSync`): the ES module resolver gives real paths. */
  root: string;
  /** What it serves the runtime's modules for: its constructors' identities and packages. */
  typesKey: string;
  /** The runtime's modules it serves, by specifier: each module's exports. */
  virtual: Map<string, Record<string, unknown>>;
  /** Each company file it resolved or was asked for, and each one's directory, by its size and modification time. */
  stamps: Map<string, string>;
  /** Every value its files have made, in the order made. */
  made: object[];
  /** Each company file its files imported, directly or not, by its path relative to the root. */
  imported: Set<string>;
  /** What loading each file gave, by its path relative to the root: an entry's, or a file an error is placed in. */
  loaded: Map<string, Loaded>;
  /** Each error reported, to the file it is reported in. */
  reported: Map<unknown, string>;
  /** What each call returned, by its `only` (the generation itself for none) and then the paths: the same map while nothing changed. */
  answers: WeakMap<object, Map<string, Map<string, Loaded>>>;
}

/** The loader's state, one per process: two copies of this package share it (and one set of hooks). */
interface Registry {
  generations: Map<string, Generation>;
  seq: number;
  /** An id for each constructor object, for `typesKey`. */
  ids: WeakMap<object, number>;
  /** Where each value a company file made was made. */
  made: WeakMap<object, Made>;
  hooked?: boolean;
}

const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for("sanoma.load")] ??= {
  generations: new Map(),
  seq: 0,
  ids: new WeakMap(),
  made: new WeakMap(),
}) as Registry;

const require = createRequire(import.meta.url);

/** Where `value` was made, when a company file made it with a constructor the loader served. */
export const madeOf = (value: unknown): Made | undefined =>
  typeof value === "object" && value !== null ? registry.made.get(value) : undefined;

/** Where `defineApp` comes from, served only to an app's `app.ts`. */
const APP_ENTRIES: ReadonlySet<string> = new Set(["sanoma", "@sanoma-ai/workflows"]);

/**
 * Loads `paths` (absolute, under `root`) as the generation of `root` and the constructors of
 * `connectors` (`types`, by default theirs) has them, and says what each gave, by its path
 * relative to the root with `/`, sorted. The same generation, and the same answer for the same
 * paths, while no file it read, nor any file's directory, changed (by size and modification time:
 * one `stat` each); else a new one, so a caller may key what it makes of the answer by it (and
 * never changes it). `only` loads only the files whose text it passes; the answer is kept by its
 * identity, so pass one function, not a new one per call.
 *
 * Served to the files, by specifier: `sanoma/resources` and `@sanoma-ai/workflows/resources`
 * (`sanoma`, the constructors of the vendor `sanoma`, and `secret`); each connector's
 * `<info.package>/resources` (its vendor's constructors, under its id); `sanoma/data` and
 * `@sanoma-ai/workflows/data` (`collection`); `sanoma/site` and `@sanoma-ai/app/site`
 * (`defineSite`); and to an app's `apps/<app>/app.ts` alone, `sanoma` and `@sanoma-ai/workflows`
 * (`defineApp`). Anything else is resolved as Node does.
 */
export function loadModules(
  root: string,
  paths: readonly string[],
  connectors: readonly Connector<any, any>[],
  {
    only,
    types = resourceTypesOf(connectors),
  }: { only?: (text: string) => boolean; types?: ReadonlyMap<string, Resource> } = {},
): Map<string, Loaded> {
  // Nothing to load, and a root that may not be there yet (a company not made): nothing to resolve.
  if (!paths.length) return new Map();
  hook();
  const real = realpathSync(root);
  const gen = generationOf(real, connectors, types);
  const files = paths.map((path) => join(real, relative(root, path)));
  const byPaths = gen.answers.get(only ?? gen) ?? new Map<string, Map<string, Loaded>>();
  gen.answers.set(only ?? gen, byPaths);
  const key = files.join("\0");
  const answered = byPaths.get(key);
  if (answered) return answered;

  const answer = new Map<string, Loaded>();
  for (const file of files) {
    touch(gen, file);
    if (only && !only(readFileSync(file, "utf8"))) continue;
    const rel = relPath(gen.root, file);
    const loaded = loadOne(gen, file, rel);
    answer.set(rel, loaded);
    if ("failedIn" in loaded) answer.set(loaded.failedIn, gen.loaded.get(loaded.failedIn)!);
  }
  const result = new Map([...answer].toSorted(([a], [b]) => byOrder(a, b)));
  // A value made in one file and exported by another is listed at the file that made it.
  const owner = new Map<unknown, string>();
  for (const [rel, l] of result) {
    if (!("exports" in l)) continue;
    for (const [, value] of l.exports) if (madeOf(value)?.file === rel) owner.set(value, rel);
  }
  for (const [rel, l] of result) {
    if (!("exports" in l)) continue;
    const exports = l.exports
      .filter(([, value]) => (owner.get(value) ?? rel) === rel)
      .toSorted(([, a], [, b]) => byOrder(madeOf(a)?.seq ?? Infinity, madeOf(b)?.seq ?? Infinity));
    result.set(rel, { exports });
  }
  byPaths.set(key, result);
  answerGenerations.set(result, gen);
  return result;
}

/**
 * What `answer` (a `loadModules` answer) gave for `file`: its exports, or the error it threw (or a
 * helper it imports threw) as a problem on one line, at the file that threw it; undefined when the
 * answer does not have the file.
 */
export function exportsOf(
  answer: Map<string, Loaded>,
  file: string,
):
  | { exports: [name: string, value: unknown][] }
  | { problem: { file: string; line?: number; column?: number; message: string } }
  | undefined {
  const loaded = answer.get(file);
  if (loaded === undefined) return undefined;
  if ("failedIn" in loaded) return exportsOf(answer, loaded.failedIn);
  if ("exports" in loaded) return loaded;
  const { error, line, column } = loaded;
  const message = errorMessage(error).replaceAll(/\s*\n\s*/g, " ");
  return { problem: { file, ...(line !== undefined && { line, column: column ?? 1 }), message } };
}

/** The generation each answer is of. */
const answerGenerations = new WeakMap<Map<string, Loaded>, Generation>();

/** Every value the files of `answer` (a `loadModules` answer) made, exported or not, in the order made. */
export const madeWith = (answer: Map<string, Loaded>): object[] =>
  (answerGenerations.get(answer)?.made ?? []).filter((value) => answer.has(madeOf(value)!.file));

/**
 * The company files `answer` (a `loadModules` answer) was read from, by path relative to the root:
 * its files and every company file they import, directly or not (or that another answer of its
 * generation imported: never fewer).
 */
export const filesRead = (answer: Map<string, Loaded>): ReadonlySet<string> =>
  new Set([...answer.keys(), ...(answerGenerations.get(answer)?.imported ?? [])]);

/** One file of a generation, required once; an error placed at its own file, and reported there once. */
function loadOne(gen: Generation, file: string, rel: string): Loaded {
  const done = gen.loaded.get(rel);
  if (done) return done;
  let loaded: Loaded;
  try {
    const { ns } = require(`${SCHEME}${gen.id}/${pathToFileURL(file).href}`) as { ns: Record<string, unknown> };
    loaded = { exports: Object.entries(ns) };
  } catch (error) {
    // A file that imports one that threw throws the same object: reported once, where it was thrown.
    const at = typeof error === "object" ? gen.reported.get(error) : undefined;
    if (at !== undefined) loaded = { failedIn: at };
    else {
      const placed = placeOf(gen, error);
      // Never over a file that loaded (a stack cut short at `Error.stackTraceLimit`): then it is this file's.
      const there = placed && gen.loaded.get(placed.file);
      const { file: own = rel, line, column } = there && "exports" in there ? {} : (placed ?? {});
      if (typeof error === "object") gen.reported.set(error, own);
      const report = { error, ...(line !== undefined && { line }), ...(column !== undefined && { column }) };
      gen.loaded.set(own, report);
      loaded = own === rel ? report : { failedIn: own };
    }
  }
  gen.loaded.set(rel, loaded);
  return loaded;
}

/** A frame of a generation's company file in a stack: its URL, without the query, then the tag, line and column. */
const TAGGED_FRAME = new RegExp(`(file://[^\\s()?]*)\\?${QUERY}=([\\w-]+):(\\d+):(\\d+)`, "g");

/**
 * Where an error belongs: the last (outermost) frame of its stack in one of the generation's
 * files, the top level of the file that was running, not a helper it called in another file; for
 * a syntax error, the file and line its stack starts with (the caret's column); none for an error
 * thrown before any file ran (top-level `await`, an import Node cannot find).
 */
function placeOf(gen: Generation, error: unknown): { file: string; line?: number; column?: number } | undefined {
  const stack = isObject(error) && typeof error.stack === "string" ? error.stack : undefined;
  if (stack === undefined) return undefined;
  const frame = [...stack.matchAll(TAGGED_FRAME)].findLast(([, , tag]) => tag === gen.id);
  if (frame) {
    const [, url, , line, column] = frame;
    return { file: relPath(gen.root, fileURLToPath(url!)), line: Number(line), column: Number(column) };
  }
  // A syntax error's stack starts `<path or URL>:<line>`, then the source and a caret under the column.
  const [first = "", ...lines] = stack.split("\n");
  const syntax = /^(.+):(\d+)$/.exec(first);
  const path = syntax && (syntax[1]!.startsWith("file:") ? fileURLToPath(syntax[1]!) : syntax[1]!);
  if (syntax && path && isAbsolute(path) && inside(gen.root, path)) {
    const caret = lines.slice(0, lines.indexOf("")).findLast((line) => /^\s*\^+\s*$/.test(line));
    return { file: relPath(gen.root, path), line: Number(syntax[2]), ...(caret && { column: caret.indexOf("^") + 1 }) };
  }
  return undefined;
}

/**
 * Each company file under `root` a load has read, and each one's folder, with its stamp
 * (`stampOf`) as it was before the file was read: the latest generation's for a file several
 * read. Taken after a load, it still says what the load read, so a file changed while it read is
 * found changed after.
 */
export function stampsOf(root: string): Map<string, string> {
  const stamps = new Map<string, string>();
  if (!existsSync(root)) return stamps;
  const real = realpathSync(root);
  // In the order made: a later generation's stamp is the newer.
  for (const gen of registry.generations.values()) {
    if (gen.root === real) for (const [path, stamp] of gen.stamps) stamps.set(path, stamp);
  }
  return stamps;
}

const byOrder = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** A file's size and modification time, or that it is gone: what a generation keeps of each file it read. */
export function stampOf(path: string): string {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.size} ${stat.mtimeNs}` : "gone";
}

/** Records a file of the generation, and its directory, as they are now: before it is read, so an edit after is seen. */
function touch(gen: Generation, file: string) {
  for (const path of [file, dirname(file)]) if (!gen.stamps.has(path)) gen.stamps.set(path, stampOf(path));
}

/** The generation of `root` and these constructors: the current one while nothing it stamped changed, else a new one. */
function generationOf(
  root: string,
  connectors: readonly Connector<any, any>[],
  types: ReadonlyMap<string, Resource>,
): Generation {
  const packages = connectors.flatMap((c) => {
    const { id, info } = c[VENDOR];
    return info?.package ? [`${info.package}/resources`, id] : [];
  });
  const typesKey = [...packages, ...[...types.values()].map(idOf)].join(" ");
  for (const gen of registry.generations.values()) {
    if (gen.root !== root || gen.typesKey !== typesKey) continue;
    if ([...gen.stamps].every(([path, stamp]) => stampOf(path) === stamp)) return gen;
    registry.generations.delete(gen.id);
  }
  const gen: Generation = {
    id: String(++registry.seq),
    root,
    typesKey,
    virtual: new Map(),
    stamps: new Map(),
    made: [],
    imported: new Set(),
    loaded: new Map(),
    reported: new Map(),
    answers: new WeakMap(),
  };
  gen.virtual = runtimeModules(gen, connectors, types);
  registry.generations.set(gen.id, gen);
  return gen;
}

function idOf(object: object): number {
  let id = registry.ids.get(object);
  if (id === undefined) registry.ids.set(object, (id = ++registry.seq));
  return id;
}

/** The runtime's modules a generation serves its files, by specifier: each constructor wrapped to record where it was called. */
function runtimeModules(
  gen: Generation,
  connectors: readonly Connector<any, any>[],
  types: ReadonlyMap<string, Resource>,
): Map<string, Record<string, unknown>> {
  const byVendor = new Map<string, Record<string, unknown>>();
  for (const resource of types.values()) {
    const constructors = byVendor.get(resource.vendor) ?? {};
    // Frame 2 of `callerFile` is the wrapper's caller: the company file.
    constructors[resource.type] = (fields: unknown, options?: unknown) =>
      record(gen, callerFile(), (resource as (f: unknown, o: unknown) => Declared)(fields, options), refersIn(fields));
    byVendor.set(resource.vendor, constructors);
  }
  // A type the vendor does not declare is refused where it is called for, as `<vendor>.<type>`;
  // an object's own names (`toString`, `toJSON`) are not types, so printing the vendor still works.
  const constructorsOf = (vendor: string) =>
    new Proxy(byVendor.get(vendor) ?? {}, {
      get(target, key) {
        if (typeof key !== "string" || key in target || key === "toJSON") return Reflect.get(target, key);
        const known = Object.keys(target);
        throw new TypeError(`${vendor} has no resource type ${key}: its types are ${known.join(", ") || "none"}`);
      },
    });
  const modules = new Map<string, Record<string, unknown>>();
  for (const connector of connectors) {
    const { id, info } = connector[VENDOR];
    if (info?.package) modules.set(`${info.package}/resources`, { [id]: constructorsOf(id) });
  }
  for (const entry of SECRET_ENTRIES) modules.set(entry, { sanoma: constructorsOf("sanoma"), secret });
  const collection = (declaration: Parameters<typeof collectionIn>[1]) => {
    const file = callerFile();
    return record(
      gen,
      file,
      collectionIn(file === undefined ? undefined : appOfPath(relPath(gen.root, file)), declaration),
    );
  };
  for (const entry of DATA_ENTRIES) modules.set(entry, { collection });
  const site = (definition: Parameters<typeof defineSite>[0]) => record(gen, callerFile(), defineSite(definition));
  for (const entry of SITE_ENTRIES) modules.set(entry, { defineSite: site });
  const app = (definition: Parameters<typeof defineApp>[0]) => record(gen, callerFile(), defineApp(definition));
  for (const entry of APP_ENTRIES) modules.set(entry, { defineApp: app });
  return modules;
}

/** Records where `value` was made, and returns it. */
function record<T extends object>(gen: Generation, file: string | undefined, value: T, refers = {}): T {
  gen.made.push(value);
  registry.made.set(value, { file: file === undefined ? "" : relPath(gen.root, file), seq: gen.made.length, refers });
  return value;
}

/** Each declared resource in a constructor's fields, by its dotted path, as the constructor walks them. */
function refersIn(value: unknown, at = "", into: Record<string, Declared> = {}): Record<string, Declared> {
  if (isDeclared(value)) into[at] = value;
  else if (Array.isArray(value)) value.forEach((item, i) => refersIn(item, joinPath(at, String(i)), into));
  else if (isObject(value))
    for (const [field, item] of Object.entries(value)) refersIn(item, joinPath(at, field), into);
  return into;
}

/** True for an app's `apps/<app>/app.ts`, by URL. */
const isAppFile = (gen: Generation, url: string) => {
  const [top, app, file, ...rest] = relPath(gen.root, fileURLToPath(url)).split("/");
  return top === APPS_DIR && app !== undefined && file === "app.ts" && !rest.length;
};

/** The generation a module URL belongs to: the query on a company file's, the first segment of the loader's own. */
function tagOf(url: string | undefined): string | null {
  if (url?.startsWith("file:")) return new URL(url).searchParams.get(QUERY);
  if (url?.startsWith(SCHEME)) return url.slice(SCHEME.length, url.indexOf("/"));
  return null;
}

/**
 * Registers the loader's hooks, once per process (the registry's flag, for two copies of the
 * package). A file of a generation resolves the runtime's modules to the generation's, and each
 * company file (under the root, outside `node_modules`) to itself tagged with the generation,
 * recorded and stamped; an entry is a module exporting the tagged file's namespace as `ns`, since
 * `require` of a `file:` URL drops its query (the CommonJS loader keys by file name).
 */
function hook() {
  if (registry.hooked) return;
  registry.hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(SCHEME)) return { url: specifier, shortCircuit: true };
      const tag = tagOf(context.parentURL);
      const gen = tag === null ? undefined : registry.generations.get(tag);
      if (gen === undefined) return next(specifier, context);
      if (
        gen.virtual.has(specifier) &&
        (!APP_ENTRIES.has(specifier) || (context.parentURL!.startsWith("file:") && isAppFile(gen, context.parentURL!)))
      ) {
        return { url: `${SCHEME}${gen.id}/${specifier}`, shortCircuit: true };
      }
      const resolved = next(specifier, context);
      if (!resolved.url.startsWith("file:")) return resolved;
      const url = new URL(resolved.url);
      const file = fileURLToPath(url);
      if (!inside(gen.root, file) || file.split(sep).includes("node_modules")) return resolved;
      touch(gen, file);
      gen.imported.add(relPath(gen.root, file));
      url.searchParams.set(QUERY, gen.id);
      return { ...resolved, url: url.href };
    },
    load(url, context, next) {
      if (!url.startsWith(SCHEME)) return next(url, context);
      const tag = tagOf(url)!;
      const rest = url.slice(url.indexOf("/") + 1);
      if (rest.startsWith("file:")) {
        const target = new URL(rest);
        target.searchParams.set(QUERY, tag);
        return { format: "module", source: `export * as ns from ${JSON.stringify(target.href)};`, shortCircuit: true };
      }
      // Read from the registry by the module itself, so a company file gets the generation's own objects.
      const from = `globalThis[Symbol.for("sanoma.load")].generations.get(${JSON.stringify(tag)}).virtual.get(${JSON.stringify(rest)})`;
      const names = Object.keys(registry.generations.get(tag)?.virtual.get(rest) ?? {});
      const source = [
        `const m = ${from};`,
        ...names.map(
          (name, i) => `const e${i} = m[${JSON.stringify(name)}];\nexport { e${i} as ${JSON.stringify(name)} };`,
        ),
      ].join("\n");
      return { format: "module", source, shortCircuit: true };
    },
  });
}
