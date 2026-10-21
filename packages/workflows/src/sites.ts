import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { childrenOf, type LintProblem, type Node, readSource, type SourceFile } from "./ast.ts";
import { keyName } from "./datafile.ts";
import type { ConfigDescription } from "./describe.ts";
import { stringValue, unwrap } from "./outline.ts";
import { apiNameOf, DATA_VENDOR } from "./shared.ts";

// What a company's sites call, read from their source with oxc and never run: the reverse index
// a workflow's page shows as Used by, and the names `sanoma check` holds to the config.

/** A call a site makes, as written in its source. */
export interface SiteCall {
  /** What it calls: a workflow, a collection (`api.data.<name>.<op>`) or an operation (`api.<vendor>.<resource>.<op>`). */
  kind: "workflow" | "collection" | "op";
  /**
   * The workflow's name (`RunForm`'s `workflow`, or the workflow whose `apiNameOf` is the name
   * `api` gives; that name itself when none is), the collection's name, or the operation's id.
   */
  target: string;
  /** `<RunForm workflow="…" />` from `@sanoma-ai/app/ui`, or a call on `api` from `sanoma/site`. */
  via: "RunForm" | "api";
  /** The file, relative to the config's root, with `/`: `sites/sales/routes/index.tsx`. */
  file: string;
  /** From 1. */
  line: number;
  /** From 1, in UTF-16 code units. */
  column: number;
  /**
   * The path of the page the file is, from its `createFileRoute` id: groups and pathless
   * segments left out, no trailing slash (`/sites/sales`). Absent for a file that is no page,
   * such as a component's.
   */
  page?: string;
}

/** A site, `sites/<name>/`, and what it calls. */
export interface SiteEntry {
  /** Its folder's name, where it is mounted: `/sites/<name>`. */
  name: string;
  /** `defineSite({ title })` in its `site.ts`, when that is a string literal. */
  title?: string;
  /** Its calls, by file and then in the file's order. */
  calls: SiteCall[];
  /** Each call to a workflow, a collection or an operation the config does not have, at its file. */
  problems: (LintProblem & { file: string })[];
}

/** A site's folder name, as `sitesOf` in `@sanoma-ai/app/build` mounts one: a URL segment. */
const SITE_NAME = /^[a-z][a-z0-9-]*$/;
/** Where a site's code is: its pages and its components. */
const SITE_DIRS = ["routes", "components"];
/** Where `api` and `defineSite` come from: `sanoma/site`, which re-exports the app's. */
const SITE_SOURCES: ReadonlySet<string> = new Set(["sanoma/site", "@sanoma-ai/app/site"]);
const UI_SOURCE = "@sanoma-ai/app/ui";
const KIND_NAMES = { workflow: "workflow", collection: "collection", op: "operation" } as const;

/**
 * The sites under `root`: each folder of `sites/` with a `routes/` whose name is a URL segment,
 * by name. Reads `routes/**` and `components/**` (`.ts` and `.tsx`) of each with oxc, never
 * running them: each `<RunForm workflow="…" />` whose `RunForm` is imported from
 * `@sanoma-ai/app/ui`, and each call on `api` imported from `sanoma/site`: `api.<name>(…)` and
 * `api.<name>.<method>(…)` call a workflow, `api.data.<collection>.<op>(…)` a collection, and
 * `api.<vendor>.<resource>.<op>(…)` an operation. A name that is not written out (a variable, a
 * template with holes, a computed member) is skipped, as is a call through a namespace import or
 * a destructured `api`. Each call naming what `description` does not have is a problem.
 */
export function readSites(
  root: string | undefined,
  description: Pick<ConfigDescription, "workflows" | "collections" | "ops">,
): SiteEntry[] {
  if (root === undefined) return [];
  const dir = join(root, "sites");
  if (!isDirectory(dir)) return [];
  const workflows = new Set(description.workflows.map((wf) => wf.name));
  const collections = new Set(description.collections.map((c) => c.name));
  const ops = new Set(description.ops.map((op) => op.id));
  // A workflow's api name to its name: two of one api name are a problem on the workflows.
  const byApiName = new Map(description.workflows.map((wf) => [apiNameOf(wf.name), wf.name]));
  const exists = ({ kind, target }: SiteCall) =>
    (kind === "workflow" ? workflows : kind === "collection" ? collections : ops).has(target);

  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SITE_NAME.test(d.name) && isDirectory(join(dir, d.name, "routes")))
    .map((d) => d.name)
    .toSorted()
    .map((name) => {
      const files = SITE_DIRS.flatMap((sub) => sourcesUnder(join(dir, name, sub))).toSorted();
      const calls = files.flatMap((path) => {
        const file = readSource(path);
        return typeof file === "string" ? [] : callsIn(file, relative(root, path).split(sep).join("/"), byApiName);
      });
      const title = titleOf(join(dir, name, "site.ts"));
      const problems = calls
        .filter((call) => !exists(call))
        .map(({ kind, target, file, line, column }) => ({
          file,
          line,
          column,
          message: `calls ${KIND_NAMES[kind]} "${target}", which does not exist`,
        }));
      return { name, ...(title !== undefined && { title }), calls, problems };
    });
}

