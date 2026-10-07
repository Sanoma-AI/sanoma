import { z } from "zod";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import type { Builtin, Use } from "./define.ts";
import { isOp, type Effect } from "./op.ts";
import { allowAll } from "./policy.ts";

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
  input: Record<string, unknown>;
  output: Record<string, unknown>;
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
  /** `defined` is false for `allowAll`. */
  policy: { defined: boolean; version?: string };
}

/** Describes a config. Throws what `startWorker` would refuse (see `resolveConfig`); there is no partial description. */
export function describeConfig(config: SanomaConfig): ConfigDescription {
  const resolved = resolveConfig(config);
  const ops: OpEntry[] = [...resolved.ops.values()].map((op) => ({
    id: op.id,
    vendor: op.vendor,
    resource: op.resource,
    name: op.name,
    effect: op.effect,
    idempotent: op.idempotent,
    description: op.description,
    input: toJsonSchema(op.input, `${op.id} input`),
    output: toJsonSchema(op.output, `${op.id} output`),
  }));
  ops.sort((a, b) => a.id.localeCompare(b.id));

  const workflows: WorkflowEntry[] = resolved.workflows.map((wf) => ({
    name: wf.name,
    title: wf.title,
    trigger: wf.trigger,
    input: toJsonSchema(wf.input, `${wf.name} input`),
    ops: (wf.uses as Use[]).filter(isOp).map((op) => op.id),
    builtins: (wf.uses as Use[]).filter((u): u is Builtin => typeof u === "string"),
  }));
  workflows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    appName: resolved.appName,
    version: resolved.version,
    workflows,
    ops,
    policy: {
      defined: resolved.policy !== allowAll,
      ...(resolved.policyVersion === undefined ? {} : { version: resolved.policyVersion }),
    },
  };
}

function toJsonSchema(schema: z.ZodType, what: string): Record<string, unknown> {
  try {
    // Input schemas describe what a caller sends, so defaults stay optional (`io: "input"`).
    return z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "any" });
  } catch (e) {
    throw new Error(`Cannot describe ${what} as JSON Schema: ${(e as Error).message}`, { cause: e });
  }
}
