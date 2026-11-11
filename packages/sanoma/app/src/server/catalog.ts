// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { Principal } from "sanoma/workflows";
import { apiNameOf, builtInNamed, builtInRefusal, DESCRIBE_CALL, DRIFT_WORKFLOW } from "sanoma/workflows/shared";
import { z } from "zod";
import { ApiError, asApiError } from "../api.ts";
import { agentDescription, type CallHost, callApi, parse, RESULT_WAIT_MS } from "./core.ts";

// The agent catalog: the six tools an agent is given, as data, and what each does, once. `/mcp`
// renders it as an MCP server (`server/mcp.ts`), the chat's engines as AI SDK tools
// (`steps/agent/tools.ts`), so the two cannot drift apart. Every tool is a call of `callApi` as the
// actor, or a read of a run as `callApi` reads one. No AI SDK and no harness here: `/mcp` is in the
// Worker's bundle.

/** How long `wait_run` and `drift` wait for a run at most: `callApi`'s `.result` wait. */
const WaitMs = z
  .number()
  .int()
  .min(0)
  .max(RESULT_WAIT_MS)
  .optional()
  .describe(`How long to wait for the run to end, in milliseconds; at most and by default ${RESULT_WAIT_MS}`);

const RunId = z.string().min(1).describe("The run's id");

/** One tool of the catalog. */
export interface CatalogTool<Input extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  /** Its input, without the call's id, which `idempotencyId` says it takes. */
  input: Input;
  /** A read changes nothing; a destructive tool starts what may. */
  hint: "read" | "destructive";
  /** What its idempotency id is, when it takes one (`CallRequest`'s `id`): a retry with the same id is the same call. */
  idempotencyId?: string;
}

const tool = <Input extends z.ZodObject>(spec: CatalogTool<Input>) => spec;

/** The six tools, in the order an agent is told them. */
export const CATALOG = [
  tool({
    name: "describe",
    title: "Describe the company",
    description:
      "The company's own workflows (name, api name, title, trigger, input as JSON Schema), " +
      "the operations that may be called directly (id, effect, description, input and output as JSON Schema) " +
      "and its collections.",
    input: z.object({}),
    hint: "read",
  }),
  tool({
    name: "lookup",
    title: "Look something up",
    description:
      "Calls an operation whose effect is read and that may be called directly, as listed by describe, " +
      "with its input. The company's policy may refuse it, or hold it for an approval: then the error " +
      "names the held run, which wait_run reads. Retried with the same id and input, a held lookup is the " +
      "same held run; the same id with another input is refused.",
    input: z.object({
      op: z.string().min(1).describe("The operation's id, such as ghost.post.list"),
      input: z.record(z.string(), z.unknown()).default({}).describe("Its input"),
    }),
    hint: "read",
    idempotencyId: "A new id per lookup (a UUID, say), sent again on a retry so a held one files one approval",
  }),
  tool({
    name: "get_run",
    title: "Read a run",
    description: "A run's workflow, status, who started it, when, its approvals and its error, by its id.",
    input: z.object({ runId: RunId }),
    hint: "read",
  }),
  tool({
    name: "wait_run",
    title: "Wait for a run",
    description:
      "Waits for a run to end and answers its output. A run still going when the wait ends is answered " +
      'with status "running" and its id, to wait for again.',
    input: z.object({ runId: RunId, waitMs: WaitMs }),
    hint: "read",
  }),
  tool({
    name: "drift",
    title: "Check for drift",
    description:
      "Starts the built-in drift workflow, which reads each declared resource from its vendor and compares it " +
      'with the data files, changing nothing. Answers its report when it ends within the wait, else status "running" ' +
      "and the run's id, for wait_run. Retried with the same id, it is the same run. A company that declares no " +
      "resources has nothing to check, and says so.",
    input: z.object({ waitMs: WaitMs }),
    hint: "read",
    idempotencyId: "A new id per check (a UUID, say), the run's id, sent again on a retry so it starts once",
  }),
  tool({
    name: "start_run",
    title: "Start a workflow",
    description:
      "Starts one of the company's own workflows, named as describe lists it, with its input, as the person " +
      "asking, or the agent acting for them. Answers the run's id, for get_run and wait_run. Retried with the same id, workflow and input, " +
      "it answers the run already started; the same id for anything else is refused. The runtime's own " +
      "workflows are not started here; drift has its own tool.",
    input: z.object({
      workflow: z.string().min(1).describe("The workflow's name or api name, as describe lists it"),
      input: z.record(z.string(), z.unknown()).default({}).describe("Its input, as its JSON Schema says"),
    }),
    hint: "destructive",
    idempotencyId: "A new id per start (a UUID, say), the run's id, sent again on a retry so it starts once",
  }),
] as const;

