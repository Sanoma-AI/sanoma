import type { z } from "zod";
import { type LintProblem, readSource, type SourceFile } from "./ast.ts";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import { type Builtin, jsonSchemaOf, opIdsOf, type Use } from "./define.ts";
import { DRIFT_WORKFLOW } from "./drift.ts";
import { lintWorkflow } from "./lint.ts";
import { type Effect, VENDOR, type VendorInfo } from "./op.ts";
import { type Outline, outlineWithSource } from "./outline.ts";
import { allowAll, policyOpOf } from "./policy.ts";
import { type ResourceFields, resourceTypesOf } from "./resource.ts";
import { type DeclaredResource, readDataFiles, type ResourceProblem } from "./resources.ts";

// `@sanoma-ai/workflows/describe`: what a UI renders from, apart from the main entry.
export { outlineWorkflow, type Outline, type OutlineNode, type Span } from "./outline.ts";
// The reader parses data files with oxc-parser too.
export type { LintProblem } from "./ast.ts";
export {
  readDataFiles,
  readResources,
  type DataFiles,
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

/** What a workflow is, read from its definition: enough to draw a start form and show what it may call. */
export interface WorkflowEntry {
  name: string;
  title?: string;
  trigger: "manual";
  /**
   * Set for a workflow the runtime adds itself, `drift`, rather than the config: a label. It
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
  /** Its operations' ids: `<id>.import` and `<id>.read`. */
  ops: string[];
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
  /**
   * The resources the data files under `resources/` declare, by file and then in file order,
   * less any with a problem and any that names one.
   */
  resources: DeclaredResource[];
  /** What is wrong in the data files (`readDataFiles`), each at its file, relative to the root, line and column. A workflow's are on its entry. */
  problems: ResourceProblem[];
  /** `defined` is false for `allowAll`. */
  policy: { defined: boolean; version?: string };
}

/**
 * Describes a config. Throws what `startWorker` would refuse (see `resolveConfig`), except missing
 * credentials (`SanomaClient.credentials` gives their statuses) and what is wrong in a workflow's
 * file, which the worker refuses when it reads the outline: that is data, on each workflow's
 * entry, as the data files' problems are, `problems`, beside the resources read without any.
 * Each workflow's file is read and parsed once, however many workflows it defines.
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
  const resources = resourceTypesOf(config.connectors);
  // Each resource type's state is described once, on its entry, and referenced from its operations.
  const refs = new Map<z.ZodType, string>([...resources].map(([id, r]) => [r.schema, resourceTypeUri(id)]));
  const resourceTypes: ResourceTypeEntry[] = [...resources]
    .map(([id, { vendor, type, title, identity, fields, schema }]) => ({
      id,
      vendor,
      type,
      title,
      identity,
      fields,
      schema: { $id: resourceTypeUri(id), ...toJsonSchema(schema, `${id} state`, "output") },
      ops: [`${id}.import`, `${id}.read`],
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

  const ops: OpEntry[] = [...resolved.ops.values()].map((op) => ({
    ...policyOpOf(op),
    idempotent: op.idempotent,
    description: op.description,
    ...(op.phrases && { phrases: op.phrases }),
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
    const problems =
      wf.name === DRIFT_WORKFLOW
        ? []
        : [
            ...(typeof file === "string" ? [] : lint(file)),
            ...(own ? [{ line: 1, column: 1, message: outline.error }] : []),
          ];
    return {
      name: wf.name,
      title: wf.title,
      trigger: wf.trigger,
      ...(wf.name === DRIFT_WORKFLOW && { builtin: true as const }),
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
  const dataFiles = readDataFiles(resolved.root, config.connectors, resources);

  return {
    appName: resolved.appName,
    version: resolved.version,
    workflows,
    ops,
    vendors,
    resourceTypes,
    resources: dataFiles.resources,
    problems: dataFiles.problems,
    policy: {
      defined: resolved.policy !== allowAll,
      ...(resolved.policy.version === undefined ? {} : { version: resolved.policy.version }),
    },
  };
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
