import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { childrenOf, type LintProblem, type Node, readSource, type SourceFile } from "./ast.ts";
import { keyName } from "./datafile.ts";
import type { ConfigDescription } from "./describe.ts";
import { stringValue, unwrap } from "./outline.ts";
import { filesUnder, isDirectory } from "./paths.ts";
import { apiNameOf, DATA_VENDOR, SITE_NAME } from "./shared.ts";

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
   * The path of the page the file is, from its `createFileRoute` (or `createLazyFileRoute`) id: groups and pathless
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
  /** Each call to a workflow, a collection or an operation the config does not have, or to an operation a page may not call directly, at its file. */
  problems: (LintProblem & { file: string })[];
}

/** Where a site's code is: its pages and its components. */
const SITE_DIRS = ["routes", "components"];
/** Where `api` and `defineSite` come from: `sanoma/site`, which re-exports the app's. */
const SITE_SOURCES: ReadonlySet<string> = new Set(["sanoma/site", "@sanoma-ai/app/site"]);
const UI_SOURCES: ReadonlySet<string> = new Set(["@sanoma-ai/app/ui"]);
const KIND_NAMES = { workflow: "workflow", collection: "collection", op: "operation" } as const;
/** What makes a route from its id, whose first argument is the id. */
const ROUTE_MAKERS: ReadonlySet<string> = new Set(["createFileRoute", "createLazyFileRoute"]);

/**
 * The sites under `root`: each folder of `sites/` with a `routes/` whose name is a URL segment,
 * by name (as `@sanoma-ai/app/build`'s `sitesOf` mounts them). Reads `routes/**` and
 * `components/**` (`.ts` and `.tsx`, less tests and declarations) of each with oxc, never running
 * them: each `<RunForm workflow="…" />` whose `RunForm` is imported from `@sanoma-ai/app/ui`, and
 * each use of `api` imported from `sanoma/site`, called or passed on (`queryFn: api.data.leads.list`):
 * `api.<name>` and `api.<name>.<method>` are a workflow, `api.data.<collection>.<op>` a collection,
 * and `api.<vendor>.<resource>.<op>` an operation. A name that is not written out (a variable, a
 * template with holes, a computed member) is skipped, as is a use through a namespace import or a
 * destructured `api`. A call to what `description` does not have, or to an operation a page may
 * not call directly, is a problem.
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
  const ops = new Map(description.ops.map((op) => [op.id, op]));
  // A workflow's api name to its name: two of one api name are a problem on the workflows.
  const byApiName = new Map(description.workflows.map((wf) => [apiNameOf(wf.name), wf.name]));

  /** A call as written, resolved as the app's `callApi` resolves it, with why it would fail. */
  const resolve = ({ kind, name, via, ...at }: Written): { call: SiteCall; problem?: string } => {
    const target = kind === "workflow" && via === "api" ? (byApiName.get(name) ?? name) : name;
    const found =
      kind === "workflow"
        ? via === "api"
          ? byApiName.has(name)
          : workflows.has(name)
        : kind === "collection"
          ? collections.has(name)
          : ops.has(name);
    const problem = !found
      ? `calls ${KIND_NAMES[kind]} "${target}", which does not exist`
      : kind === "op" && !ops.get(name)!.direct
        ? `calls operation "${target}", which a page may not call directly: start a workflow that calls it`
        : undefined;
    return { call: { kind, target, via, ...at }, ...(problem && { problem }) };
  };

  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SITE_NAME.test(d.name) && existsSync(join(dir, d.name, "routes")))
    .map((d) => d.name)
    .toSorted()
    .map((name) => {
      const files = SITE_DIRS.flatMap((sub) => filesUnder(join(dir, name, sub), isSource)).toSorted();
      const resolved = files.flatMap((path) => {
        const file = readSource(path);
        return typeof file === "string" ? [] : usesIn(file, relative(root, path).split(sep).join("/")).map(resolve);
      });
      const title = titleOf(join(dir, name, "site.ts"));
      const calls = resolved.map((r) => r.call);
      const problems = resolved.flatMap(({ call: { file, line, column }, problem }) =>
        problem === undefined ? [] : [{ file, line, column, message: problem }],
      );
      return { name, ...(title !== undefined && { title }), calls, problems };
    });
}

/** A use of `api` or a `RunForm`, as written: the name it gives, before it is resolved. */
type Written = Omit<SiteCall, "target"> & { name: string };

/** The uses in one file, in its order. */
function usesIn({ program, at }: SourceFile, file: string): Written[] {
  const api = importedAs(program, SITE_SOURCES, "api");
  const runForm = importedAs(program, UI_SOURCES, "RunForm");
  if (!api.size && !runForm.size) return [];
  const found: Omit<Written, "page">[] = [];
  let page: string | undefined;
  const visit = (node: Node) => {
    if (!node) return;
    if (node.type === "MemberExpression") {
      const named = apiPath(node, api);
      // The outermost member of a path on `api`: what it names, called or not; its inner members are not visited.
      if (named) return void found.push({ ...named, via: "api", file, ...at(node.start) });
    } else if (node.type === "CallExpression" && page === undefined) {
      const callee = unwrap(node.callee);
      if (callee?.type === "Identifier" && ROUTE_MAKERS.has(callee.name)) {
        const id = stringValue(node.arguments[0]);
        if (id !== undefined) page = pageOf(id);
      }
    } else if (node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" && runForm.has(node.name.name)) {
      const attribute = node.attributes.find(
        (a: Node) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "workflow",
      );
      const value = attribute?.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute?.value;
      const name = stringValue(value);
      if (name !== undefined) found.push({ kind: "workflow", name, via: "RunForm", file, ...at(node.start) });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(program);
  return found.map((use) => (page === undefined ? use : { ...use, page }));
}

/** What a member path on `api` names; undefined for a path on anything else, a name not written out, or no name. */
function apiPath(member: Node, api: ReadonlySet<string>): Pick<Written, "kind" | "name"> | undefined {
  const path: string[] = [];
  let node = member;
  while (node?.type === "MemberExpression") {
    const key: string | undefined = node.computed ? stringValue(node.property) : node.property.name;
    if (key === undefined) return undefined;
    path.unshift(key);
    node = unwrap(node.object);
  }
  if (node?.type !== "Identifier" || !api.has(node.name)) return undefined;
  const [first, second] = path as [string, ...string[]];
  if (first === DATA_VENDOR) return path.length === 3 ? { kind: "collection", name: second! } : undefined;
  if (path.length === 3) return { kind: "op", name: path.join(".") };
  return path.length <= 2 ? { kind: "workflow", name: first } : undefined;
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

/** A site's source file: `.ts` or `.tsx`, but a test or a declaration. */
const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name);
