import type { z } from "zod";
import { type AppEntry, appsAt } from "./apps.ts";
import { readSource, type SourceFile } from "./ast.ts";
import { readPolicyFiles } from "./cedar.ts";
import { recordSchemaOf } from "./collection.ts";
import { connectorsOf, resolveConfig, rootOf, type SanomaConfig } from "./config.ts";
import { type Builtin, jsonSchemaOf, opIdsOf, type Use } from "./define.ts";
import {
  CAPABILITIES,
  type CollectionEntry,
  type ConfigDescription,
  type OpEntry,
  type ResourceTypeEntry,
  type VendorEntry,
  type WorkflowEntry,
} from "./description.ts";
import { isDirect } from "./direct.ts";
import { type CredentialStatus, credentialsOf } from "./env.ts";
import { lintWorkflow } from "./lint.ts";
import { VENDOR, type VendorInfo } from "./op.ts";
import { outlineWithSource } from "./outline.ts";
import { allowAll, policyOpOf } from "./policy.ts";
import { type Resource, resourceTypesOf, valueAt } from "./resource.ts";
import { type DeclaredResource, inAppPeople, loadDataFiles, type ResourceProblem } from "./resources.ts";
import { apiNameProblem } from "./sdk.ts";
import { apiNameOf, BUILT_IN_WORKFLOWS, DATA_VENDOR, problemLine } from "./shared.ts";
import { readSites, type SiteEntry } from "./sites.ts";

// `@sanoma-ai/workflows/describe`: what a UI renders from, apart from the main entry.
// What `describeConfig` answers, as zod schemas and the types they infer (`./description`).
export * from "./description.ts";
export { outlineWorkflow, type Outline, type OutlineNode, type Span } from "./outline.ts";
export { admit, loadDataFiles, readPeople, type DataFiles, type DeclaredPeople } from "./resources.ts";
// The writer: setting a resource's fields in its data file, and rendering a new one.
export {
  type DataFileContent,
  type DataValue,
  formatOptions,
  NotLiteral,
  Reference,
  renderDataFile,
  setFields,
} from "./writer.ts";

/**
 * The resources the config's data files declare, as loading them makes them (`loadDataFiles`);
 * throws one error listing every problem, one per line, for a test or CI to fail on.
 * `describeConfig` lists the same, with the problems beside them instead.
 */
export function readResources(config: SanomaConfig): DeclaredResource[] {
  const { resources, problems } = loadDataFiles(rootOf(config), connectorsOf(config));
  if (problems.length) {
    const lines = problems.map((p) => `  ${problemLine(p)}`);
    throw new Error(`The resources' data files have problems:\n${lines.join("\n")}`);
  }
  return resources;
}
export {
  LOCKFILE,
  readLockfile,
  serializeLockfile,
  writeLockfile,
  diffLockfiles,
  type Binding,
  type Bindings,
  type Rebind,
} from "./lockfile.ts";
// The apps under `apps/`, with what their `app.ts` declares.
export { crossAppImports, readApps } from "./apps.ts";
// What the sites call, read from their source: a workflow's Used by.
export { readSites, siteContentPages, siteIcons, siteLocales, sitesUnder } from "./sites.ts";
// The generated SDK, `.sanoma/api.ts`: a site's `api` typed from this description.
export { API_FILE, generateApi, writeApi, writeGenerated } from "./sdk.ts";
// The Cedar schema, `.sanoma/schema.cedarschema`: what a company's policies are validated and decided against.
export { SCHEMA_FILE, schemaOf, schemaText, type CedarSchemaJson } from "./schema.ts";
// The Permissions grid: the app's page and `sanoma check`'s `checked` event compute it the one way.
export { columnPrincipal, permissionsGrid, type PermissionsGrid, type PermissionsRow } from "./grid.ts";
export { previewRequests } from "./shared.ts";
// The apply workflow's plan and report, which the app renders.
export type { ApplyInput, ApplyPlan, ApplyReport, ApplyResult, PlanAnswer, PlanStep } from "./apply.ts";

