// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { Principal, RunSummary, SanomaClient } from "sanoma/workflows";
import {
  apiNameOf,
  approverLabel,
  builtInNamed,
  builtInRefusal,
  DESCRIBE_CALL,
  DRIFT_WORKFLOW,
  heldCallRunId,
} from "sanoma/workflows/shared";
import { z } from "zod";
import { ApiError, asApiError } from "../api.ts";
import type { LookupOutput, RunOutput, StillHeld } from "../lib/chat.ts";
import { agentDescription, type CallHost, callApi, noRun, parse, RESULT_WAIT_MS } from "./core.ts";

// The agent catalog: the six tools an agent is given, as data, and what each does, once. `/mcp`
// renders it as an MCP server (`server/mcp.ts`), the chat's engines as AI SDK tools
// (`steps/agent/tools.ts`), so the two cannot drift apart. Every tool is a call of `callApi` as the
// actor, or a read of a run as `callApi` reads one. A tool's `description` is what is true of it on
// both; what only one surface has (`/mcp`'s `id` argument and a hold answered as an error; the
// chat's hold and failed run answered as outputs) is that surface's own sentence (`on`,
// `describedOn`). The chat's answers for a call's run are built here too (`runOutput`,
// `lookupOutput`), once, for the tool as it runs and for `settle`. No AI SDK and no harness here:
// `/mcp` is in the Worker's bundle.

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
export interface CatalogTool<Input extends z.ZodObject = z.ZodObject, Name extends string = string> {
  name: Name;
  title: string;
  /** What it does, as true of `/mcp` as of the chat: no word of an `id` argument, or of how a hold or a failed run is answered. */
  description: string;
  /** What only one surface's rendering has, said after `description` (`describedOn`). */
  on?: { [S in CatalogSurface]?: string };
  /** Its input, without the call's id, which `idempotencyId` says it takes. */
  input: Input;
  /** A read changes nothing; a destructive tool starts what may. */
  hint: "read" | "destructive";
  /** What its idempotency id is, when it takes one (`CallRequest`'s `id`): a retry with the same id is the same call. */
  idempotencyId?: string;
}

/** Where the catalog is rendered: `/mcp`, whose caller sends each call's `id` and reads a hold as an error; or the chat's engines, whose calls are named for them and whose holds are outputs. */
export type CatalogSurface = "mcp" | "chat";

/** The chat's held call or start, as both of its tools that may be held say it. */
const CHAT_HOLD =
  "the person sees the approval's card in the chat, and the answer comes once it is decided; one still waiting " +
  'past the wait is answered with the run\'s id, status "waiting for approval" and waitsFor, whose decision it waits for';

/** The chat's started run, as both of its tools that start one say it. */
const CHAT_RUN =
  'A run that failed or was cancelled is answered with status "failed" or "cancelled", the run\'s id and its ' +
  "error: it did start, so do not start it again. " +
  `Held for an approval, ${CHAT_HOLD}.`;

const tool = <const Name extends string, Input extends z.ZodObject>(spec: CatalogTool<Input, Name>) => spec;

