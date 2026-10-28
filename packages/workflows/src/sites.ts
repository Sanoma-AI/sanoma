import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { childrenOf, type LintProblem, type Node, readSource, type SourceFile } from "./ast.ts";
import { type CedarPolicySource, visitorPermits } from "./cedar.ts";
import { keyName } from "./datafile.ts";
import type { ConfigDescription } from "./describe.ts";
import { stringValue, unwrap } from "./outline.ts";
import { APPS_DIR, appFolders, filesUnder, isDirectory } from "./paths.ts";
import { START } from "./schema.ts";
import {
  ANONYMOUS,
  apiNameOf,
  BUILT_IN_WORKFLOWS,
  DATA_VENDOR,
  LOCALE,
  SITE_NAME,
  siteKey,
  VISITORS,
  WORKFLOW_ACTION,
} from "./shared.ts";

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
  /**
   * What it calls of the workflow (`start`, or a read of its runs: `result`, `latest`, …) or the
   * collection (`list`, `save`, …), as written; absent for a workflow called as itself or by
   * `RunForm`, which starts it, and for an operation.
   */
  method?: string;
  /** `<RunForm workflow="…" />` or a call on `api`, from `sanoma/site`. */
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

/** A page of a site: a route file's path, and for a page per content entry the kind it reads. */
export interface SitePage {
  /** As `SiteCall.page` has it: `/sites/www`, `/sites/www/blog/$slug`. */
  path: string;
  /**
   * For a path with one parameter (`$slug`), the content kind whose entries are its pages: the one
   * kind its file reads by that parameter, `content.<kind>.get(params.slug)` (or `slug`,
   * destructured) with `content` from `sanoma/site`.
   */
  content?: string;
  /**
   * `false` when its route, or its layout's at the same path, says `staticData: { sitemap: false }`,
   * written out: the sitemap leaves it out.
   */
  sitemap?: false;
}

/** A site, `sites/<name>/` or an app's `apps/<app>/sites/<name>/`, and what it calls. */
export interface SiteEntry {
  /** Its folder's name, `<app>/<name>` for an app's (`siteKey`): where it is mounted, `/sites/<name>`. */
  name: string;
  /** The app whose folder holds it (`apps/<app>/sites/`); absent for one at the root. */
  app?: string;
  /** `defineSite({ title })` in its `site.ts`, when that is a string literal. */
  title?: string;
  /** `defineSite({ icon })` in its `site.ts`: a Lucide icon's name, as written. */
  icon?: string;
  /** `defineSite({ public: true })`: served to visitors, not people. */
  public?: true;
  /** `defineSite({ login })`, the connector whose login half signs visitors in, as written: one that names none is among `problems`. */
  login?: string;
  /**
   * `defineSite({ locales })`, a public site's languages, the first its default: kept only when
   * every one is a `LOCALE`, written once, on a public site with no login; else a problem.
   */
  locales?: string[];
  /** The host a public site answers on: set by `startApp` from its `domains`, never by `readSites`. */
  domain?: string;
  /** Its pages, by path: one for each path its `routes/` files give (a layout and its index are one). */
  pages: SitePage[];
  /** Its calls, by file and then in the file's order. */
  calls: SiteCall[];
  /**
   * Each call to a workflow, a collection or an operation the config does not have, or to an
   * operation a page may not call directly, or, on a public site, that no policy lets a visitor
   * make, at its file; then what is wrong in its `site.ts`.
   */
  problems: (LintProblem & { file: string })[];
  /**
   * On a public site, each page with one parameter whose file reads content the sitemap cannot
   * tie to it (`SitePage.content`), so the sitemap lists none of its pages: at the first read.
   * None for a page the sitemap leaves out anyway (`SitePage.sitemap`).
   */
  warnings: (LintProblem & { file: string })[];
}

/** Where a site's code is: its pages and its components. */
const SITE_DIRS = ["routes", "components"];
/** Where `api`, `RunForm` and `defineSite` come from: `sanoma/site`, which re-exports the app's. */
const SITE_SOURCES: ReadonlySet<string> = new Set(["sanoma/site", "@sanoma-ai/app/site"]);
const KIND_NAMES = { workflow: "workflow", collection: "collection", op: "operation" } as const;
/** What a route's loader and head name its path's parameters by. */
const PARAMS: ReadonlySet<string> = new Set(["params"]);
/** What makes a route from its id, whose first argument is the id. */
const ROUTE_MAKERS: ReadonlySet<string> = new Set(["createFileRoute", "createLazyFileRoute"]);

