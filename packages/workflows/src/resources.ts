import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parsed } from "./ast.ts";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import { type DataFile, type DataFileExport, type DataValue, readDataFile, Reference } from "./datafile.ts";
import { type Connector, VENDOR } from "./op.ts";
import type { Span } from "./outline.ts";
import type { Declared, Resource } from "./resource.ts";

/** A resource a data file declares, as read from the file without running it. */
export interface DeclaredResource {
  /** `<file>#<export>`, the file relative to the config's root, with `/`: `resources/identity/github.ts#website`. */
  id: string;
  vendor: string;
  type: string;
  /** Its import id: what the type's `find` makes of its fields. */
  name: string;
  /** Its `export const` statement, as UTF-16 offsets into the file's text. */
  span: Span;
  /** Its fields, as its type checked them: each resource it names as that resource's `name`. */
  desired: Record<string, unknown>;
  /**
   * Where it names another declared resource: the field's dotted path (a list item's with its
   * index, `teams.0`) to that resource's id.
   */
  refs: Record<string, string>;
}

/** Something wrong in the data files, or in finding them. */
export interface ResourceProblem {
  /**
   * The data file, relative to the config's root, with `/`: `resources/identity/github.ts`.
   * Absent, with `line` and `column`, when the problem is the config's: it has no root.
   */
  file?: string;
  /** From 1. */
  line?: number;
  /** From 1, in UTF-16 code units. */
  column?: number;
  message: string;
}

/** What the data files declare: each resource read without problems, and the problems. */
export interface DataFiles {
  /** By file and then in file order, less any with a problem, and any that names one. */
  resources: DeclaredResource[];
  /** By file, line and column. */
  problems: ResourceProblem[];
}

/**
 * The resources the config's data files declare, read without importing or running them; throws
 * one error listing every problem, each at `file:line:column`, for a test or CI to fail on.
 * `describeConfig` lists the same, with the problems beside them instead.
 */
export function readResources(config: SanomaConfig): DeclaredResource[] {
  const { resources, problems } = readDataFiles(resolveConfig(config).root, config.connectors);
  if (problems.length) {
    const lines = problems.map((p) => `  ${p.file ? `${p.file}:${p.line}:${p.column}: ` : ""}${p.message}`);
    throw new Error(`The resources' data files have problems:\n${lines.join("\n")}`);
  }
  return resources;
}

/** Every resource type the connectors declare, by `<vendor>.<type>`. */
export function resourceTypesOf(connectors: readonly Connector<any, any>[]): Map<string, Resource> {
  const types = new Map<string, Resource>();
  for (const connector of connectors) {
    for (const r of connector[VENDOR].resources as readonly Resource[]) types.set(`${r.vendor}.${r.type}`, r);
  }
  return types;
}

interface FileEntry {
  /** Relative to the config's root, with `/`. */
  rel: string;
  data: DataFile;
  /** Records a problem at an offset into the file. */
  problem: (offset: number, message: string) => void;
}

/**
 * Reads `resources/` under `root`, the config's directory: each `.ts` file in it but
 * `*.test.ts`, `*.d.ts` and `node_modules`, parsed with oxc and held to the data-file subset
 * (`readDataFile`). A constructor import (`@sanoma/connector-github/resources`) is matched to the
 * connector whose `info.package` it names, never imported; each resource is checked by calling
 * its type, as running the file would, with each resource it names given as that resource.
 *
 * Problems: anything outside the subset, a constructor or data file the config does not know, a
 * type the connector does not declare, a value the type refuses (a reference where its type
 * takes none among them), a reference cycle, and two resources of one type with one name.
 */