/** The six tools by name, in the order an agent is told them. */
export const CATALOG = {
  describe: tool({
    name: "describe",
    title: "Describe the company",
    description:
      "The company's own workflows (name, api name, title, trigger, input as JSON Schema), " +
      "the operations that may be called directly (id, effect, description, input and output as JSON Schema) " +
      "and its collections.",
    input: z.object({}),
    hint: "read",
  }),
  lookup: tool({
    name: "lookup",
    title: "Look something up",
    description:
      "Calls an operation whose effect is read and that may be called directly, as listed by describe, " +
      "with its input. The company's policy may refuse it, or hold it for an approval.",
    on: {
      mcp:
        "When it is held, the error names the held run, which wait_run reads. Retried with the same id and " +
        "input, a held lookup is the same held run; the same id with another input is refused.",
      chat: `When it is held, ${CHAT_HOLD}.`,
    },
    input: z.object({
      op: z.string().min(1).describe("The operation's id, such as ghost.post.list"),
      input: z.record(z.string(), z.unknown()).default({}).describe("Its input"),
    }),
    hint: "read",
    idempotencyId: "A new id per lookup (a UUID, say), sent again on a retry so a held one files one approval",
  }),
  get_run: tool({
    name: "get_run",
    title: "Read a run",
    description: "A run's workflow, status, who started it, when, its approvals and its error, by its id.",
    input: z.object({ runId: RunId }),
    hint: "read",
  }),
  wait_run: tool({
    name: "wait_run",
    title: "Wait for a run",
    description:
      "Waits for a run to end and answers its output. A run still going when the wait ends is answered " +
      'with status "running" and its id, to wait for again.',
    input: z.object({ runId: RunId, waitMs: WaitMs }),
    hint: "read",
  }),
  drift: tool({
    name: "drift",
    title: "Check for drift",
    description:
      "Starts the built-in drift workflow, which reads each declared resource from its vendor and compares it " +
      'with the data files, changing nothing. Answers its report when it ends within the wait, else status "running" ' +
      "and the run's id, for wait_run. A company that declares no resources has nothing to check, and says so.",
    on: { mcp: "Retried with the same id, it is the same run.", chat: CHAT_RUN },
    input: z.object({ waitMs: WaitMs }),
    hint: "read",
    idempotencyId: "A new id per check (a UUID, say), the run's id, sent again on a retry so it starts once",
  }),
  start_run: tool({
    name: "start_run",
    title: "Start a workflow",
    description:
      "Starts one of the company's own workflows, named as describe lists it, with its input, as the person " +
      "asking, or the agent acting for them. The runtime's own workflows are not started here; drift has its own tool.",
    on: {
      mcp:
        "Answers the run's id, for get_run and wait_run. Retried with the same id, workflow and input, " +
        "it answers the run already started; the same id for anything else is refused.",
      chat: `Answers the run's id and, when it ends within the wait, its output (status "finished"), else status "running", for wait_run. ${CHAT_RUN}`,
    },
    input: z.object({
      workflow: z.string().min(1).describe("The workflow's name or api name, as describe lists it"),
      input: z.record(z.string(), z.unknown()).default({}).describe("Its input, as its JSON Schema says"),
    }),
    hint: "destructive",
    idempotencyId: "A new id per start (a UUID, say), the run's id, sent again on a retry so it starts once",
  }),
} as const;

/** A tool's name. */
export type CatalogName = keyof typeof CATALOG;

/** The tool `name` as `surface` describes it: what is true of it everywhere, then what only that surface has. */
export const describedOn = (name: CatalogName, surface: CatalogSurface): string => {
  const { description, on }: CatalogTool = CATALOG[name];
  const own = on?.[surface];
  return own === undefined ? description : `${description} ${own}`;
};

/**
 * The catalog tool a tool call's name names: the name itself, or an MCP client's rendering of it
 * (`mcp__<server>__<name>`, as a coding agent names the tools its bridge serves it).
 */
export const catalogName = (name: string): CatalogName | undefined => {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return Object.hasOwn(CATALOG, bare) ? (bare as CatalogName) : undefined;
};

/**
 * The run a call of the tool `name` leaves, named by the call's idempotency id `id` when the tool
 * takes one (`idempotencyId`): a held lookup's is `agent`'s held call (`heldCallRunId`), any other
 * tool's the run it starts, whose id is the call's. None for a tool that takes no id, or no tool of
 * the catalog. From `CATALOG`, so a tool that comes to take an id is not missed.
 */
export const callRunId = (name: string, id: string, agent: string): string | undefined => {
  const named = catalogName(name);
  if (named === undefined || CATALOG[named].idempotencyId === undefined) return undefined;
  return named === "lookup" ? heldCallRunId(agent, id) : id;
};

/** A run that waits for its approvals, as the chat's tools answer it past their wait: whose decisions it waits for (`approverLabel`: a person's id, or "group <name>"). */
export const stillHeld = (run: RunSummary): StillHeld => ({
  held: { runId: run.runId },
  runId: run.runId,
  status: "waiting for approval",
  waitsFor: run.approvals.filter((a) => a.status === "pending").map(({ approver }) => approverLabel(approver)),
});

