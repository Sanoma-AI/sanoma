import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { locator, parse } from "./ast.ts";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import { type DataFile, type DataFileExport, type DataValue, readDataFile, Reference } from "./datafile.ts";
import { type Connector, VENDOR } from "./op.ts";
import type { Resource } from "./resource.ts";

/** A resource a data file declares, as read from the file without running it. */
export interface DeclaredResource {
  /** `<file>#<export>`: `identity/github.ts#site`. */
  id: string;
  vendor: string;
  type: string;
  /** Its import id: what the type's `find` makes of its fields. */
  name: string;
  /** The data file, relative to its resources directory, with `/`: `identity/github.ts`. */
  file: string;
  /** Its `export const` statement, as UTF-16 offsets into the file's text. */
  span: { start: number; end: number };
  /** The line its `export const` starts on, from 1. */
  line: number;
  /** Its fields as declared, with each name of another declared resource as `{ ref: "<id>" }`. */
  desired: Record<string, unknown>;
}

/** A data file's reference to another declared resource, by its id, in a `DeclaredResource`'s `desired`. */
export interface ResourceRef {
  ref: string;
}

/**
 * Reads the resources the config's data files declare (`resources`, default `resources/`), without
 * importing or running them: each `.ts` file under the directories but `*.test.ts` and `*.d.ts`,
 * parsed with oxc and held to the data-file subset (`readDataFile`). A constructor
 * (`github.repository`) is found among the resource types of the config's `connectors`, never by
 * importing the connector; its fields are checked by calling the resource type, as running the
 * file would, with each name of another resource standing for that resource's `name`.
 *
 * Throws one error listing every problem, each at `file:line:column`: anything outside the
 * subset, an import or constructor the config does not know, a value the type refuses, a
 * reference cycle, and two resources of one type with one name.
 */
export function readResources(config: SanomaConfig): DeclaredResource[] {
  return readResourceDirs(resolveConfig(config).resources, config.connectors);
}

interface FileEntry {
  path: string;
  /** Relative to its resources directory, with `/`. */
  rel: string;
  /** Lines and columns of the file's offsets. */
  at: (offset: number) => { line: number; column: number };
  data: DataFile;
}

interface Problem {
  file: Pick<FileEntry, "path" | "at">;
  start: number;
  message: string;
}