/**
 * The sites under `root` (`sitesUnder`): each folder of `sites/`, then of each app's
 * `apps/<app>/sites/`, with a `routes/` whose name is a URL segment, by key (as
 * `@sanoma-ai/app/build`'s `sitesOf` mounts them). Reads `routes/**` and
 * `components/**` (`.ts` and `.tsx`, less tests and declarations) of each with oxc, never running
 * them: each page (`SitePage`, from a route's id), each `<RunForm workflow="…" />` and each use of `api`, both imported from `sanoma/site`,
 * called or passed on (`queryFn: api.data.leads.list`):
 * `api.<name>` and `api.<name>.<method>` are a workflow, `api.data.<collection>.<op>` (an app's
 * `api.data.<app>.<collection>.<op>`) a collection,
 * and `api.<vendor>.<resource>.<op>` an operation. A name that is not written out (a variable, a
 * template with holes, a computed member) is skipped, as is a use through a namespace import or a
 * destructured `api`. A call to what `description` does not have, or to an operation a page may
 * not call directly, is a problem. So is a `login` in `site.ts` that does not name one of
 * `connectors.logins` (the vendors whose connector has a login half) on a public site. Given the
 * company's `policies` (undefined while they have problems, which refuse every call), so is a
 * public site's start or direct call that no company `permit` could let a visitor make
 * (`visitorPermits`): one for `anonymous`, or on a site with a login, one for `anonymous` or the
 * `visitors`, whatever its conditions. Whatever the policies, so is a public site's call of a
 * built-in workflow, and its read of a workflow's runs but `.result`, which `callApi` refuses a visitor.
 */
export function readSites(
  root: string | undefined,
  description: Pick<ConfigDescription, "workflows" | "collections" | "ops">,
  connectors: SiteConnectors,
  policies?: readonly CedarPolicySource[],
): SiteEntry[] {
  if (root === undefined) return [];
  const workflows = new Set(description.workflows.map((wf) => wf.name));
  const collections = new Set(description.collections.map((c) => c.name));
  // `api.data.<app>.<collection>` passed on as a value reads as a call of `<app>`'s method: it is none.
  const isAppCollection = ({ kind, name, method }: Written) =>
    kind === "collection" && collections.has(`${name}.${method}`);
  const ops = new Map(description.ops.map((op) => [op.id, op]));
  // A workflow's api name to its name: two of one api name are a problem on the workflows.
  const byApiName = new Map(description.workflows.map((wf) => [apiNameOf(wf.name), wf.name]));
  const permits = policies && visitorPermits(policies);

  /**
   * Why a visitor's `call`, which exists, is certainly refused on a public site that has `login`:
   * as `callApi` refuses it whatever the policy says, or as no permit could allow it.
   */
  const refused = (call: SiteCall, login: string | undefined): string | undefined => {
    const why = `a visitor's call to ${KIND_NAMES[call.kind]} "${call.target}" is refused`;
    let action: string;
    let group: string;
    if (call.kind === "workflow") {
      if (BUILT_IN_WORKFLOWS.has(call.target)) return `${why}: a visitor may not start the runtime's own workflows`;
      if (call.method === "result") return undefined;
      if (call.method !== undefined && call.method !== "start") {
        return `${why}: a visitor reads only the result of a run it started`;
      }
      [action, group] = [`${WORKFLOW_ACTION}${call.target}`, START];
    } else {
      action = call.kind === "op" ? call.target : `${DATA_VENDOR}.${call.target}.${call.method}`;
      const op = ops.get(action);
      if (!op) return undefined;
      group = `effect:${op.effect}`;
    }
    if (!permits) return undefined;
    const [scopes, principal] =
      login === undefined
        ? [[ANONYMOUS], `== Sanoma::Principal::"${ANONYMOUS}"`]
        : [[ANONYMOUS, VISITORS], `in Sanoma::Group::"${VISITORS}"`];
    if (permits(new Set(scopes), action, group)) return undefined;
    return (
      `${why}: no permit in policies/ names ${scopes.join(" or ")} for ${action}. ` +
      `Add: permit (principal ${principal}, action == Sanoma::Action::"${action}", resource);`
    );
  };

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

  return sitesUnder(root).map(({ name, app, dir }) => {
    const read = readSiteFiles(root, dir);
    const resolved = read.flatMap(({ uses }) => uses.filter((use) => !isAppCollection(use)).map(resolve));
    const pages = pagesOf(read);
    const siteFile = `${dir}/site.ts`;
    const { problems: optionProblems, ...options } = siteOptionsOf(join(root, siteFile), connectors);
    const calls = resolved.map((r) => r.call);
    const problems = [
      ...resolved.flatMap(({ call, problem }) => {
        const message = problem ?? (options.public ? refused(call, options.login) : undefined);
        return message === undefined ? [] : [{ file: call.file, line: call.line, column: call.column, message }];
      }),
      ...optionProblems.map((p) => ({ file: siteFile, ...p })),
    ];
    const sorted = [...pages.keys()].toSorted().map((path) => pages.get(path)!);
    // A page's file it warns of, unless another of its files (a lazy one, its layout) gives its kind or keeps it out.
    const warnings = options.public
      ? read.flatMap(({ route, warning }) => {
          if (!warning) return [];
          const page = pages.get(route!.path);
          return page?.content || page?.sitemap === false ? [] : [warning];
        })
      : [];
    return { name, ...(app && { app }), ...options, pages: sorted, calls, problems, warnings };
  });
}

