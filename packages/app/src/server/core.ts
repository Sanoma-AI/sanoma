import {
  type ApprovalState,
  errorCode,
  errorMessage,
  invalidInput,
  Principal,
  type SanomaError,
} from "@sanoma/workflows";
import type { z } from "zod";
import {
  ACTOR_HEADER,
  ApiError,
  type DecideCall,
  type ErrorResponse,
  type InputIssue,
  type RunDetail,
  type StartRunRequest,
  type StartRunResponse,
} from "../api.ts";
import type { AppContext } from "../context.ts";

// What the API routes and the server functions both do. Server-only: each takes the app
// context that startApp passes with every request. Every expected failure is an ApiError.

/**
 * Who is making a change (resolved once per request, in start.ts), or a 400 when nobody is
 * named. Only the default resolver reads the header, so only then does the answer name it.
 */
export function requireActor({
  app,
  actor,
  actorError,
}: {
  app: AppContext;
  actor?: Principal | undefined;
  /** Set when `resolveActor` threw: a 500, already logged. */
  actorError?: ApiError | undefined;
}): Principal {
  if (actorError) throw actorError;
  const parsed = Principal.safeParse(actor);
  if (parsed.success) return parsed.data;
  const error = app.actorFromHeader
    ? `Say who you are in the ${ACTOR_HEADER} header`
    : "This request does not say who is making it: sign in";
  throw new ApiError(400, { error, code: "invalid_input" });
}

/** The value, parsed by the schema, or a 400 `invalid_input` with zod's issues. */
export function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw asApiError(invalidInput(what, parsed.error.issues));
}

/** The run with its ledger and approvals, or a 404. */
export async function runDetail({ client, resolved }: AppContext, runId: string): Promise<RunDetail> {
  const run = await client.run(runId);
  if (!run) throw new ApiError(404, { error: `No run ${runId}`, code: "run_not_found" });
  const { approvals } = run;
  try {
    return { run, ledger: await resolved.ledger.read(runId), approvals };
  } catch (err) {
    // A store reads a run nothing has recorded as no records, so this is a real failure (a
    // corrupt file, a permission): logged for the operator, and the page shows the run and why
    // its ledger is missing.
    console.error(`sanoma app: could not read the ledger of run ${runId}:`, err);
    return { run, ledger: [], ledgerError: errorMessage(err), approvals };
  }
}

export async function startRun(
  { client, resolved }: AppContext,
  actor: Principal,
  body: StartRunRequest,
): Promise<StartRunResponse> {
  const workflow = resolved.workflows.find((wf) => wf.name === body.workflow);
  if (!workflow) {
    throw new ApiError(404, {
      error: `No workflow named "${body.workflow}"`,
      code: "invalid_input",
      issues: [{ path: ["workflow"], message: `No workflow named "${body.workflow}"`, code: "invalid_value" }],
    });
  }
  return { runId: await client.start(workflow, body.input, { startedBy: actor }) };
}

/**
 * Sends the decision, then answers with the approval once the run has read it, or as it stands
 * after 5 s: still `pending` when the run has not read it (no worker running, say).
 */
export function decide({ client }: AppContext, actor: Principal, call: DecideCall): Promise<ApprovalState> {
  const note = call.note?.trim() || undefined;
  return client.decide(call.runId, { decision: call.decision, by: actor, note }, call.approvalId, {
    timeoutSeconds: 5,
  });
}

const STATUS: Partial<Record<NonNullable<ErrorResponse["code"]>, number>> = {
  invalid_input: 400,
  not_approver: 403,
  run_not_found: 404,
  no_pending_approval: 404,
  already_decided: 409,
  run_ended: 409,
};

/** True for zod's error, by name: a server function's validator may use another copy of zod. */
const isZodError = (err: unknown): err is { issues: z.core.$ZodIssue[] } =>
  err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues);

/**
 * An ApiError for any error: the runtime's codes get their status, a server function's
 * validator refusing its argument is a 400 with zod's issues, and anything else is a 500.
 */
export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (isZodError(err)) err = invalidInput("The request", err.issues);
  const code = errorCode(err);
  const status = (code && STATUS[code]) || 500;
  const body: ErrorResponse = { error: errorMessage(err), code };
  // Read by property, not instanceof: DBOS hands a run's errors back as copies.
  const data: Record<string, unknown> = (err as Partial<SanomaError>).data ?? {};
  if (status !== 500 && Array.isArray(data.issues)) body.issues = data.issues as InputIssue[];
  if (code === "not_approver") body.approver = data.approver as ErrorResponse["approver"];
  return new ApiError(status, body);
}

/**
 * `asApiError`, logging what it turns into a 500: only those are unexpected. An ApiError was
 * made on purpose, and a 500 one is logged where it was made.
 */
export function toApiError(err: unknown, where: string): ApiError {
  const api = asApiError(err);
  if (api.status >= 500 && !(err instanceof ApiError)) console.error(`sanoma app: ${where} failed:`, err);
  return api;
}

/** A JSON response for any error. */
export function errorResponse(err: unknown, where: string): Response {
  const api = toApiError(err, where);
  return json(api.body, api.status);
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * The request's JSON body, or a 400. The content type must say JSON: a browser cannot send that
 * from a plain form or a simple cross-site request without a preflight, so with a cookie-based
 * `resolveActor` this is what keeps the API from being driven by another site.
 */
export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new ApiError(415, { error: "Send JSON with content-type: application/json", code: "invalid_input" });
  }
  const text = await request.text();
  if (!text.trim()) throw new ApiError(400, { error: "The body is empty; send JSON", code: "invalid_input" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, { error: "The body is not JSON", code: "invalid_input" });
  }
}
