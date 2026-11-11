// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type Principal, RUNTIME_VERSION } from "sanoma/workflows";
import { apiNameOf, DESCRIBE_CALL, DRIFT_WORKFLOW, isVisitor } from "sanoma/workflows/shared";
import { z } from "zod";
import { ApiError, asApiError } from "../api.ts";
import type { AppContext } from "../context.ts";
import { type ActorContext, callApi, RESULT_WAIT_MS, requireActor, toApiError } from "./core.ts";

// `/mcp`: the company's agent surface, an MCP server over Streamable HTTP. Every tool is a call of
// `callApi` (or of the client functions it reads runs with) as the person asking, so the policy
// and the ledger see the person; a refusal is a tool error carrying `callApi`'s error body.

/** How long `wait_run` and `drift` wait for a run at most: `callApi`'s `.result` wait. */
const WaitMs = z
  .number()
  .int()
  .min(0)
  .max(RESULT_WAIT_MS)
  .optional()
  .describe(`How long to wait for the run to end, in milliseconds; at most and by default ${RESULT_WAIT_MS}`);

const RunId = z.string().min(1).describe("The run's id");

/**
 * `POST /mcp` (and its GET and DELETE, which the stateless server answers 405): the request's
 * guards, then an MCP server built for it (`createMcpHandler`, at its default `legacy: 'stateless'`,
 * so a 2025-era client and a 2026-07-28 one are both served). A public site's host has no such
 * route (404); a request whose `Origin` is another site's is refused, so a page elsewhere cannot
 * drive it with the loopback cookie; nobody named is `requireActor`'s 400, a visitor a 403.
 */
export async function postMcp(request: Request, context: ActorContext & { site?: string }): Promise<Response> {
  if (context.site !== undefined) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    if (!fromOwnOrigin(request)) {
      throw new ApiError(403, { error: "The agent surface answers no other site's page", code: "policy_denied" });
    }
    const actor = await requireActor(context);
    if (isVisitor(actor)) {
      throw new ApiError(403, { error: "A visitor may not use the agent surface", code: "policy_denied" });
    }
    return await createMcpHandler(() => mcpServer(context.app, actor)).fetch(request);
  } catch (err) {
    const { status, body } = toApiError(err, "an MCP request");
    return Response.json(body, { status });
  }
}

/** True without an `Origin` (an MCP client sends none), or with one naming the request's own host. */
function fromOwnOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return URL.parse(origin)?.host === new URL(request.url).host;
}