/** A site's pages, by path, from its files: a layout's and its index's (one path) merged. */
function pagesOf(read: readonly { route?: SitePage }[]): Map<string, SitePage> {
  const pages = new Map<string, SitePage>();
  for (const { route } of read) {
    if (route) pages.set(route.path, { ...pages.get(route.path), ...route });
  }
  return pages;
}

/** Each file of the site in `dir` (relative to `root`), as `readSiteFile` reads it, by path. */
const readSiteFiles = (root: string, dir: string) =>
  SITE_DIRS.flatMap((sub) => filesUnder(join(root, dir, sub), isSource))
    .toSorted()
    .flatMap((path) => {
      const file = readSource(path);
      return typeof file === "string" ? [] : [readSiteFile(file, relative(root, path).split(sep).join("/"))];
    });

/**
 * Each site's pages under `root` whose entries are a content kind's (`SitePage.content`), path to
 * kind: what the app's build gives its router (`virtual:sanoma/locales`), so a page lists only the
 * languages its entry is in. Read as `readSites` reads them, never run.
 */
export function siteContentPages(root: string): Record<string, string> {
  return Object.fromEntries(
    sitesUnder(root).flatMap(({ dir }) =>
      [...pagesOf(readSiteFiles(root, dir)).values()].flatMap(({ path, content }) =>
        content ? [[path, content]] : [],
      ),
    ),
  );
}

/**
 * Each site's languages (`defineSite({ locales })`, the first its default) under `root`, by name,
 * for the sites whose `site.ts` gives them without a problem there: what the app's build gives
 * its router (`virtual:sanoma/locales`). Read as `readSites` reads them, never run.
 */
export function siteLocales(root: string): Record<string, string[]> {
  const none = new Set<string>();
  return Object.fromEntries(
    sitesUnder(root).flatMap(({ name, dir }) => {
      const { locales } = siteOptionsOf(join(root, dir, "site.ts"), { vendors: none, logins: none });
      return locales ? [[name, locales]] : [];
    }),
  );
}

/**
 * Each site's icon (`defineSite({ icon })`, a Lucide icon's name as written) under `root`, by name,
 * for the sites whose `site.ts` gives one: the icons the app's build bundles (`virtual:sanoma/icons`).
 * Read as `readSites` reads it, never run.
 */
export function siteIcons(root: string): Record<string, string> {
  const none = new Set<string>();
  return Object.fromEntries(
    sitesUnder(root).flatMap(({ name, dir }) => {
      const { icon } = siteOptionsOf(join(root, dir, "site.ts"), { vendors: none, logins: none });
      return icon === undefined ? [] : [[name, icon]];
    }),
  );
}

/**
 * The sites under `root`, by key (`siteKey`): each folder of `sites/` with a `routes/` whose name
 * is a URL segment, then each app's `apps/<app>/sites/`, with its folder relative to `root`.
 */
export const sitesUnder = (root: string): { name: string; app?: string; dir: string }[] => [
  ...siteNames(join(root, "sites")).map((name) => ({ name, dir: `sites/${name}` })),
  ...appFolders(root).flatMap((folder) => {
    const app = basename(folder);
    return siteNames(join(folder, "sites")).map((name) => ({
      name: siteKey(app, name),
      app,
      dir: `${APPS_DIR}/${app}/sites/${name}`,
    }));
  }),
];

