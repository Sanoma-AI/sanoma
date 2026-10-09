import type { z } from "zod";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import { type Builtin, jsonSchemaOf, type Use } from "./define.ts";
import { type Effect, isOp, VENDOR, type VendorInfo } from "./op.ts";
import { type Outline, outlineWithSource } from "./outline.ts";
import { allowAll, policyOpOf } from "./policy.ts";

// `@sanoma/workflows/describe`: what a UI renders from. Apart from the main entry, so the
// worker never loads oxc-parser, which the outline reads `run` with.
export { outlineWorkflow, type Outline, type OutlineNode, type Span } from "./outline.ts";

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
  /** `defined` is false for `allowAll`. */
  policy: { defined: boolean; version?: string };
}

/** Describes a config. Throws what `startWorker` would refuse (see `resolveConfig`); there is no partial description. */
export function describeConfig(config: SanomaConfig): ConfigDescription {
  const resolved = resolveConfig(config);
  const ops: OpEntry[] = [...resolved.ops.values()].map((op) => ({
    ...policyOpOf(op),
    idempotent: op.idempotent,
    description: op.description,
    ...(op.phrases && { phrases: op.phrases }),
    input: toJsonSchema(op.input, `${op.id} input`, "input"),
    output: toJsonSchema(op.output, `${op.id} output`, "output"),
  }));
  ops.sort((a, b) => a.id.localeCompare(b.id));

  const vendors: Record<string, VendorEntry> = {};
  // A vendor whose operations are split over several connectors is named by the first.
  for (const { [VENDOR]: vendor } of config.connectors) vendors[vendor.id] ??= vendorEntry(vendor.id, vendor.info);

  const workflows: WorkflowEntry[] = resolved.workflows.map((wf) => {
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
    policy: {
      defined: resolved.policy !== allowAll,
      ...(resolved.policy.version === undefined ? {} : { version: resolved.policy.version }),
    },
  };
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

function toJsonSchema(schema: z.ZodType, what: string, io: "input" | "output"): Record<string, unknown> {
  try {
    return jsonSchemaOf(schema, io);
  } catch (e) {
    throw new Error(`Cannot describe ${what} as JSON Schema: ${(e as Error).message}`, { cause: e });
  }
}
