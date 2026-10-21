import type { z } from "zod";
import { type LintProblem, readSource, type SourceFile } from "./ast.ts";
import { type Field, recordSchemaOf } from "./collection.ts";
import { connectorsOf, resolveConfig, type SanomaConfig } from "./config.ts";
import { type Builtin, jsonSchemaOf, opIdsOf, type Use } from "./define.ts";
import { isDirect } from "./direct.ts";
import { lintWorkflow } from "./lint.ts";
import { type Effect, VENDOR, type VendorInfo } from "./op.ts";
import { type Outline, outlineWithSource } from "./outline.ts";
import { allowAll, policyOpOf } from "./policy.ts";
import { type ResourceFields, resourceTypesOf } from "./resource.ts";
import {
  type DataFiles,
  type DeclaredCollection,
  type DeclaredResource,
  readDataFiles,
  type ResourceProblem,
} from "./resources.ts";
import { apiNameProblem } from "./sdk.ts";
import { apiNameOf, BUILT_IN_WORKFLOWS, DATA_VENDOR } from "./shared.ts";
import { readSites, type SiteEntry } from "./sites.ts";

// `@sanoma-ai/workflows/describe`: what a UI renders from, apart from the main entry.
export { outlineWorkflow, type Outline, type OutlineNode, type Span } from "./outline.ts";
// The reader parses data files with oxc-parser too.
export type { LintProblem } from "./ast.ts";
export {
  admit,
  readDataFiles,
  readPeople,
  readResources,
  type DataFiles,
  type DeclaredCollection,
  type DeclaredPeople,
  type DeclaredResource,
  type ResourceProblem,
} from "./resources.ts";
// The writer: setting a resource's fields in its data file, and rendering a new one.
export { formatOptions, renderDataFile, setFields, type DataFileContent } from "./writer.ts";
export { Reference, type DataValue } from "./datafile.ts";
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
// What the sites call, read from their source: a workflow's Used by.
export { readSites, type SiteCall, type SiteEntry } from "./sites.ts";
// The generated SDK, `.sanoma/api.ts`: a site's `api` typed from this description.
export { API_FILE, generateApi, writeApi, writeGenerated } from "./sdk.ts";
// The Cedar schema, `.sanoma/schema.cedarschema`: what a company's policies are validated and decided against.
export { SCHEMA_FILE, schemaOf, schemaText, type CedarSchemaJson } from "./schema.ts";
// The apply workflow's plan and report, which the app renders.
export type { ApplyInput, ApplyPlan, ApplyReport, ApplyResult, PlanAnswer, PlanStep } from "./apply.ts";

/** What a workflow is, read from its definition: enough to draw a start form and show what it may call. */
export interface WorkflowEntry {
  name: string;
  title?: string;
  trigger: "manual";
  /**
   * Set for a workflow the runtime adds itself, `drift`, `apply` or `call`, rather than the config: a label. It
   * starts like any other.
   */
  builtin?: true;
  /** The input, as JSON Schema (draft 2020-12), from the zod schema. */
  input: Record<string, unknown>;
  /** Operation ids the workflow may call, in the order declared. */
  ops: string[];
  /** Built-ins the workflow may call. */
  builtins: Builtin[];
  /** The file that defined it, absolute. */
  file: string;
  /** What its `run` calls, in order, read from its file (`outlineWorkflow`), which the worker holds its runs to. */
  outline: Outline;
  /**
   * What is wrong in its file, by position: what `lintWorkflow` finds (syntax, an import a
   * workflow may not make, `instanceof` against the runtime's error classes, what the outline
   * cannot draw in each `run`), read the one way the outline is, so a check sees what the
   * worker refuses; and, at 1:1, an outline error that is the file's (it cannot be read, or holds
   * no workflow of this name). A file defining several workflows gives each its problems. Empty
   * for the built-in `drift`, which the package's tests hold to the lint.
   */
  problems: LintProblem[];
  /**
   * The text the outline's spans index into: the workflow's file, with `\n` line endings.
   * Absent only when the outline is `{ error }`. Whole files: a server may keep it from clients.
   */
  source?: string;
}

/** What an operation is, read from its connector: enough to badge it and show its contract. */
export interface OpEntry {
  id: string;
  vendor: string;
  resource: string;
  name: string;
  effect: Effect;
  idempotent: boolean;
  description?: string;
  /** How a scenario's steps name it: Cucumber expressions over its input's fields. */
  phrases?: { given?: string; expect?: string };
  /** Whether it may be called directly, outside a run (`isDirect`): the one rule, read here, never derived again. */
  direct: boolean;
  /** What a call sends, as JSON Schema (`io: "input"`: fields with defaults are optional). */
  input: Record<string, unknown>;
  /** What a call returns once its schema has parsed the vendor's reply (`io: "output"`). */
  output: Record<string, unknown>;
}

/** Who a vendor is, from its connector's `VendorInfo`: enough to name it, show its logo and link to its connector. */
export interface VendorEntry {
  /** The connector's `title`, else the vendor's id. */
  title: string;
  /** The logo as `data:image/svg+xml` URLs, for an `<img>`: `dark` is for dark backgrounds. */
  logo?: { src: string; dark?: string };
  /** The connector's npm package name. */
  package?: string;
  /** The connector package's `homepage` from its package.json: where its code and README are, as an https URL. */
  homepage?: string;
  /** Whether the vendor's connector attaches a fake (`withSetup`), for sandbox runs. */
  fake: boolean;
}

