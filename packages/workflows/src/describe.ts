import { z } from "zod";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import { type Builtin, jsonSchemaOf, type Use } from "./define.ts";
import type { Fake } from "./fake.ts";
import { fill, seedFrom } from "./fill.ts";
import { type Effect, isOp, type Op, VENDOR, type VendorInfo } from "./op.ts";
import { type Outline, outlineWithSource } from "./outline.ts";
import { allowAll, policyOpOf } from "./policy.ts";
import type { ResourceFields } from "./resource.ts";
import { type DeclaredResource, readDataFiles, type ResourceProblem, resourceTypesOf } from "./resources.ts";
import { errorMessage } from "./shared.ts";

// `@sanoma/workflows/describe`: what a UI renders from. Apart from the main entry, so the
// worker never loads oxc-parser, which the outline reads `run` with.
export { outlineWorkflow, type Outline, type OutlineNode, type Span } from "./outline.ts";
// The reader parses data files with oxc-parser too.
export {
  readDataFiles,
  readResources,
  type DataFiles,
  type DeclaredResource,
  type ResourceProblem,
} from "./resources.ts";

/** What a workflow is, read from its definition: enough to draw a start form and show what it may call. */
export interface WorkflowEntry {
  name: string;
  title?: string;
  trigger: "manual";
  /** The input, as JSON Schema (draft 2020-12), from the zod schema. */
  input: Record<string, unknown>;
  /** Operation ids the workflow may call, in the order declared. */
  ops: string[];
  /** Built-ins the workflow may call. */
  builtins: Builtin[];
  /** What its `run` calls, in order, read from its source (`outlineWorkflow`): its file, or else `run`'s text. */
  outline: Outline;
  /**
   * The text the outline's spans index into: the file's, or `run`'s, with `\n` line endings.
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
  /**
   * A sample exchange with the vendor's fake, when the config has one in `fakes`: a made-up
   * input, and what the fake returned for it or the message of what it threw.
   */
  mock?: { input: unknown; output: unknown } | { input: unknown; error: string };
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
}

/** A resource type a connector declares with `defineResource`. */
export interface ResourceTypeEntry {
  /** `<vendor>.<type>`, such as `github.repository`. */
  id: string;
  vendor: string;
  type: string;
  title: string;
  /** How a declared resource's import id is made, such as `name` or `repository_id:pattern`. */
  identity: string;
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
  /** What is wrong in the data files, or in finding them, by file, line and column (`readDataFiles`). */
  problems: ResourceProblem[];
  /** `defined` is false for `allowAll`. */
  policy: { defined: boolean; version?: string };
}

/**
 * Describes a config. Throws what `startWorker` would refuse (see `resolveConfig`). The data
 * files' problems are data, `problems`, beside the resources read without any. Asynchronous
 * only for the operations' `mock`s, which call a fresh copy of each fake.
 */
export async function describeConfig(config: SanomaConfig): Promise<ConfigDescription> {
  const resolved = resolveConfig(config);
  const vendors: Record<string, VendorEntry> = {};
  // A vendor whose operations are split over several connectors is named by the first; its
  // resource types are every connector's.
  for (const connector of config.connectors) {
    const { id, info } = connector[VENDOR];
    vendors[id] ??= vendorEntry(id, info);
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

  const declared = [...resolved.ops.values()];
  const mocks = new Map<string, NonNullable<OpEntry["mock"]>>();
  for (const [vendor, fake] of resolved.fakes) {
    for (const [id, mock] of await samples(
      fake,
      declared.filter((op) => op.vendor === vendor),
    ))
      mocks.set(id, mock);
  }
  const ops: OpEntry[] = declared.map((op) => ({
    ...policyOpOf(op),
    idempotent: op.idempotent,
    description: op.description,
    ...(op.phrases && { phrases: op.phrases }),
    input: toJsonSchema(op.input, `${op.id} input`, "input", refs),
    output: toJsonSchema(op.output, `${op.id} output`, "output", refs),
    ...(mocks.has(op.id) && { mock: mocks.get(op.id) }),
  }));
  ops.sort((a, b) => a.id.localeCompare(b.id));

  const workflows: WorkflowEntry[] = [...resolved.workflows.values()].map((wf) => {
    const { outline, source } = outlineWithSource(wf);
    return {
      name: wf.name,
      title: wf.title,
      trigger: wf.trigger,
      input: toJsonSchema(wf.input, `${wf.name} input`, "input"),
      ops: (wf.uses as Use[]).filter(isOp).map((op) => op.id),
      builtins: (wf.uses as Use[]).filter((u): u is Builtin => typeof u === "string"),
      outline,
      ...(source === undefined ? {} : { source }),
    };
  });
  workflows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    appName: resolved.appName,
    version: resolved.version,
    workflows,
    ops,
    vendors,
    resourceTypes,
    ...readDataFiles(resolved.root, config.connectors, resources),
    policy: {
      defined: resolved.policy !== allowAll,
      ...(resolved.policy.version === undefined ? {} : { version: resolved.policy.version }),
    },
  };
}

/**
 * One sample call of each of a vendor's operations, in their declared order, on one fresh copy
 * of its fake, so the configured fake's state, calls and file are untouched. Each input is made
 * up from the operation's schema, seeded by its id so it is the same on every start, except
 * that a field named as a field of an earlier output takes that value (when its schema takes
 * it): a sample `publish` publishes the post the sample `create` made.
 */
async function samples(fake: Fake<any, any>, ops: Op[]) {
  const fresh = fake.fresh();
  const earlier: Record<string, unknown> = {};
  const mocks = new Map<string, NonNullable<OpEntry["mock"]>>();
  for (const op of ops) {
    const fn = fresh.driver.ops[op.id.slice(op.vendor.length + 1)];
    if (!fn) continue;
    const shape: Record<string, z.ZodType> = op.input instanceof z.ZodObject ? op.input.shape : {};
    const given = Object.fromEntries(
      Object.entries(earlier).filter(([name, value]) => shape[name]?.safeParse(value).success),
    );
    let input: unknown;
    try {
      seedFrom(op.id);
      input = fill(op.input, given);
    } catch (err) {
      mocks.set(op.id, { input: given, error: `Could not make up an input: ${errorMessage(err)}` });
      continue;
    }
    try {
      const output = await fn(input, { idempotencyKey: `sample:${op.id}`, runId: "sample", opId: op.id, attempt: 1 });
      mocks.set(op.id, { input, output });
      if (output !== null && typeof output === "object") Object.assign(earlier, output);
    } catch (err) {
      mocks.set(op.id, { input, error: errorMessage(err) });
    }
  }
  return mocks;
}

const svgDataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

const vendorEntry = (id: string, info: VendorInfo | undefined): VendorEntry => ({
  title: info?.title ?? id,
  ...(info?.logo && {
    logo: { src: svgDataUrl(info.logo.svg), ...(info.logo.dark && { dark: svgDataUrl(info.logo.dark) }) },
  }),
  ...(info?.package && { package: info.package }),
  ...(info?.homepage && { homepage: info.homepage }),
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