/**
 * Describes a config. Throws what `startWorker` would refuse (see `resolveConfig`), except missing
 * credentials (`SanomaClient.credentials` gives their statuses) and what is wrong in a workflow's
 * file, which the worker refuses when it reads the outline: that is data, on each workflow's
 * entry, as the data files' problems are, `problems`, beside the resources read without any.
 * Each workflow's file is read and parsed once, however many workflows it defines. The sites'
 * code is read too (`readSites`): what each calls, and its calls to what the config lacks as its problems.
 */
export function describeConfig(config: SanomaConfig): ConfigDescription {
  const resolved = resolveConfig(config);
  const vendors: Record<string, VendorEntry> = {};
  // The variables each driver declares, without a value: their names and manuals alone.
  const env = credentialsOf(resolved.driversByVendor, () => undefined);
  // A vendor whose operations are split over several connectors is named by the first; its
  // resource types are every connector's.
  for (const connector of config.connectors) {
    const { id, info } = connector[VENDOR];
    vendors[id] ??= vendorEntry(id, info, resolved.fakes.has(id), env.get(id));
  }
  const resources = resourceTypesOf(connectorsOf(config));
  // The types a host's `source` names: the repositories a host clones.
  const sources = new Set(
    [...resources.values()].flatMap(({ host, fields }) => {
      const named = host && fields.references?.[host.inputs.source]?.type;
      return named === undefined ? [] : [named].flat();
    }),
  );
  // Each resource type's state is described once, on its entry, and referenced from its operations.
  const refs = new Map<z.ZodType, string>([...resources].map(([id, r]) => [r.schema, resourceTypeUri(id)]));
  const resourceTypes: ResourceTypeEntry[] = [...resources]
    .map(([id, spec]) => {
      const { vendor, type, title, identity, fields, schema, ops } = spec;
      const capabilities = CAPABILITIES.filter((c) => (c === "source" ? sources.has(id) : spec[c] !== undefined));
      return {
        id,
        vendor,
        type,
        title,
        identity,
        fields,
        schema: { $id: resourceTypeUri(id), ...toJsonSchema(schema, `${id} state`, "output") },
        ops: Object.keys(ops)
          .map((name) => `${id}.${name}`)
          .toSorted(),
        ...(capabilities.length ? { capabilities } : {}),
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));

  const dataFiles = loadDataFiles(resolved.root, connectorsOf(config), resources);
  const declared = new Map(dataFiles.collections.map((d) => [d.name, d]));
  const collections: CollectionEntry[] = [...resolved.collections.values()]
    .map((c) => ({
      name: c.name,
      ...(c.app !== undefined && { app: c.app }),
      ...(c.title !== undefined && { title: c.title }),
      key: c.key,
      fields: c.fields,
      record: { $id: `sanoma:collection/${c.name}`, ...toJsonSchema(recordSchemaOf(c), `${c.name} record`, "input") },
      ops: [c.get, c.list, c.save, c.delete].map((op) => op.id),
      ...(declared.has(c.name) && { declared: declared.get(c.name) }),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const ops: OpEntry[] = [...resolved.ops.values()].map((op) => ({
    ...policyOpOf(op),
    idempotent: op.idempotent,
    description: op.description,
    ...(op.phrases && { phrases: op.phrases }),
    direct: isDirect(op, resolved.types),
    input: toJsonSchema(op.input, `${op.id} input`, "input", refs),
    output: toJsonSchema(op.output, `${op.id} output`, "output", refs),
  }));
  ops.sort((a, b) => a.id.localeCompare(b.id));

  const read = memoised(readSource);
  const lint = memoised((file: SourceFile) => lintWorkflow(file));
  const workflows: WorkflowEntry[] = [...resolved.workflows.values()].map((wf) => {
    const file = read(wf.file);
    const { outline, source, found } = outlineWithSource(wf, file);
    // What the lint does not report: the file unread, or no workflow of this name in it.
    const own = "error" in outline && !found && (typeof file === "string" || !file.problems.length);
    const builtin = BUILT_IN_WORKFLOWS.has(wf.name);
    const problems = builtin
      ? []
      : [
          ...(typeof file === "string" ? [] : lint(file)),
          ...(own ? [{ line: 1, column: 1, message: outline.error }] : []),
        ];
    return {
      name: wf.name,
      ...(wf.app !== undefined && { app: wf.app }),
      title: wf.title,
      trigger: wf.trigger,
      ...(builtin && { builtin: true as const }),
      input: toJsonSchema(wf.input, `${wf.name} input`, "input"),
      ops: opIdsOf(wf),
      builtins: (wf.uses as Use[]).filter((u): u is Builtin => typeof u === "string"),
      file: wf.file,
      outline,
      problems,
      ...(source === undefined ? {} : { source }),
    };
  });
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  addApiNameProblems(workflows, new Set(ops.map((op) => op.vendor)));
  const { apps, problems: appProblems } = appsAt(resolved.root);
  const sites = readSites(
    resolved.root,
    { workflows, collections, ops },
    { vendors: new Set(Object.keys(vendors)), logins: new Set(resolved.logins.keys()) },
    resolved.policies,
  );

  return {
    secrets: {
      store: resolved.secrets.store?.id ?? "postgres",
      namespace: resolved.secrets.namespace ?? "default",
      bindings: Object.fromEntries(
        Object.entries(resolved.secrets.bindings ?? {}).map(([name, b]) => [
          name,
          {
            path: b.bootstrap ?? b.env ?? b.path!,
            management: b.management ?? (b.env || b.bootstrap ? "external" : "sanoma"),
            store: b.bootstrap ? "bootstrap" : b.env ? "environment" : (resolved.secrets.store?.id ?? "postgres"),
          },
        ]),
      ),
    },
    connections: [...resolved.connections.catalog.definitions.values()].map((d) => ({
      id: d.$connection,
      vendor: d.vendor,
      method: d.method,
      scopes: d.scopes,
      ...(d.account && { account: d.account }),
      default: d.default,
    })),
    appName: resolved.appName,
    version: resolved.version,
    workflows,
    ops,
    vendors,
    resourceTypes,
    collections,
    // An app's people are refused (`readPeople`), so the grid and the People page never show them.
    resources: dataFiles.resources.filter((r) => !inAppPeople(r)),
    orphans: dataFiles.orphans,
    problems: [
      ...dataFiles.problems,
      ...appProblems,
      ...appClashes(apps, collections, sites),
      ...domainProblems(dataFiles.resources, resources, sites),
    ],
    apps,
    policy: {
      defined: resolved.policy !== allowAll,
      ...(resolved.policy.version === undefined ? {} : { version: resolved.policy.version }),
      ...(resolved.policyProblems.length ? { problems: resolved.policyProblems } : {}),
      files: resolved.root === undefined ? [] : readPolicyFiles(resolved.root),
    },
    sites,
  };
}

/** That the root's `kind` `name`, in `file`, is named as an app is. */
const appClash = (kind: string, name: string, file: string): ResourceProblem => ({
  file,
  line: 1,
  column: 1,
  message: `the ${kind} ${name} is named as the app apps/${name} is: name it otherwise`,
});

/**
 * A collection or site at the root named as an app is: `api.data.<app>` and `/sites/<app>/` are
 * the app's, so the root's would take its place.
 */
function appClashes(
  apps: readonly AppEntry[],
  collections: readonly CollectionEntry[],
  sites: readonly SiteEntry[],
): ResourceProblem[] {
  const names = new Set(apps.map((app) => app.name));
  return [
    ...collections
      .filter((c) => c.app === undefined && names.has(c.name))
      .map((c) => appClash("collection", c.name, c.declared?.file ?? "resources/data.ts")),
    ...sites
      .filter((site) => site.app === undefined && names.has(site.name))
      .map((site) => appClash("site", site.name, `sites/${site.name}`)),
  ];
}

/**
 * Each site a host's `domains` (its type's `host.inputs.domains`) names that is not a public
 * site, and each domain it gives more than one site, at the host's declaration: the app serves
 * only a public site at a domain, and one site at each.
 */
function domainProblems(
  declared: readonly DeclaredResource[],
  types: ReadonlyMap<string, Resource>,
  sites: readonly SiteEntry[],
): ResourceProblem[] {
  const isPublic = new Set(sites.filter((site) => site.public).map((site) => site.name));
  const problems: ResourceProblem[] = [];
  for (const resource of declared) {
    const path = types.get(`${resource.vendor}.${resource.type}`)?.host?.inputs.domains;
    const domains = (path === undefined ? {} : (valueAt(resource.desired, path) ?? {})) as Record<string, unknown>;
    const messages = Object.keys(domains)
      .filter((name) => !isPublic.has(name))
      .map((name) => `domains names "${name}", which is not a public site (defineSite({ public: true }))`);
    const named = Object.entries(domains).filter(([, value]) => typeof value === "string");
    // A host name's case is not its own: `publicHosts` compares them lowercased.
    for (const [domain, entries] of Map.groupBy(named, ([, value]) => (value as string).toLowerCase())) {
      const names = entries.map(([name]) => name);
      if (names.length < 2) continue;
      const others = `${names.length === 2 ? "both " : ""}${names.slice(0, -1).join(", ")}`;
      messages.push(`${domain} is the domain of ${others} and ${names.at(-1)}`);
    }
    problems.push(...messages.map((message) => ({ ...resource.at, message })));
  }
  return problems;
}

/**
 * A site's `api` names each workflow `apiNameOf(name)` beside the vendors' operations and the
 * collections (`api.data`), so a workflow whose name comes out as another's, a vendor's id or
 * `data` is a problem, at 1:1 of its file. A built-in is never the one renamed.
 */
function addApiNameProblems(workflows: WorkflowEntry[], vendors: ReadonlySet<string>) {
  for (const wf of workflows) {
    if (wf.builtin) continue;
    const api = apiNameOf(wf.name);
    const others = workflows.filter((other) => other !== wf && apiNameOf(other.name) === api);
    const taken = others.length
      ? `as workflow ${others.map((other) => `"${other.name}"`).join(" and ")} is`
      : api === DATA_VENDOR
        ? "which is the collections'"
        : vendors.has(api)
          ? `which is the vendor ${api}'s operations`
          : api === "then"
            ? "which a promise would take for its own"
            : undefined;
    if (taken) wf.problems.push({ line: 1, column: 1, message: apiNameProblem(api, taken) });
  }
}

/** `fn`, called once per argument for as long as the returned function lives. */
function memoised<A, R>(fn: (arg: A) => R): (arg: A) => R {
  const seen = new Map<A, R>();
  return (arg) => {
    if (!seen.has(arg)) seen.set(arg, fn(arg));
    return seen.get(arg)!;
  };
}

/** A logo's SVG markup as a `data:` URL, for an `<img>`. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

const vendorEntry = (
  id: string,
  info: VendorInfo | undefined,
  fake: boolean,
  env: readonly CredentialStatus[] | undefined,
): VendorEntry => ({
  title: info?.title ?? id,
  ...(info?.logo && {
    logo: { src: svgDataUrl(info.logo.svg), ...(info.logo.dark && { dark: svgDataUrl(info.logo.dark) }) },
  }),
  ...(info?.package && { package: info.package }),
  ...(info?.homepage && { homepage: info.homepage }),
  fake,
  ...(env && {
    credentials: env.map(({ name, description, optional }) => ({
      name,
      ...(description !== undefined && { description }),
      ...(optional && { optional }),
    })),
  }),
});

/** Where a resource type's state schema is, for a `$ref`. */
const resourceTypeUri = (id: string) => `sanoma:resource-type/${id}`;

function toJsonSchema(
  schema: z.ZodType,
  what: string,
  io: "input" | "output",
  refs?: ReadonlyMap<unknown, string>,
): Record<string, unknown> {
  try {
    return jsonSchemaOf(schema, io, refs);
  } catch (e) {
    throw new Error(`Cannot describe ${what} as JSON Schema: ${(e as Error).message}`, { cause: e });
  }
}
