import type { z } from "zod";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import { type Builtin, jsonSchemaOf, type Use } from "./define.ts";
import { DRIFT_WORKFLOW } from "./drift.ts";
import type { Fake } from "./fake.ts";
import { fill, isBug, seedFrom, shapeOf } from "./fill.ts";
import { type Effect, isOp, type Op, VENDOR, type VendorInfo } from "./op.ts";
import { type Outline, outlineWithSource } from "./outline.ts";
import { allowAll, policyOpOf } from "./policy.ts";
import { type ResourceFields, resourceTypesOf } from "./resource.ts";
import { type DeclaredResource, readDataFiles, type ResourceProblem } from "./resources.ts";
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
   * input, and what the fake returned for it, parsed by `output`, or why it did not (what it
   * threw, or how its reply is off the contract). `input` is null when the fake does not
   * implement the operation.
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
 * only for the operations' `mock`s, which call a fresh copy of each fake: a fake that crashes,
 * or an input faker cannot make up, throws too.
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
  const mocks = new Map<string, Mock>();
  for (const [vendor, fake] of resolved.fakes) {
    await samples(
      vendor,
      fake,
      declared.filter((op) => op.vendor === vendor),
      mocks,
    );
  }
  const ops: OpEntry[] = declared.map((op) => {
    const mock = mocks.get(op.id);
    return {
      ...policyOpOf(op),
      idempotent: op.idempotent,
      description: op.description,
      ...(op.phrases && { phrases: op.phrases }),
      input: toJsonSchema(op.input, `${op.id} input`, "input", refs),
      output: toJsonSchema(op.output, `${op.id} output`, "output", refs),
      ...(mock && { mock }),
    };
  });
  ops.sort((a, b) => a.id.localeCompare(b.id));

  const workflows: WorkflowEntry[] = [...resolved.workflows.values()].map((wf) => {
    const { outline, source } = outlineWithSource(wf);
    return {
      name: wf.name,
      title: wf.title,
      trigger: wf.trigger,
      ...(wf.name === DRIFT_WORKFLOW && { builtin: true as const }),
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

type Mock = NonNullable<OpEntry["mock"]>;

/**
 * One sample call of each of a vendor's operations, in their declared order, on one fresh copy
 * of its fake, so the configured fake's state, calls and file are untouched, into `mocks`. Each
 * input is made up from the operation's schema, seeded by its id so it is the same on every
 * start, except that a field named as a field of an earlier output takes that value (when its
 * schema takes it): a sample `publish` publishes the post the sample `create` made. The reply is
 * parsed by the operation's output schema. What a vendor may do, failing or answering off its
 * contract, is the mock's `error`; a bug in the fake (a `TypeError` and the like) or an input
 * faker cannot make up throws, naming the operation.
 */
async function samples(vendor: string, fake: Fake<any, any>, ops: Op[], mocks: Map<string, Mock>) {
  let fresh: Fake<any, any>;
  try {
    fresh = fake.fresh();
  } catch (err) {
    throw new Error(`Cannot sample ${vendor}'s fake: ${errorMessage(err)}`, { cause: err });
  }
  const earlier: Record<string, unknown> = {};
  for (const op of ops) {
    const fn = fresh.driver.ops[`${op.resource}.${op.name}`];
    if (!fn) {
      mocks.set(op.id, { input: null, error: `The ${op.vendor} fake does not implement ${op.id}` });
      continue;
    }
    const shape = shapeOf(op.input);
    const given = Object.fromEntries(
      Object.entries(earlier).filter(
        ([name, value]) => Object.hasOwn(shape, name) && shape[name]!.safeParse(value).success,
      ),
    );
    let filled = false;
    let input: unknown = null;
    try {
      seedFrom(op.id);
      const made = fill(op.input, given);
      filled = true;
      input = plain(made, "The made-up input");
      const call = { idempotencyKey: `sample:${op.id}`, runId: "sample", opId: op.id, attempt: 1 };
      const reply = op.output.safeParse(await fn(made, call));
      if (!reply.success) throw new Error(`${op.id}'s fake answered off its contract: ${firstIssue(reply.error)}`);
      mocks.set(op.id, { input, output: plain(reply.data, "The reply") });
      if (reply.data !== null && typeof reply.data === "object") Object.assign(earlier, reply.data);
    } catch (err) {
      if (!filled) throw new Error(`Cannot make up an input for ${op.id}: ${errorMessage(err)}`, { cause: err });
      if (isBug(err)) throw new Error(`Sampling ${op.id} on its fake: ${errorMessage(err)}`, { cause: err });
      mocks.set(op.id, { input, error: errorMessage(err) });
    }
  }
}

/** The value as plain JSON, as `describeConfig` returns it; one JSON cannot carry (a BigInt, a cycle) is an error. */
function plain(value: unknown, what: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch (err) {
    // JSON.stringify throws a TypeError, which is no bug here.
    throw new Error(`${what} is not plain JSON: ${errorMessage(err)}`, { cause: err });
  }
}

/** A parse error's first issue: where, and what. */
function firstIssue({ issues: [issue] }: z.ZodError): string {
  const at = issue!.path.map(String).join(".");
  return at ? `${at}: ${issue!.message}` : issue!.message;
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