/** The sites in `dir`: each folder with a `routes/` whose name is a URL segment, sorted. */
const siteNames = (dir: string): string[] =>
  isDirectory(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && SITE_NAME.test(d.name) && existsSync(join(dir, d.name, "routes")))
        .map((d) => d.name)
        .toSorted()
    : [];

/** A use of `api` or a `RunForm`, as written: the name it gives, before it is resolved. */
type Written = Omit<SiteCall, "target"> & { name: string };

/**
 * What one file holds: its uses, in its order, and the page it is, from its route's id, with the
 * content kind whose entry its one parameter names (`SitePage.content`) and whether its route's
 * options keep it out of the sitemap (`SitePage.sitemap`). A file under `routes/` is read whole;
 * any other only when it imports `api` or `RunForm`.
 */
function readSiteFile(
  { program, at }: SourceFile,
  file: string,
): { uses: Written[]; route?: SitePage; warning?: LintProblem & { file: string } } {
  const api = importedAs(program, SITE_SOURCES, "api");
  const runForm = importedAs(program, SITE_SOURCES, "RunForm");
  const content = importedAs(program, SITE_SOURCES, "content");
  if (!api.size && !runForm.size && !file.includes("/routes/")) return { uses: [] };
  const found: Omit<Written, "page">[] = [];
  /** Each `content.<kind>.get(arg)`: its kind, its argument and where it is. */
  const gets: { kind: string; arg: Node; start: number }[] = [];
  let page: string | undefined;
  /** The options of the route it makes, `createFileRoute(id)({ … })` (a lazy route's carry no `staticData`). */
  let options: Node;
  const visit = (node: Node) => {
    if (!node) return;
    if (node.type === "MemberExpression") {
      const named = apiPath(node, api);
      // The outermost member of a path on `api`: what it names, called or not; its inner members are not visited.
      if (named) return void found.push({ ...named, via: "api", file, ...at(node.start) });
    } else if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      if (callee?.type === "Identifier" && ROUTE_MAKERS.has(callee.name) && page === undefined) {
        const id = stringValue(node.arguments[0]);
        if (id !== undefined) page = pageOf(id);
      }
      const maker = callee?.type === "CallExpression" ? unwrap(callee.callee) : undefined;
      if (maker?.type === "Identifier" && maker.name === "createFileRoute") options ??= node.arguments[0];
      const kind = contentKind(callee, content);
      if (kind !== undefined) gets.push({ kind, arg: unwrap(node.arguments[0]), start: node.start });
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
  const uses = found.map((use) => (page === undefined ? use : { ...use, page }));
  if (page === undefined) return { uses };
  const route: SitePage = { path: page, ...(offSitemap(options) && { sitemap: false }) };
  // The one parameter's name (not a splat's), and the kinds whose `get` is given it (`params.slug`, or `slug` destructured).
  const params = page.split("/").filter((segment) => segment.startsWith("$"));
  if (params.length !== 1 || params[0] === "$") return { uses, route };
  const param = params[0]!.slice(1);
  const kinds = new Set(
    gets
      .filter(({ arg }) =>
        arg?.type === "Identifier"
          ? arg.name === param
          : arg?.type === "MemberExpression" && memberPath(arg, PARAMS)?.join(".") === param,
      )
      .map(({ kind }) => kind),
  );
  if (kinds.size === 1) return { uses, route: { ...route, content: [...kinds][0]! } };
  // A read by the parameter in a form the sitemap does not follow (`params.id.toLowerCase()`, two kinds).
  const unfollowed = gets.find(({ arg }) => mentions(arg, param));
  if (!unfollowed) return { uses, route };
  const message =
    `the sitemap lists none of this page's entries: it reads content by the page's parameter in a way it cannot follow. ` +
    `Read one kind by it as written, \`content.<kind>.get(params.${param})\` (or \`${param}\` destructured)`;
  return { uses, route, warning: { file, ...at(unfollowed.start), message } };
}

/** Whether a route's `options` say `staticData: { sitemap: false }`, each written out. */
const offSitemap = (options: Node): boolean => {
  const flag = unwrap(valueOf(valueOf(options, "staticData"), "sitemap"));
  return flag?.type === "Literal" && flag.value === false;
};

/**
 * The value of an object literal's property `name`, its last, written out; undefined for anything
 * else, or when a spread or a computed key after it could replace it.
 */
const valueOf = (object: Node, name: string): Node => {
  const o = unwrap(object);
  const last =
    o?.type === "ObjectExpression" && o.properties.findLast((p: Node) => !isWritten(p) || keyName(p.key) === name);
  return last && isWritten(last) ? last.value : undefined;
};

/** Whether `node` reads the parameter `param` anywhere in it: `params.<param>`, or `param` destructured (not another parameter, nor a property's name, `post.slug` or `{ slug: x }`). */
const mentions = (node: Node, param: string): boolean => {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === param;
  if (node.type === "Property" && !node.computed) return mentions(node.value, param);
  if (node.type === "MemberExpression") {
    const path = memberPath(node, PARAMS);
    if (path) return path[0] === param;
    if (!node.computed) return mentions(node.object, param);
  }
  return childrenOf(node).some((child) => mentions(child, param));
};

/** The names of a member path on one of `roots` (`api.data.leads.list` is `data`, `leads`, `list`); undefined for a path on anything else or a name not written out. */
function memberPath(member: Node, roots: ReadonlySet<string>): string[] | undefined {
  const path: string[] = [];
  let node = member;
  while (node?.type === "MemberExpression") {
    const key: string | undefined = node.computed ? stringValue(node.property) : node.property.name;
    if (key === undefined) return undefined;
    path.unshift(key);
    node = unwrap(node.object);
  }
  return node?.type === "Identifier" && roots.has(node.name) ? path : undefined;
}

/** The kind of `content.<kind>.get`, a callee on `content` imported from `sanoma/site`; undefined for any other. */
function contentKind(callee: Node, content: ReadonlySet<string>): string | undefined {
  const path = callee?.type === "MemberExpression" ? memberPath(callee, content) : undefined;
  return path?.length === 2 && path[1] === "get" ? path[0] : undefined;
}

/** What a member path on `api` names; undefined for a path on anything else, a name not written out, or no name. */
function apiPath(member: Node, api: ReadonlySet<string>): Pick<Written, "kind" | "name" | "method"> | undefined {
  const path = memberPath(member, api);
  if (!path?.length) return undefined;
  const [first, second] = path as [string, ...string[]];
  // `api.data.<collection>.<op>`, or an app's, `api.data.<app>.<collection>.<op>`.
  if (first === DATA_VENDOR)
    return path.length === 3 || path.length === 4
      ? { kind: "collection", name: path.slice(1, -1).join("."), method: path.at(-1) }
      : undefined;
  if (path.length === 3) return { kind: "op", name: path.join(".") };
  if (path.length > 2) return undefined;
  return { kind: "workflow", name: first, ...(second !== undefined && { method: second }) };
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
 * a string, `icon`, `public`, `login` and `locales`, which must be literals. `login` is kept as written; one on a
 * site that is not public, or naming no connector of the config with a login half, is a problem.
 * `locales` is kept only when it has no problem.
 */
function siteOptionsOf(
  path: string,
  connectors: SiteConnectors,
): Pick<SiteEntry, "title" | "icon" | "public" | "login" | "locales"> & { problems: LintProblem[] } {
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
  // Cosmetic: one that is not a string (tsc refuses it) is shown as none, never a problem that stops a site.
  const icon = stringValue(property("icon")?.value);
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

  const localesAt = property("locales");
  const list = unwrap(localesAt?.value);
  // A hole or a spread is no string.
  const tags: (string | undefined)[] | undefined =
    list?.type === "ArrayExpression" ? list.elements.map((e: Node) => stringValue(e)) : undefined;
  const locales = tags?.every((tag): tag is string => tag !== undefined) ? tags : undefined;
  const localesProblem = (): string | undefined => {
    if (locales === undefined) return unread("`locales`", "an array of strings");
    if (!locales.length) return "`locales` names a site's languages, its default first: give one or more, or remove it";
    const bad = locales.find((locale) => !LOCALE.test(locale));
    if (bad !== undefined) return `"${bad}" is not a language tag such as "en", "fr" or "pt-BR"`;
    const twice = locales.find((locale, i) => locales.indexOf(locale) !== i);
    if (twice !== undefined) return `"${twice}" is in \`locales\` twice`;
    // When `public` is what is wrong, it is said there.
    if ((!isPublic && !publicUnread) || loginAt) {
      return "`locales` are for a public site with no login: add `public: true`, or remove `locales`";
    }
    return undefined;
  };
  const localesMessage = localesAt && localesProblem();
  if (localesMessage) problem(localesAt, localesMessage);
  return {
    ...(title !== undefined && { title }),
    ...(icon !== undefined && { icon }),
    ...(isPublic && { public: true as const }),
    ...(login !== undefined && { login }),
    ...(localesAt && !localesMessage && isPublic && !loginAt && { locales }),
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
