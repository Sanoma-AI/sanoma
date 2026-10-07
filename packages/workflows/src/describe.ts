import { z } from "zod";
import type { SanomaConfig } from "./config.ts";
import type { Builtin, Use } from "./define.ts";
import { isOp, type Effect } from "./op.ts";

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
  workflows: WorkflowEntry[];
  ops: OpEntry[];
  policy: { defined: boolean };
}

export function describeConfig(config: SanomaConfig): ConfigDescription {
  const ops: OpEntry[] = [];
  for (const connector of config.connectors) {
    for (const resource of Object.values(connector) as Record<string, any>[]) {
      for (const op of Object.values(resource)) {
        ops.push({
          id: op.id,
          vendor: op.vendor,
          resource: op.resource,
          name: op.name,
          effect: op.effect,
          idempotent: op.idempotent,
          description: op.description,
          input: toJsonSchema(op.input, `${op.id} input`),
          output: toJsonSchema(op.output, `${op.id} output`),
        });
      }
    }
  }
  ops.sort((a, b) => a.id.localeCompare(b.id));

  const workflows: WorkflowEntry[] = config.workflows.map((wf) => ({
    name: wf.name,
    title: wf.title,
    trigger: wf.trigger,
    input: toJsonSchema(wf.input, `${wf.name} input`),
    ops: (wf.uses as Use[]).filter(isOp).map((op) => op.id),
    builtins: (wf.uses as Use[]).filter((u): u is Builtin => typeof u === "string"),
  }));
  workflows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    appName: config.appName ?? "sanoma",
    workflows,
    ops,
    policy: { defined: config.policy !== undefined },
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
