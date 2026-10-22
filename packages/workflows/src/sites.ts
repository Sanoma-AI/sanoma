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
  /** `defineSite({ public: true })`: served to visitors, not people. */
  public?: true;
  /** `defineSite({ login })`, the connector whose login half signs visitors in, as written: one that names none is among `problems`. */
  login?: string;
  /** The host a public site answers on: set by `startApp` from its `domains`, never by `readSites`. */
  domain?: string;
  /** Its calls, by file and then in the file's order. */
  calls: SiteCall[];
  /**
   * Each call to a workflow, a collection or an operation the config does not have, or to an
   * operation a page may not call directly, at its file; then what is wrong in its `site.ts`.
   */
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
 * not call directly, is a problem. So is a `login` in `site.ts` that does not name one of
 * `connectors.logins` (the vendors whose connector has a login half) on a public site.
 */
export function readSites(
  root: string | undefined,
  description: Pick<ConfigDescription, "workflows" | "collections" | "ops">,
  connectors: SiteConnectors,
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
      const siteFile = `sites/${name}/site.ts`;
      const { problems: optionProblems, ...options } = siteOptionsOf(join(root, siteFile), connectors);
      const calls = resolved.map((r) => r.call);
      const problems = [
        ...resolved.flatMap(({ call: { file, line, column }, problem }) =>
          problem === undefined ? [] : [{ file, line, column, message: problem }],
        ),
        ...optionProblems.map((p) => ({ file: siteFile, ...p })),
      ];
      return { name, ...options, calls, problems };
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

/** The connectors a site's `login` is checked against: the config's vendors, and those with a login half. */
type SiteConnectors = { vendors: ReadonlySet<string>; logins: ReadonlySet<string> };

/** A property of an object literal that is written out: not a spread, its name not computed. */
const isWritten = (p: Node) => p.type === "Property" && !p.computed;

/** What `site.ts` that `sanoma` cannot read without running it is told. */
const unread = (what: string, as: string) => `${what} is read without running site.ts: write it as ${as}`;

/**
 * What `site.ts` says of its site, read without running it, and what is wrong there: its default
 * export must be `defineSite({ … })` written out, so it can be read at all; then `title` when it is
 * a string, `public` and `login`, which must be literals. `login` is kept as written; one on a
 * site that is not public, or naming no connector of the config with a login half, is a problem.
 */
function siteOptionsOf(
  path: string,
  connectors: SiteConnectors,
): Pick<SiteEntry, "title" | "public" | "login"> & { problems: LintProblem[] } {
  const file = readSource(path);
  if (typeof file === "string") return { problems: [] };
  const problems: LintProblem[] = [...file.problems];
  const problem = (at: Node, message: string) => void problems.push({ ...file.at(at.start), message });
  const exported = file.program.body.find((s: Node) => s.type === "ExportDefaultDeclaration");
  if (!exported) return { problems };
  const call = unwrap(exported.declaration);
  const callee = unwrap(call?.callee);
  const options = unwrap(call?.arguments?.[0]);
  const defineSite = importedAs(file.program, SITE_SOURCES, "defineSite");
  // Anything not written out (a variable, a spread, a computed key) could make the site public unseen.
  const written =
    call?.type === "CallExpression" &&
    callee?.type === "Identifier" &&
    defineSite.has(callee.name) &&
    (options === undefined || options.type === "ObjectExpression");
  if (!written) {
    problem(
      exported,
      unread("its default export", '`defineSite({ … })` from "sanoma/site", its options an object literal'),
    );
    return { problems };
  }
  for (const p of options?.properties ?? []) {
    if (!isWritten(p)) problem(p, unread("each of `defineSite`'s options", "a property with its name"));
  }
  // The last of a name, as the object it makes has.
  const property = (name: string): Node =>
    options?.properties.findLast((p: Node) => isWritten(p) && keyName(p.key) === name);

  const title = stringValue(property("title")?.value);
  const publicAt = property("public");
  const flag = unwrap(publicAt?.value);
  const isPublic = flag?.type === "Literal" && flag.value === true;
  const publicUnread = publicAt !== undefined && !(flag?.type === "Literal" && typeof flag.value === "boolean");
  if (publicUnread) problem(publicAt, unread("`public`", "`true` or `false`"));

  const loginAt = property("login");
  const login = stringValue(loginAt?.value);
  const loginProblem = (): string | undefined => {
    if (login === undefined) return unread("`login`", "a string");
    // When `public` is what is wrong, it is said there.
    if (!isPublic && !publicUnread) return "a login is for a public site: add `public: true`, or remove `login`";
    if (!connectors.vendors.has(login)) return `login names "${login}", which is not a connector in sanoma.config.ts`;
    if (!connectors.logins.has(login)) return `login names "${login}", whose connector has no login half`;
    return undefined;
  };
  const message = loginAt && loginProblem();
  if (message) problem(loginAt, message);
  return {
    ...(title !== undefined && { title }),
    ...(isPublic && { public: true as const }),
    ...(login !== undefined && { login }),
    problems,
  };
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
