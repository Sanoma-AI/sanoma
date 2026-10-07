import { type ApprovalState, errorCode, type Principal, type RunSummary } from "@sanoma/workflows";
import type { z } from "zod";
import {
  ACTOR_HEADER,
  ApiError,
  type DecideCall,
  type ErrorResponse,
  type InputIssue,
  type RunDetail,
  RunsQuery,
  type StartRunRequest,
  type StartRunResponse,
} from "../api.ts";
import type { AppContext } from "../context.ts";
import { getApp } from "./app.ts";

// What the API routes and the server functions both do. Server-only: it reads the app context
// that startApp passes with each request. Every expected failure is an ApiError.

/** Who is making a change, or a 400 when nobody is named. */
export async function requireActor(app: AppContext, request: Request): Promise<Principal> {
  const actor = await app.resolveActor(request);
  if (!actor || typeof actor.id !== "string" || !actor.id.trim()) {
    throw new ApiError(400, {
      error: `Say who you are in the ${ACTOR_HEADER} header`,
      code: "invalid_input",
    });
  }
  return actor;
}

export function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(400, {
    error: `${what}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    code: "invalid_input",
    issues: issuesOf(parsed.error.issues),
  });
}

const issuesOf = (issues: readonly z.core.$ZodIssue[]): InputIssue[] =>
  issues.map(({ path, message, code }) => ({
    path: path.filter((p): p is string | number => typeof p !== "symbol"),
    message,
    code,
  }));

export async function listRuns(limit: number): Promise<RunSummary[]> {
  return getApp().client.runs(limit);
}

export function runsLimit(url: URL): number {
  return parse(RunsQuery, { limit: url.searchParams.get("limit") ?? undefined }, "limit must be 1 to 500").limit;
}

/** The run with its ledger and approvals, or a 404. */
export async function runDetail(runId: string): Promise<RunDetail> {
  const { client, resolved } = getApp();
  const run = await client.run(runId);
  if (!run) throw new ApiError(404, { error: `No run ${runId}`, code: "run_not_found" });
  const [ledger, approvals] = await Promise.all([
    readLedger(runId, resolved.ledger !== undefined),
    client.approvals(runId),
  ]);
  return { run, ...ledger, approvals };
}

async function readLedger(runId: string, hasStore: boolean): Promise<Pick<RunDetail, "ledger" | "ledgerError">> {
  if (!hasStore) return { ledger: null };
  try {
    return { ledger: await getApp().client.ledger(runId) };
  } catch (err) {
    // A JSONL ledger whose directory no run has written to yet throws; the run still shows.
    console.error(`sanoma app: could not read the ledger of run ${runId}:`, err);
    return { ledger: [], ledgerError: messageOf(err) };
  }
}

export async function startRun(actor: Principal, body: StartRunRequest): Promise<StartRunResponse> {
  const { client, resolved } = getApp();
  const workflow = resolved.workflows.find((wf) => wf.name === body.workflow);
  if (!workflow) throw new ApiError(404, { error: `No workflow named "${body.workflow}"` });
  try {
    return { runId: await client.start(workflow, body.input, { startedBy: actor }) };
  } catch (err) {
    throw asApiError(err);
  }
}

/** Sends the decision, then answers with the approval once the run has read it (or as it stands after 5 s). */
export async function decide(actor: Principal, call: DecideCall): Promise<ApprovalState> {
  const { client } = getApp();
  const note = call.note?.trim() || undefined;
  try {
    return await client.decide(
      call.runId,
      note === undefined ? { decision: call.decision, by: actor } : { decision: call.decision, by: actor, note },
      call.approvalId,
      { timeoutSeconds: 5 },
    );
  } catch (err) {
    throw asApiError(err);
  }
}

const STATUS: Partial<Record<NonNullable<ErrorResponse["code"]>, number>> = {
  invalid_input: 400,
  not_approver: 403,
  run_not_found: 404,
  no_pending_approval: 404,
  already_decided: 409,
};

/** An ApiError for any error: the runtime's codes get their status, anything else is a 500. */
export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const code = errorCode(err);
  const status = code && STATUS[code];
  if (!code || !status) return new ApiError(500, { error: messageOf(err), ...(code ? { code } : {}) });
  const data = (err as { data?: Record<string, unknown> }).data ?? {};
  const body: ErrorResponse = { error: messageOf(err), code };
  if (Array.isArray(data.issues)) body.issues = data.issues as InputIssue[];
  if (code === "not_approver" && data.approver !== undefined)
    body.approver = data.approver as ErrorResponse["approver"];
  return new ApiError(status, body);
}

/** A JSON response for any error. 500s are logged, since only they are unexpected. */
export function errorResponse(err: unknown, where: string): Response {
  const api = asApiError(err);
  if (api.status >= 500) console.error(`sanoma app: ${where} failed:`, err);
  return json(api.body, api.status);
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** Runs an API handler, turning any error into its JSON response. */
export async function respond(where: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    return errorResponse(err, where);
  }
}

/** The request's JSON body, or a 400. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) throw new ApiError(400, { error: "The body is empty; send JSON", code: "invalid_input" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, { error: "The body is not JSON", code: "invalid_input" });
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