/** A resource type a connector declares with `defineResource`. */
export interface ResourceTypeEntry {
  /** `<vendor>.<type>`, such as `github.repository`. */
  id: string;
  vendor: string;
  type: string;
  title: string;
  /** How a declared resource's identity is made, such as `name` or `repository_id:pattern`; absent when it is found only by its binding. */
  identity?: string;
  /** Its flagged fields, by dotted path. */
  fields: ResourceFields;
  /**
   * Its state, as a read returns it, as JSON Schema (`io: "output"`), with `$id`
   * `sanoma:resource-type/<id>`: the operations' contracts `$ref` it instead of repeating it.
   */
  schema: Record<string, unknown>;
  /** Its operations' ids, sorted: `<id>.import` and `<id>.read`, and for a writable type its change operations. */
  ops: string[];
}

/** A collection the config declares (`collection()`). */
export interface CollectionEntry {
  name: string;
  title?: string;
  /** The field each record is found by. */
  key: string;
  /** Its fields as declared. */
  fields: Record<string, Field>;
  /** What `save` accepts, as JSON Schema, with `$id` `sanoma:collection/<name>`. */
  record: Record<string, unknown>;
  /** Its operations' ids: `data.<name>.get`, `.list`, `.save` and `.delete`. */
  ops: string[];
  /** Where `resources/data.ts` declares it, read as the data files are; absent for one declared elsewhere. */
  declared?: DeclaredCollection;
}

/**
 * A plain-JSON description of what a config can do: its workflows, the operations they call,
 * and whether a policy gates them. The app server builds it from the config and sends it to the
 * browser, so the UI shows exactly what the worker enforces. Never written by hand.
 */
export interface ConfigDescription {
  appName: string;
  /** The application version runs started now are stamped with. */
  version: string;
  workflows: WorkflowEntry[];
  ops: OpEntry[];
  /** Every vendor the operations are from, by its id (an `OpEntry`'s `vendor`). */
  vendors: Record<string, VendorEntry>;
  /** The resource types the connectors declare, by `id`. */
  resourceTypes: ResourceTypeEntry[];
  /** The config's collections, by name. */
  collections: CollectionEntry[];
  /**
   * The resources the data files under `resources/` declare, by file and then in file order,
   * less any with a problem and any that names one.
   */
  resources: DeclaredResource[];
  /** Each binding in the lockfile (`LOCKFILE`) whose key no data file declares, as `readDataFiles` reports it. */
  orphans: DataFiles["orphans"];
  /** What is wrong in the data files (`readDataFiles`), each at its file, relative to the root, line and column. A workflow's are on its entry. */
  problems: ResourceProblem[];
  /** `defined` is false for `allowAll`; `kind` is `cedar` for `policies/*.cedar` (`cedarPolicy`), else `function`. */
  policy: { defined: boolean; kind: "cedar" | "function"; version?: string };
  /**
   * The sites under `sites/`, by name, with what each calls (`readSites`), and its calls to what
   * the config does not have as its problems; none when the root has no `sites/`.
   */
  sites: SiteEntry[];
}

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
  // A vendor whose operations are split over several connectors is named by the first; its
  // resource types are every connector's.
  for (const connector of config.connectors) {
    const { id, info } = connector[VENDOR];
    vendors[id] ??= vendorEntry(id, info, resolved.fakes.has(id));
  }
  const resources = resourceTypesOf(connectorsOf(config));
  // Each resource type's state is described once, on its entry, and referenced from its operations.
  const refs = new Map<z.ZodType, string>([...resources].map(([id, r]) => [r.schema, resourceTypeUri(id)]));
  const resourceTypes: ResourceTypeEntry[] = [...resources]
    .map(([id, { vendor, type, title, identity, fields, schema, ops }]) => ({
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
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

  const dataFiles = readDataFiles(resolved.root, connectorsOf(config), resources);
  const declared = new Map(dataFiles.collections.map((d) => [d.name, d]));
  const collections: CollectionEntry[] = [...resolved.collections.values()]
    .map((c) => ({
      name: c.name,
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

  return {
    appName: resolved.appName,
    version: resolved.version,
    workflows,
    ops,
    vendors,
    resourceTypes,
    collections,
    resources: dataFiles.resources,
    orphans: dataFiles.orphans,
    problems: dataFiles.problems,
    policy: {
      defined: resolved.policy !== allowAll,
      kind: resolved.policy.kind ?? "function",
      ...(resolved.policy.version === undefined ? {} : { version: resolved.policy.version }),
    },
    sites: readSites(resolved.root, { workflows, collections, ops }),
  };
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

const svgDataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

const vendorEntry = (id: string, info: VendorInfo | undefined, fake: boolean): VendorEntry => ({
  title: info?.title ?? id,
  ...(info?.logo && {
    logo: { src: svgDataUrl(info.logo.svg), ...(info.logo.dark && { dark: svgDataUrl(info.logo.dark) }) },
  }),
  ...(info?.package && { package: info.package }),
  ...(info?.homepage && { homepage: info.homepage }),
  fake,
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