/** The six tools, each a call of `callApi` as `actor`: read ones marked `readOnlyHint`, the start `destructiveHint`. */
function mcpServer(app: AppContext, actor: Principal): McpServer {
  const server = new McpServer({ name: app.snapshot.description.appName, version: RUNTIME_VERSION });

  server.registerTool(
    "describe",
    {
      title: "Describe the company",
      description:
        "The company's workflows (name, api name, title, trigger, whether built in, input as JSON Schema), " +
        "the operations that may be called directly (id, effect, description, input and output as JSON Schema) " +
        "and its collections.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => answer("describe", () => callApi(app, actor, { name: DESCRIBE_CALL })),
  );

  server.registerTool(
    "lookup",
    {
      title: "Look something up",
      description:
        "Calls an operation whose effect is read and that may be called directly, as listed by describe, " +
        "with its input. The company's policy may refuse it, or hold it for an approval: then the error " +
        "names the held run, which wait_run reads.",
      inputSchema: z.object({
        op: z.string().min(1).describe("The operation's id, such as ghost.post.list"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Its input"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ op, input }) =>
      answer("lookup", () => {
        const declared = app.snapshot.description.ops.find((entry) => entry.id === op);
        if (declared?.effect !== "read" || !declared.direct) {
          throw new ApiError(400, {
            error: `${op} is not a lookup: only an operation whose effect is read and that may be called directly is`,
            code: "invalid_input",
          });
        }
        return callApi(app, actor, { name: op, input });
      }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Read a run",
      description: "A run's workflow, status, who started it, when, its approvals and its error, by its id.",
      inputSchema: z.object({ runId: RunId }),
      annotations: { readOnlyHint: true },
    },
    ({ runId }) => answer("get_run", () => runNamed(app, runId)),
  );

  server.registerTool(
    "wait_run",
    {
      title: "Wait for a run",
      description:
        "Waits for a run to end and answers its output. A run still going when the wait ends is answered " +
        'with status "running" and its id, to wait for again.',
      inputSchema: z.object({ runId: RunId, waitMs: WaitMs }),
      annotations: { readOnlyHint: true },
    },
    ({ runId, waitMs }) =>
      answer("wait_run", async () => resultOf(app, actor, (await runNamed(app, runId)).workflow, runId, waitMs)),
  );

  server.registerTool(
    "drift",
    {
      title: "Check for drift",
      description:
        "Starts the built-in drift workflow, which reads each declared resource from its vendor and compares it " +
        'with the data files, changing nothing. Answers its report when it ends within the wait, else status "running" ' +
        "and the run's id, for wait_run.",
      inputSchema: z.object({ waitMs: WaitMs }),
      annotations: { readOnlyHint: true },
    },
    ({ waitMs }) =>
      answer("drift", async () => {
        const { runId } = (await callApi(app, actor, { name: `${apiNameOf(DRIFT_WORKFLOW)}.start`, input: {} })) as {
          runId: string;
        };
        return resultOf(app, actor, DRIFT_WORKFLOW, runId, waitMs);
      }),
  );

  server.registerTool(
    "start_run",
    {
      title: "Start a workflow",
      description:
        "Starts one of the company's workflows, named as describe lists it, with its input, as the person " +
        "asking. Answers the run's id, for get_run and wait_run. The runtime's own workflows are not started here.",
      inputSchema: z.object({
        workflow: z.string().min(1).describe("The workflow's name or api name"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Its input, as its JSON Schema says"),
      }),
      annotations: { destructiveHint: true },
    },
    ({ workflow, input }) =>
      answer("start_run", () => {
        const api = apiNameOf(workflow);
        const named = app.snapshot.description.workflows.find((wf) => apiNameOf(wf.name) === api);
        if (named?.builtin) {
          throw new ApiError(400, {
            error: `${named.name} is the runtime's own workflow, which start_run does not start`,
            code: "invalid_input",
          });
        }
        return callApi(app, actor, { name: `${api}.start`, input });
      }),
  );

  return server;
}

/** The run `runId` (`SanomaClient.run`, as `callApi` reads a run), or a 404 `run_not_found`. */
async function runNamed({ client }: AppContext, runId: string) {
  const run = await client.run(runId);
  if (!run) throw new ApiError(404, { error: `No run ${runId}`, code: "run_not_found" });
  return run;
}

/**
 * The run's output once it ended, through `callApi`'s `<workflow>.result`, as `{ runId, status:
 * "finished", output }`; `{ runId, status: "running" }` when it has not ended within the wait (its
 * `run_running`), which is no failure. A failed run is `callApi`'s failure.
 */
async function resultOf(app: AppContext, actor: Principal, workflow: string, runId: string, waitMs?: number) {
  try {
    const name = `${apiNameOf(workflow)}.result`;
    const output = await callApi(app, actor, { name, input: { runId, ...(waitMs !== undefined && { waitMs }) } });
    return { runId, status: "finished", output: output ?? null };
  } catch (err) {
    if (asApiError(err).body.code === "run_running") return { runId, status: "running" };
    throw err;
  }
}

/**
 * A tool's answer: what `call` gave, as JSON text and as the structured content; or, when it threw,
 * a tool error carrying `callApi`'s error body (`toApiError`: its `code`, and `runId` where there is one).
 */
async function answer(what: string, call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = (await call()) ?? null;
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      ...(isRecord(value) && { structuredContent: value }),
    };
  } catch (err) {
    const { status, body } = toApiError(err, `the MCP tool ${what}`);
    const error = { ...body, status };
    return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