/** `readResources` over resolved directories and the config's connectors. */
export function readResourceDirs(
  dirs: readonly string[],
  connectors: readonly Connector<any, any>[],
): DeclaredResource[] {
  const problems: Problem[] = [];
  const files = new Map<string, FileEntry>();
  const byRel = new Map<string, string>();
  for (const dir of dirs) {
    const found = (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
      .filter((f) => !f.split(sep).includes("node_modules"))
      .toSorted();
    for (const f of found) {
      const path = join(dir, f);
      const rel = f.split(sep).join("/");
      const source = readFileSync(path, "utf8");
      const { program, errors } = parse(path, source);
      const file = { path, rel, at: locator(source), data: readDataFile(program, path, dir) };
      for (const e of errors) {
        problems.push({ file, start: e.labels?.[0]?.start ?? 0, message: `syntax: ${e.message}` });
      }
      for (const p of file.data.problems) problems.push({ file, start: p.start, message: p.message });
      const other = byRel.get(rel);
      if (other !== undefined) {
        problems.push({
          file,
          start: 0,
          message: `${rel} is also a data file in ${dirname(other)}: ids would clash; rename one`,
        });
      }
      byRel.set(rel, path);
      files.set(path, file);
    }
  }

  // Every resource type the connectors declare, by vendor, and each vendor's constructors entry.
  const types = new Map<string, Map<string, Resource>>();
  const packages = new Map<string, string>();
  for (const connector of connectors) {
    const { id, info, resources } = connector[VENDOR];
    const vendor = types.get(id) ?? new Map<string, Resource>();
    for (const r of resources as readonly Resource[]) vendor.set(r.type, r);
    types.set(id, vendor);
    if (info?.package && !packages.has(info.package)) packages.set(info.package, id);
  }
  const vendorOf = (spec: string) => {
    const pkg = spec.slice(0, -"/resources".length);
    return packages.get(pkg) ?? /^@sanoma\/connector-([a-z0-9-]+)$/.exec(pkg)?.[1];
  };

  /** What each file's top-level names stand for: a vendor's types, or a resource id. */
  const bindings = new Map<string, Map<string, { vendor: string } | { id: string }>>();
  for (const file of files.values()) {
    const names = new Map<string, { vendor: string } | { id: string }>();
    const at = (start: number, message: string) => problems.push({ file, start, message });
    for (const imp of file.data.imports) {
      if (imp.kind === "constructors") {
        const vendor = vendorOf(imp.source);
        if (vendor === undefined || !types.has(vendor)) {
          at(
            imp.start,
            `"${imp.source}" is not the resources entry of a connector in the config's \`connectors\`: add the connector`,
          );
        } else if (imp.imported !== vendor) {
          at(
            imp.start,
            `"${imp.source}" exports its constructors as ${vendor}: \`import { ${vendor} } from "${imp.source}"\``,
          );
        } else {
          names.set(imp.local, { vendor });
        }
        continue;
      }
      const target = resolve(dirname(file.path), imp.source);
      const other = files.get(target);
      if (!other) {
        at(imp.start, `"${imp.source}" is not a data file in the config's \`resources\` directories`);
      } else if (!other.data.declared.includes(imp.imported)) {
        at(imp.start, `${imp.imported} is not a resource ${other.rel} declares`);
      } else if (other.data.exports.some((e) => e.name === imp.imported)) {
        names.set(imp.local, { id: `${other.rel}#${imp.imported}` });
      }
      // Else its value was refused, and reported in its file: a reference to it fails quietly.
    }
    for (const e of file.data.exports) names.set(e.name, { id: `${file.rel}#${e.name}` });
    bindings.set(file.path, names);
  }

  const declarations = new Map<string, { file: FileEntry; exp: DataFileExport }>();
  for (const file of files.values()) {
    for (const exp of file.data.exports) declarations.set(`${file.rel}#${exp.name}`, { file, exp });
  }

  // Each resource after the ones it names, so a reference can stand for their `name`.
  const done = new Map<string, DeclaredResource | undefined>();
  const visiting: string[] = [];
  function declare(id: string): DeclaredResource | undefined {
    if (done.has(id)) return done.get(id);
    const { file, exp } = declarations.get(id)!;
    const at = (start: number, message: string) => problems.push({ file, start, message });
    if (visiting.includes(id)) {
      at(exp.start, `${id} refers to itself: ${[...visiting.slice(visiting.indexOf(id)), id].join(" → ")}`);
      return undefined;
    }
    visiting.push(id);
    const result = build(file, exp, id, at);
    visiting.pop();
    done.set(id, result);
    return result;
  }

  function build(
    file: FileEntry,
    exp: DataFileExport,
    id: string,
    at: (start: number, message: string) => void,
  ): DeclaredResource | undefined {
    const names = bindings.get(file.path)!;
    const constructors = names.get(exp.vendor);
    // An unknown vendor import was reported with the import.
    if (!constructors || !("vendor" in constructors)) return undefined;
    const vendor = constructors.vendor;
    const resource = types.get(vendor)!.get(exp.type);
    if (!resource) {
      at(
        exp.start,
        `${vendor} has no resource type ${exp.type}: its types are ${[...types.get(vendor)!.keys()].join(", ")}`,
      );
      return undefined;
    }
    let ok = true;
    const refs = new Map<Reference, { id: string; name: string }>();
    const walk = (v: DataValue): void => {
      if (v instanceof Reference) {
        const bound = names.get(v.name);
        // An import that did not resolve was reported with the import.
        if (!bound || !("id" in bound)) return void (ok = false);
        const target = declare(bound.id);
        if (!target) return void (ok = false);
        refs.set(v, { id: bound.id, name: target.name });
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(exp.desired);
    if (!ok) return undefined;
    const map = (v: DataValue, to: (ref: { id: string; name: string }) => unknown): unknown =>
      v instanceof Reference
        ? to(refs.get(v)!)
        : Array.isArray(v)
          ? v.map((item) => map(item, to))
          : v !== null && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, map(item, to)]))
            : v;
    // Checked as running the file would check it: by the resource type, a reference standing for its name.
    let name: string;
    try {
      name = resource(map(exp.desired, (r) => r.name) as never).name;
    } catch (e) {
      // One line per problem: zod's own spans lines.
      at(exp.start, `export const ${exp.name}: ${(e as Error).message.replaceAll(/\s*\n\s*/g, " ")}`);
      return undefined;
    }
    return {
      id,
      vendor,
      type: exp.type,
      name,
      file: file.rel,
      span: { start: exp.start, end: exp.end },
      line: file.at(exp.start).line,
      desired: map(exp.desired, (r): ResourceRef => ({ ref: r.id })) as Record<string, unknown>,
    };
  }

  const out: DeclaredResource[] = [];
  const named = new Map<string, string>();
  for (const id of declarations.keys()) {
    const r = declare(id);
    if (!r) continue;
    const key = `${r.vendor}.${r.type} ${JSON.stringify(r.name)}`;
    const first = named.get(key);
    if (first !== undefined) {
      const { file, exp } = declarations.get(id)!;
      problems.push({
        file,
        start: exp.start,
        message: `${key} is declared twice, also as ${first}: declare each resource once, and import it where it is used`,
      });
      continue;
    }
    named.set(key, id);
    out.push(r);
  }

  if (problems.length) {
    const lines = problems
      .map((p) => ({ ...p, ...p.file.at(p.start) }))
      .toSorted((a, b) => a.file.path.localeCompare(b.file.path) || a.line - b.line || a.column - b.column)
      .map((p) => `  ${relative(process.cwd(), p.file.path)}:${p.line}:${p.column}: ${p.message}`);
    throw new Error(`The resources' data files have problems:\n${lines.join("\n")}`);
  }
  return out;
}