/** A tool's name. */
export type CatalogName = (typeof CATALOG)[number]["name"];

/** Who a catalog call is made as, and its idempotency id where the tool takes one. */
export interface CatalogCall {
  actor: Principal;
  id?: string;
}

/**
 * Runs the tool `name` with `args` (its input, parsed again here: a 400 `invalid_input` for what
 * it refuses) as `call.actor` against `host`: what it answers, or `callApi`'s `ApiError`s and the
 * client's errors as they are thrown. `call.id` is the call's idempotency id, used only by a tool
 * that takes one.
 */
export async function runCatalog(
  host: CallHost,
  name: CatalogName,
  args: unknown,
  call: CatalogCall,
): Promise<unknown> {
  const spec = CATALOG.find((t) => t.name === name);
  if (!spec) throw new ApiError(400, { error: `No tool ${name as string}`, code: "invalid_input" });
  const { actor } = call;
  const id = spec.idempotencyId !== undefined && call.id !== undefined ? { id: call.id } : {};
  switch (spec.name) {
    case "describe":
      return callApi(host, actor, { name: DESCRIBE_CALL });
    case "lookup": {
      const { op, input } = parse(spec.input, args, "The input");
      // The lookup rule: an operation the description lists as a read that may be called directly.
      const declared = host.snapshot.description.ops.find((entry) => entry.id === op);
      if (declared?.effect !== "read" || !declared.direct) {
        throw new ApiError(400, {
          error: `${op} is not a lookup: only an operation whose effect is read and that may be called directly is`,
          code: "invalid_input",
        });
      }
      return callApi(host, actor, { name: op, input, ...id });
    }
    case "get_run":
      return runNamed(host, parse(spec.input, args, "The input").runId);
    case "wait_run": {
      const { runId, waitMs } = parse(spec.input, args, "The input");
      return resultOf(host, actor, (await runNamed(host, runId)).workflow, runId, waitMs);
    }
    case "drift": {
      const { waitMs } = parse(spec.input, args, "The input");
      if (!host.snapshot.description.workflows.some((wf) => wf.name === DRIFT_WORKFLOW)) {
        throw new ApiError(400, {
          error: "This company declares no resources in its data files, so there is no drift to check",
          code: "invalid_input",
        });
      }
      const started = await callApi(host, actor, { name: `${apiNameOf(DRIFT_WORKFLOW)}.start`, input: {}, ...id });
      return resultOf(host, actor, DRIFT_WORKFLOW, (started as { runId: string }).runId, waitMs);
    }
    case "start_run": {
      const { workflow, input } = parse(spec.input, args, "The input");
      const named = startable(host, workflow);
      return callApi(host, actor, { name: `${named.apiName}.start`, input, ...id });
    }
  }
}

/**
 * The company's own workflow `workflow` names, by its name or api name exactly, as `describe`
 * lists it (`agentDescription`); a 400 `invalid_input` for anything else, saying when it is one of
 * the runtime's own, which no tool starts but `drift`.
 */
function startable(host: CallHost, workflow: string) {
  const named = agentDescription(host.snapshot.description).workflows.find(
    (wf) => wf.name === workflow || wf.apiName === workflow,
  );
  if (named) return named;
  const builtIn = builtInNamed(workflow);
  throw new ApiError(400, {
    error: builtIn
      ? `${builtInRefusal(builtIn)} (drift has the drift tool)`
      : `No workflow "${workflow}" to start: start_run starts one of the company's own workflows, by the name or api name describe lists (the runtime's own workflows are not started here; drift has the drift tool)`,
    code: "invalid_input",
  });
}

/** The run `runId` (`SanomaClient.run`, as `callApi` reads a run), or a 404 `run_not_found`. */
async function runNamed({ client }: Pick<CallHost, "client">, runId: string) {
  const run = await client.run(runId);
  if (!run) throw new ApiError(404, { error: `No run ${runId}`, code: "run_not_found" });
  return run;
}

/**
 * The run's output once it ended, through `callApi`'s `<workflow>.result`, as `{ runId, status:
 * "finished", output }`; `{ runId, status: "running" }` when it has not ended within the wait (its
 * `run_running`), which is no failure. A failed run is `callApi`'s failure.
 */
async function resultOf(host: CallHost, actor: Principal, workflow: string, runId: string, waitMs?: number) {
  try {
    const name = `${apiNameOf(workflow)}.result`;
    const output = await callApi(host, actor, { name, input: { runId, ...(waitMs !== undefined && { waitMs }) } });
    return { runId, status: "finished", output: output ?? null };
  } catch (err) {
    if (asApiError(err).body.code === "run_running") return { runId, status: "running" };
    throw err;
  }
}