/** The calls in one file, in its order. */
function callsIn({ program, at }: SourceFile, file: string, byApiName: ReadonlyMap<string, string>): SiteCall[] {
  const api = importedAs(program, SITE_SOURCES, "api");
  const runForm = importedAs(program, new Set([UI_SOURCE]), "RunForm");
  if (!api.size && !runForm.size) return [];
  const found: Omit<SiteCall, "page">[] = [];
  let page: string | undefined;
  const visit = (node: Node) => {
    if (!node) return;
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      if (page === undefined && callee?.type === "Identifier" && callee.name === "createFileRoute") {
        const id = stringValue(node.arguments[0]);
        if (id !== undefined) page = pageOf(id);
      }
      const called = apiCall(callee, api, byApiName);
      if (called) found.push({ ...called, via: "api", file, ...at(node.start) });
    } else if (node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" && runForm.has(node.name.name)) {
      const attribute = node.attributes.find(
        (a: Node) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "workflow",
      );
      const value = attribute?.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute?.value;
      const target = stringValue(value);
      if (target !== undefined) found.push({ kind: "workflow", target, via: "RunForm", file, ...at(node.start) });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(program);
  return found.map((call) => (page === undefined ? call : { ...call, page }));
}

/** What a call on `api` names, from its callee; undefined for any other callee, or a name not written out. */
function apiCall(
  callee: Node,
  api: ReadonlySet<string>,
  byApiName: ReadonlyMap<string, string>,
): Pick<SiteCall, "kind" | "target"> | undefined {
  const path: string[] = [];
  let node = callee;
  while (node?.type === "MemberExpression") {
    const key: string | undefined = node.computed ? stringValue(node.property) : node.property.name;
    if (key === undefined) return undefined;
    path.unshift(key);
    node = unwrap(node.object);
  }
  if (node?.type !== "Identifier" || !api.has(node.name) || !path.length) return undefined;
  const [name, second] = path as [string, ...string[]];
  if (name === DATA_VENDOR) return path.length === 3 ? { kind: "collection", target: second! } : undefined;
  if (path.length === 3) return { kind: "op", target: path.join(".") };
  if (path.length > 2) return undefined;
  return { kind: "workflow", target: byApiName.get(name) ?? name };
}

/** The local names `imported` has in the file, imported as a value from one of `sources`. */
function importedAs(program: Node, sources: ReadonlySet<string>, imported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!sources.has(statement.source.value)) continue;
    for (const s of statement.specifiers) {
      if (s.type === "ImportSpecifier" && s.importKind !== "type" && keyName(s.imported) === imported) {
        names.add(s.local.name);
      }
    }
  }
  return names;
}

/** A site's title: the string `title` its `site.ts` exports by default through `defineSite`. */
function titleOf(path: string): string | undefined {
  const file = readSource(path);
  if (typeof file === "string") return undefined;
  const defineSite = importedAs(file.program, SITE_SOURCES, "defineSite");
  const exported = file.program.body.find((s: Node) => s.type === "ExportDefaultDeclaration")?.declaration;
  const call = unwrap(exported);
  const callee = unwrap(call?.callee);
  const options = unwrap(call?.arguments?.[0]);
  if (call?.type !== "CallExpression" || callee?.type !== "Identifier" || !defineSite.has(callee.name))
    return undefined;
  if (options?.type !== "ObjectExpression") return undefined;
  const title = options.properties.find(
    (p: Node) => p.type === "Property" && !p.computed && keyName(p.key) === "title",
  );
  return stringValue(title?.value);
}

/**
 * A route's path from its id, as the router serves it: `(group)` and `_pathless` segments left
 * out, a `_` that ends a segment dropped, and no trailing slash.
 */
const pageOf = (id: string): string =>
  `/${id
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("_"))
    .map((s) => s.replace(/_$/, ""))
    .join("/")}`;

/** The `.ts` and `.tsx` files under `dir`, less declarations; none when it is not a directory. */
function sourcesUnder(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => join(d.parentPath, d.name));
}

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