/**
 * What the chat's `start_run` and `drift` answer for the run `run`, just read (`RunOutput`): the
 * one function that builds it, for the tool as it runs and for `settle`. Still held while it waits
 * for an approval; its output once it finished (`SanomaClient.result`); its error once it failed or
 * was cancelled, an answer and no throw, since the run exists; else that it is running.
 */
export async function runOutput(client: Pick<SanomaClient, "result">, run: RunSummary): Promise<RunOutput> {
  const { runId, status } = run;
  if (status === "waiting") return stillHeld(run);
  if (status === "finished") return { runId, status, output: (await client.result(runId)) ?? null };
  if (status === "failed" || status === "cancelled") {
    return { runId, status, error: run.error ?? `Run ${runId} ${status === "cancelled" ? "was cancelled" : "failed"}` };
  }
  return { runId, status: "running" };
}

/** What the chat's `lookup` answers with the operation's `output` (`LookupOutput`), called directly or by a held call once it ended. */
export const lookupOutput = (output: unknown): LookupOutput => ({ output });

/** Who a catalog call is made as, its idempotency id where the tool takes one, and what ends its wait for a run early (`wait_run`'s and `drift`'s). */
export interface CatalogCall {
  actor: Principal;
  id?: string;
  signal?: AbortSignal;
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
  const { actor, signal } = call;
  const id = CATALOG[name].idempotencyId !== undefined && call.id !== undefined ? { id: call.id } : {};
  switch (name) {
    case "describe":
      return callApi(host, actor, { name: DESCRIBE_CALL });
    case "lookup": {
      const { op, input } = parse(CATALOG.lookup.input, args, "The input");
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
      return runNamed(host, parse(CATALOG.get_run.input, args, "The input").runId);
    case "wait_run": {
      const { runId, waitMs } = parse(CATALOG.wait_run.input, args, "The input");
      return resultOf(host, actor, (await runNamed(host, runId)).workflow, runId, { waitMs, signal });
    }
    case "drift": {
      const { waitMs } = parse(CATALOG.drift.input, args, "The input");
      const { runId } = await startDrift(host, actor, call.id);
      return resultOf(host, actor, DRIFT_WORKFLOW, runId, { waitMs, signal });
    }
    case "start_run": {
      const { workflow, input } = parse(CATALOG.start_run.input, args, "The input");
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

/**
 * `drift`'s start alone: the built-in drift workflow started as `actor`, its run named by `id` when
 * given (a retry with it is the same run), without waiting for it; a 400 `invalid_input` when the
 * company declares no resources, so has no drift to check.
 */
export async function startDrift(host: CallHost, actor: Principal, id?: string): Promise<{ runId: string }> {
  if (!host.snapshot.description.workflows.some((wf) => wf.name === DRIFT_WORKFLOW)) {
    throw new ApiError(400, {
      error: "This company declares no resources in its data files, so there is no drift to check",
      code: "invalid_input",
    });
  }
  const name = `${apiNameOf(DRIFT_WORKFLOW)}.start`;
  return (await callApi(host, actor, { name, input: {}, ...(id !== undefined && { id }) })) as { runId: string };
}

/** The run `runId` (`SanomaClient.run`, as `callApi` reads a run), or a 404 `run_not_found`. */
async function runNamed({ client }: Pick<CallHost, "client">, runId: string) {
  const run = await client.run(runId);
  if (!run) throw noRun(runId);
  return run;
}

/**
 * The output of the run `runId` of `workflow` once it ended, through `callApi`'s
 * `<workflow>.result`, as `{ runId, status: "finished", output }`; `{ runId, status: "running" }`
 * when it has not ended within the wait (its `run_running`), which is no failure. A failed run is
 * `callApi`'s failure. `signal` ends the wait early, with its reason.
 */
export async function resultOf(
  host: CallHost,
  actor: Principal,
  workflow: string,
  runId: string,
  { waitMs, signal }: { waitMs?: number; signal?: AbortSignal } = {},
) {
  try {
    const name = `${apiNameOf(workflow)}.result`;
    const input = { runId, ...(waitMs !== undefined && { waitMs }) };
    const output = await callApi(host, actor, { name, input }, { signal });
    return { runId, status: "finished", output: output ?? null };
  } catch (err) {
    if (asApiError(err).body.code === "run_running") return { runId, status: "running" };
    throw err;
  }
}