export function readDataFiles(
  root: string | undefined,
  connectors: readonly Connector<any, any>[],
  types: ReadonlyMap<string, Resource> = resourceTypesOf(connectors),
): DataFiles {
  const problems: ResourceProblem[] = [];
  if (root === undefined) {
    problems.push({
      message:
        "The config has no root, so its data files cannot be found: make it with defineConfig, which records its file, or set its `root`",
    });
    return { resources: [], problems };
  }

  const files = new Map<string, FileEntry>();
  for (const path of dataFilesUnder(join(root, "resources"))) {
    const rel = relative(root, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    const { program, problems: syntax, at } = parsed(source, path);
    const data = readDataFile(program, path, join(root, "resources"));
    const problem = (offset: number, message: string) => problems.push({ file: rel, ...at(offset), message });
    for (const p of syntax) problems.push({ file: rel, ...p });
    for (const p of data.problems) problem(p.start, p.message);
    files.set(path, { rel, data, problem });
  }

  // Each connector's constructors entry, `<info.package>/resources`, to its vendor.
  const entries = new Map<string, string>();
  for (const connector of connectors) {
    const { id, info } = connector[VENDOR];
    if (info?.package) entries.set(`${info.package}/resources`, id);
  }

  // What each file's names stand for, and every resource read by its id.
  const vendors = new Map<FileEntry, Map<string, string>>();
  const named = new Map<FileEntry, Map<string, string>>();
  const declarations = new Map<string, { file: FileEntry; exp: DataFileExport }>();
  for (const [path, file] of files) {
    const fileVendors = new Map<string, string>();
    const fileNamed = new Map<string, string>();
    for (const imp of file.data.imports) {
      if (imp.kind === "constructors") {
        const vendor = entries.get(imp.source);
        if (vendor === undefined) {
          file.problem(
            imp.start,
            `"${imp.source}" is not the resources entry of a connector in the config's \`connectors\`: add the connector, and import from its package's \`/resources\``,
          );
        } else if (imp.imported !== vendor) {
          file.problem(
            imp.start,
            `"${imp.source}" exports its constructors as ${vendor}: \`import { ${vendor} } from "${imp.source}"\``,
          );
        } else {
          fileVendors.set(imp.local, vendor);
        }
        continue;
      }
      const other = files.get(resolve(dirname(path), imp.source));
      if (!other) {
        file.problem(imp.start, `"${imp.source}" is not a data file under resources/`);
      } else if (!other.data.declared.includes(imp.imported)) {
        file.problem(imp.start, `${imp.imported} is not a resource ${other.rel} declares`);
      } else if (other.data.exports.some((e) => e.name === imp.imported)) {
        fileNamed.set(imp.local, `${other.rel}#${imp.imported}`);
      }
      // Else its value was refused, and reported in its file: a reference to it fails quietly.
    }
    for (const exp of file.data.exports) {
      const id = `${file.rel}#${exp.name}`;
      fileNamed.set(exp.name, id);
      declarations.set(id, { file, exp });
    }
    vendors.set(file, fileVendors);
    named.set(file, fileNamed);
  }

  // Each resource after the ones it names, which it is given as they are declared.
  const done = new Map<string, { declared: Declared; refs: Record<string, string> } | undefined>();
  const visiting: string[] = [];
  const byName = new Map<string, string>();
  function declare(id: string) {
    if (done.has(id)) return done.get(id);
    const { file, exp } = declarations.get(id)!;
    if (visiting.includes(id)) {
      file.problem(exp.start, `${id} refers to itself: ${[...visiting.slice(visiting.indexOf(id)), id].join(" → ")}`);
      return undefined;
    }
    visiting.push(id);
    const result = build(file, exp);
    visiting.pop();
    if (result) {
      const { vendor, type, name } = result.declared;
      const key = `${vendor}.${type} ${JSON.stringify(name)}`;
      const first = byName.get(key);
      if (first === undefined) byName.set(key, id);
      else {
        file.problem(
          exp.start,
          `${key} is declared twice, also as ${first}: declare each resource once, and import it where it is used`,
        );
        done.set(id, undefined);
        return undefined;
      }
    }
    done.set(id, result);
    return result;
  }

  function build(file: FileEntry, exp: DataFileExport) {
    // An unknown constructors import was reported with the import.
    const vendor = vendors.get(file)!.get(exp.vendor);
    if (vendor === undefined) return undefined;
    const resource = types.get(`${vendor}.${exp.type}`);
    if (!resource) {
      const known = [...types.values()].filter((r) => r.vendor === vendor).map((r) => r.type);
      file.problem(exp.start, `${vendor} has no resource type ${exp.type}: its types are ${known.join(", ")}`);
      return undefined;
    }
    const refs: Record<string, string> = {};
    let ok = true;
    // The fields with each name of a resource as that resource, and where each is named.
    const given = (v: DataValue, at: string): unknown => {
      if (v instanceof Reference) {
        // A name that did not resolve was reported where it is bound.
        const target = named.get(file)!.get(v.name);
        const declared = target === undefined ? undefined : declare(target)?.declared;
        if (!declared) ok = false;
        else refs[at] = target!;
        return declared;
      }
      if (Array.isArray(v)) return v.map((item, i) => given(item, `${at}.${i}`));
      if (v === null || typeof v !== "object") return v;
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, given(item, at ? `${at}.${k}` : k)]));
    };
    const fields = given(exp.desired, "");
    if (!ok) return undefined;
    try {
      // Checked as running the file would: by the resource type, which allows a resource only where its `fields.references` say.
      return { declared: resource(fields as never), refs };
    } catch (e) {
      // One line per problem: zod's own spans lines.
      file.problem(exp.start, `export const ${exp.name}: ${(e as Error).message.replaceAll(/\s*\n\s*/g, " ")}`);
      return undefined;
    }
  }

  const resources: DeclaredResource[] = [];
  for (const [id, { exp }] of declarations) {
    const result = declare(id);
    if (!result) continue;
    const { vendor, type, name, desired } = result.declared;
    resources.push({ id, vendor, type, name, span: [exp.start, exp.end], desired, refs: result.refs });
  }
  problems.sort(
    (a, b) =>
      (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
  return { resources, problems };
}

/** The data files under `dir`, sorted: regular `.ts` files, less tests, declarations and `node_modules`; none when `dir` is not a directory. */
function dataFilesUnder(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") && !d.name.endsWith(".d.ts"))
    .map((d) => join(d.parentPath, d.name))
    .filter((path) => !relative(dir, path).split(sep).includes("node_modules"))
    .toSorted();
}
