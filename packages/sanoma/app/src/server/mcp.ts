// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type Principal, RUNTIME_VERSION } from "sanoma/workflows";
import {
  apiNameOf,
  BUILT_IN_WORKFLOWS,
  DESCRIBE_CALL,
  DRIFT_WORKFLOW,
  isRecord,
  isVisitor,
} from "sanoma/workflows/shared";
import { z } from "zod";
import { ApiError, asApiError } from "../api.ts";
import type { AppContext } from "../context.ts";
import {
  type ActorContext,
  actingFor,
  agentDescription,
  callApi,
  RESULT_WAIT_MS,
  requireActor,
  toApiError,
} from "./core.ts";

// `/mcp`: the company's agent surface, an MCP server over Streamable HTTP. Every tool that starts,
// calls or waits is a call of `callApi` as the person asking, or as the declared agent a loopback
// request names acting for them (`actingFor`), so the policy and the ledger see who; `get_run`,
// and finding a run's workflow for `wait_run`, read the run with `SanomaClient.run`, as
// `callApi`'s own reads of a run do. A refusal is a tool error carrying `callApi`'s error body.

/** How long `wait_run` and `drift` wait for a run at most: `callApi`'s `.result` wait. */
const WaitMs = z
  .number()
  .int()
  .min(0)
  .max(RESULT_WAIT_MS)
  .optional()
  .describe(`How long to wait for the run to end, in milliseconds; at most and by default ${RESULT_WAIT_MS}`);

const RunId = z.string().min(1).describe("The run's id");

/** A call's id, as `CallRequest` takes it: a retry with the same id is the same call. */
const CallId = z
  .string()
  .regex(/^[\w-]{1,200}$/, "An id is letters, digits, _ and -, at most 200")
  .optional();

/**
 * What the handler reports that is not a client's own mistake (a rejected or malformed request, a
 * method, media type or protocol version it does not take, or the refused `subscriptions/listen`,
 * each answered to the client): logged, as `toApiError` logs what it did not expect.
 */
function logUnexpected(error: Error): void {
  if (
    /^(Rejected |Invalid Request|Not Acceptable|Method not allowed|Unsupported (Media Type|protocol version)|subscriptions\/listen refused)/i.test(
      error.message,
    )
  ) {
    return;
  }
  console.error("sanoma app: an MCP request failed:", error);
}

/**
 * `POST /mcp` (the route answers a GET or a DELETE 405 itself): the request's
 * guards, then an MCP server built for it (`createMcpHandler`, at its default `legacy: 'stateless'`,
 * so a 2025-era client and a 2026-07-28 one are both served). A public site's host has no such
 * route (404); a request whose `Origin` is another site's is refused, so a page elsewhere cannot
 * drive it with the loopback cookie; nobody named is `requireActor`'s 400, a visitor a 403. On this
 * machine, an `x-sanoma-agent` header makes every call the named declared agent's on the person's
 * behalf (`actingFor`): an id that is no declared agent is `not_admitted`; on a host, a 400.
 */
