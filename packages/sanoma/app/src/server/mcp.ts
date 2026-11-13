// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type Principal, RUNTIME_VERSION } from "sanoma/workflows";
import { isRecord, isVisitor } from "sanoma/workflows/shared";
import { z } from "zod";
import { ApiError } from "../api.ts";
import type { AppContext } from "../context.ts";
import { CATALOG, describedOn, runCatalog } from "./catalog.ts";
import { type ActorContext, actingFor, requireActor, toApiError } from "./core.ts";

// `/mcp`: the company's agent surface, an MCP server over Streamable HTTP, rendering the agent
// catalog (`catalog.ts`, which the chat's engines take too): each tool registered with its title,
// description (`describedOn`: with what is true of `/mcp` alone, its `id` and a hold answered as an
// error), hint and input, the optional `id` added where the tool takes an idempotency id, and
// run by `runCatalog` as the person asking, or as the declared agent a loopback request names
// acting for them (`actingFor`), so the policy and the ledger see who. A refusal is a tool error
// carrying `callApi`'s error body.

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

/** The catalog's six tools, as `actor`: read ones marked `readOnlyHint`, the start `destructiveHint`. */
function mcpServer(app: AppContext, actor: Principal): McpServer {
  // `listChanged: false`: the catalog is the same for every request, so nothing invites a listen.
  const server = new McpServer(
    { name: app.snapshot.description.appName, version: RUNTIME_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const spec of Object.values(CATALOG)) {
    const inputSchema: z.ZodObject =
      spec.idempotencyId === undefined ? spec.input : spec.input.extend({ id: CallId.describe(spec.idempotencyId) });
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: describedOn(spec.name, "mcp"),
        inputSchema,
        annotations: spec.hint === "read" ? { readOnlyHint: true } : { destructiveHint: true },
      },
      (args: { id?: string }) =>
        answer(spec.name, () =>
          runCatalog(app, spec.name, args, { actor, ...(args.id !== undefined && { id: args.id }) }),
        ),
    );
  }
  return server;
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