export async function postMcp(request: Request, context: ActorContext & { site?: string }): Promise<Response> {
  if (context.site !== undefined) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    // Defence in depth behind the route's CSRF middleware, which already refuses another site's
    // `Sec-Fetch-Site` (anything but `same-origin`) or `Origin` (`null` too): this holds for a
    // caller of `postMcp` without the route, and compares hosts, so a proxy's scheme does not matter.
    if (!fromOwnOrigin(request)) {
      throw new ApiError(403, { error: "The agent surface answers no other site's page", code: "policy_denied" });
    }
    const person = await requireActor(context);
    if (isVisitor(person)) {
      throw new ApiError(403, { error: "A visitor may not use the agent surface", code: "policy_denied" });
    }
    const actor = actingFor(context.app, request, person);
    // No `subscriptions/listen` (`maxSubscriptions: 0`, answered at once with JSON-RPC -32603): the
    // tools never change, and an open stream would hold the request, and on the Worker its
    // database connection, for nothing.
    const handler = createMcpHandler(() => mcpServer(context.app, actor), {
      maxSubscriptions: 0,
      onerror: logUnexpected,
    });
    return await handler.fetch(request);
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

/** The six tools, as `actor`: read ones marked `readOnlyHint`, the start `destructiveHint`. */
function mcpServer(app: AppContext, actor: Principal): McpServer {
  // `listChanged: false`: the catalog is the same for every request, so nothing invites a listen.
  const server = new McpServer(
    { name: app.snapshot.description.appName, version: RUNTIME_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.registerTool(
    "describe",
    {
      title: "Describe the company",
      description:
        "The company's own workflows (name, api name, title, trigger, input as JSON Schema), " +
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
        "names the held run, which wait_run reads. Retried with the same id and input, a held lookup is the " +
        "same held run; the same id with another input is refused.",
      inputSchema: z.object({
        op: z.string().min(1).describe("The operation's id, such as ghost.post.list"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Its input"),
        id: CallId.describe(
          "A new id per lookup (a UUID, say), sent again on a retry so a held one files one approval",
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ op, input, id }) =>
      answer("lookup", () => {
        const declared = app.snapshot.description.ops.find((entry) => entry.id === op);
        if (declared?.effect !== "read" || !declared.direct) {
          throw new ApiError(400, {
            error: `${op} is not a lookup: only an operation whose effect is read and that may be called directly is`,
            code: "invalid_input",
          });
        }
        return callApi(app, actor, { name: op, input, ...(id !== undefined && { id }) });
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
        "and the run's id, for wait_run. Retried with the same id, it is the same run. A company that declares no " +
        "resources has nothing to check, and says so.",
      inputSchema: z.object({
        waitMs: WaitMs,
        id: CallId.describe("A new id per check (a UUID, say), the run's id, sent again on a retry so it starts once"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ waitMs, id }) =>
      answer("drift", async () => {
        if (!app.snapshot.description.workflows.some((wf) => wf.name === DRIFT_WORKFLOW)) {
          throw new ApiError(400, {
            error: "This company declares no resources in its data files, so there is no drift to check",
            code: "invalid_input",
          });
        }
        const name = `${apiNameOf(DRIFT_WORKFLOW)}.start`;
        const started = await callApi(app, actor, { name, input: {}, ...(id !== undefined && { id }) });
        return resultOf(app, actor, DRIFT_WORKFLOW, (started as { runId: string }).runId, waitMs);
      }),
  );

  server.registerTool(
    "start_run",
    {
      title: "Start a workflow",
      description:
        "Starts one of the company's own workflows, named as describe lists it, with its input, as the person " +
        "asking, or the agent acting for them. Answers the run's id, for get_run and wait_run. Retried with the same id, workflow and input, " +
        "it answers the run already started; the same id for anything else is refused. The runtime's own " +
        "workflows are not started here; drift has its own tool.",
      inputSchema: z.object({
        workflow: z.string().min(1).describe("The workflow's name or api name, as describe lists it"),
        input: z.record(z.string(), z.unknown()).default({}).describe("Its input, as its JSON Schema says"),
        id: CallId.describe("A new id per start (a UUID, say), the run's id, sent again on a retry so it starts once"),
      }),
      annotations: { destructiveHint: true },
    },
    ({ workflow, input, id }) =>
      answer("start_run", () => {
        const named = startable(app, workflow);
        return callApi(app, actor, { name: `${named.apiName}.start`, input, ...(id !== undefined && { id }) });
      }),
  );

  return server;
}

/**
 * The company's own workflow `workflow` names, by its name or api name exactly, as `describe`
 * lists it (`agentDescription`); a 400 `invalid_input` for anything else, saying when it is one of
 * the runtime's own, which no tool starts but `drift`.
 */
function startable(app: AppContext, workflow: string) {
  const named = agentDescription(app.snapshot.description).workflows.find(
    (wf) => wf.name === workflow || wf.apiName === workflow,
  );
  if (named) return named;
  const builtIn = [...BUILT_IN_WORKFLOWS].find((name) => name === workflow || apiNameOf(name) === workflow);
  throw new ApiError(400, {
    error: builtIn
      ? `${builtIn} is the runtime's own workflow: the runtime's own workflows are not started here (drift has the drift tool)`
      : `No workflow "${workflow}" to start: start_run starts one of the company's own workflows, by the name or api name describe lists (the runtime's own workflows are not started here; drift has the drift tool)`,
    code: "invalid_input",
  });
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
