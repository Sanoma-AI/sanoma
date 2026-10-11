// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApprovalState,
  type DriftReport,
  errorCode,
  errorMessage,
  invalidInput,
  isEnded,
  type LedgerRecord,
  Principal,
  type SanomaError,
} from "@sanoma/workflows";
import type { ConfigDescription } from "@sanoma/workflows/describe";
import { check, loadScenarios } from "@sanoma/workflows/scenario";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import type { z } from "zod";
import {
  ACTOR_HEADER,
  ApiError,
  type ClearCredentialRequest,
  type CredentialsResponse,
  type DecideCall,
  type ErrorResponse,
  type InputIssue,
  type RunDetail,
  type ScenariosResponse,
  type SetCredentialRequest,
  type StartRunRequest,
  type StartRunResponse,
} from "../api.ts";
import type { AppContext } from "../context.ts";

// What the API routes and the server functions both do. Server-only: each takes the app
// context that startApp passes with every request. Every expected failure is an ApiError.

/** A request's context once start.ts's `actor` middleware has run: the app, and who is asking. */
export interface ActorContext {
  app: AppContext;
  actor: () => Promise<Principal | undefined>;
}

/**
 * Who is making a change (resolved at most once per request, see start.ts), or a 400 when
 * nobody is named. Only the default resolver reads the header, so only then does the answer
 * name it.
 */
export async function requireActor({ app, actor }: ActorContext): Promise<Principal> {
  const parsed = Principal.safeParse(await actor());
  if (parsed.success) return parsed.data;
  const error = app.resolveActor
    ? "This request does not say who is making it: sign in"
    : `Say who you are in the ${ACTOR_HEADER} header`;
  throw new ApiError(400, { error, code: "invalid_input" });
}

/** The value, parsed by the schema, or a 400 `invalid_input` with zod's issues. */
export function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw asApiError(invalidInput(what, parsed.error.issues));
}

/**
 * The description as the page and `GET /api/config` get it: without the source of a workflow
 * read from its file, which is a whole file: `fileSource` serves it, one file at a time. A
 * workflow read from `run`'s own text keeps it.
 */
export const withoutSources = (description: ConfigDescription): ConfigDescription => ({
  ...description,
  workflows: description.workflows.map((workflow) => {
    if (!("file" in workflow.outline)) return workflow;
    const { source: _, ...entry } = workflow;
    return entry;
  }),
});

/**
 * A file the description names, as it is now: a workflow's file (its outline's `file`, read
 * as the outline read it, with `\n` line endings) or a data file (a resource's or a problem's
 * `file`, relative to the config's root). Never a path the request makes up. `null` when the
 * description names no such file, or it can no longer be read: not a 404, which a page's
 * loader would take for its own page not being found.
 */
export async function fileSource(
  { resolved, description }: Pick<AppContext, "resolved" | "description">,
  file: string,
): Promise<{ source: string | null }> {
  const workflowFile = description.workflows.some((wf) => "file" in wf.outline && wf.outline.file === file);
  const dataFile =
    resolved.root !== undefined &&
    (description.resources.some((r) => r.file === file) || description.problems.some((p) => p.file === file));
  if (!workflowFile && !dataFile) return { source: null };
  try {
    const text = await readFile(workflowFile ? file : join(resolved.root!, file), "utf8");
    return { source: workflowFile ? text.replaceAll("\r\n", "\n") : text };
  } catch {
    return { source: null };
  }
}

const NO_RECORDS = "No records for a run that has started; is the app reading the same ledger as the worker?";

/** Failures to read a run's ledger or scenario already logged, by run and message: a page polls its run every 2 s. */
const loggedReads = new Set<string>();

/** Logs a failure to read what a run's page shows, once per run and message. */
function logReadOnce(runId: string, message: string, what: string, err: unknown) {
  const key = `${runId}\n${message}`;
  if (loggedReads.has(key)) return;
  loggedReads.add(key);
  console.error(`sanoma app: could not read ${what} of run ${runId}:`, err);
}

/** The feature files that did not load, as `seedSandbox` names them: appended to a scenario not found. */
const notLoaded = (errors: readonly { message: string }[]) =>
  errors.length ? `; these files did not load: ${errors.map((e) => e.message).join("; ")}` : "";

/** The run with its ledger and approvals, and a sandbox run's checks, or a 404. */
export async function runDetail({ client, resolved }: AppContext, runId: string): Promise<RunDetail> {
  const run = await client.run(runId);
  if (!run) throw new ApiError(404, { error: `No run ${runId}`, code: "run_not_found" });
  const { approvals } = run;
  let ledger: LedgerRecord[];
  try {
    ledger = await resolved.ledger.read(runId);
  } catch (err) {
    // A store reads a run nothing has recorded as no records, so this is a real failure (a
    // corrupt file, a permission): logged for the operator once, and the page shows the run and
    // why its ledger is missing.
    const ledgerError = errorMessage(err);
    logReadOnce(runId, ledgerError, "the ledger", err);
    return { run, ledger: [], ledgerError, approvals };
  }
  // A run that has started records run.started first. Seeing none, the likeliest cause is an
  // app reading another ledger than the worker's (a jsonl directory relative to another cwd).
  if (ledger.length === 0 && run.status !== "queued") {
    return { run, ledger, ledgerError: NO_RECORDS, approvals };
  }
  const seeded = ledger.find((r) => r.type === "scenario.seeded");
  if (!seeded) return { run, ledger, approvals };
  // Checked against the feature file as it reads now, which the agent may have changed since.
  try {
    const loaded = loadScenarios(resolved);
    const scenario = loaded.scenarios.find((s) => s.name === seeded.scenario);
    if (scenario) {
      const ended = isEnded(run.status);
      const checks = check(scenario, ledger).map((c, i) => {
        const e = scenario.expect[i]!;
        return { ...c, settled: ended || (c.ok && "op" in e && e.called) };
      });
      return { run, ledger, approvals, checks };
    }
    const checksError = `The feature files no longer have scenario "${seeded.scenario}"${notLoaded(loaded.errors)}`;
    return { run, ledger, approvals, checksError };
  } catch (err) {
    // The scenarios could not be read at all (an operation's phrase names a field it lacks).
    const checksError = errorMessage(err);
    logReadOnce(runId, checksError, "the scenario", err);
    return { run, ledger, approvals, checksError };
  }
}

/**
 * Every scenario in the config's feature files, as the page lists them, as they read now. When
 * they cannot be read at all, none, with why as the one error, so the page says so and stays up.
 */
export function scenarios({ resolved }: Pick<AppContext, "resolved">): ScenariosResponse {
  try {
    const loaded = loadScenarios(resolved);
    return {
      scenarios: loaded.scenarios.map(({ name, workflow, file, text, steps }) => ({
        name,
        workflow,
        file,
        text,
        steps,
      })),
      errors: loaded.errors,
    };
  } catch (err) {
    return { scenarios: [], errors: [{ file: "", message: errorMessage(err) }] };
  }
}

/** A 404 `invalid_input` for a name the request gives that the config does not have, with an issue at its field. */
const noSuch = (field: "workflow" | "scenario", error: string) =>
  new ApiError(404, {
    error,
    code: "invalid_input",
    issues: [{ path: [field], message: error, code: "invalid_value" }],
  });

/**
 * Starts the workflow with the input, or a sandbox run of the scenario: its workflow with its
 * input, seeded by the worker. Its approvals wait for people, as a live run's do.
 */
export async function startRun(
  { client, resolved }: AppContext,
  actor: Principal,
  body: StartRunRequest,
): Promise<StartRunResponse> {
  if ("scenario" in body) {
    const { scenarios: all, errors } = loadScenarios(resolved);
    const scenario = all.find((s) => s.name === body.scenario);
    const workflow = scenario && resolved.workflows.get(scenario.workflow);
    if (!scenario || !workflow) {
      const known = all.length ? `; the scenarios are ${all.map((s) => `"${s.name}"`).join(", ")}` : "; there are none";
      throw noSuch("scenario", `No scenario named "${body.scenario}"${known}${notLoaded(errors)}`);
    }
    return {
      runId: await client.start(workflow, scenario.input, { startedBy: actor, sandbox: scenario.name }),
    };
  }
  const workflow = resolved.workflows.get(body.workflow);
  if (!workflow) throw noSuch("workflow", `No workflow named "${body.workflow}"`);
  return { runId: await client.start(workflow, body.input, { startedBy: actor }) };
}

/** The report of a drift run once it ends (`SanomaClient.driftReport`). */
export const driftReport = ({ client }: AppContext, runId: string): Promise<DriftReport> => client.driftReport(runId);

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

/** Each vendor's credential statuses now, from the app's environment and the stored credentials. */
export const credentials = async ({ client }: AppContext): Promise<CredentialsResponse> =>
  Object.fromEntries(await client.credentials());

/** Stores the variable's value as the actor; refused, with the reason and never the value, as `SanomaClient.setCredential` refuses it. */
export const setCredential = ({ client }: AppContext, actor: Principal, { name, value }: SetCredentialRequest) =>
  client.setCredential(name, value, { by: actor.id });

/** Deletes the variable's stored value, as the actor. */
export const clearCredential = ({ client }: AppContext, actor: Principal, { name }: ClearCredentialRequest) =>
  client.clearCredential(name, { by: actor.id });

const STATUS: Partial<Record<NonNullable<ErrorResponse["code"]>, number>> = {
  invalid_input: 400,
  not_approver: 403,
  run_not_found: 404,
  no_pending_approval: 404,
  already_decided: 409,
  run_ended: 409,
};

/**
 * An ApiError for any error: the runtime's codes get their status, and anything else is a 500.
 * A 500 answers only that something went wrong: its message may name internal details (a
 * database host, say), so the detail goes to the log (`toApiError`), not the caller.
 */
export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const code = errorCode(err);
  const status = (code && STATUS[code]) || 500;
  if (status === 500) return new ApiError(500, { error: "Something went wrong", ...(code ? { code } : {}) });
  const body: ErrorResponse = { error: errorMessage(err), code };
  // Read by property, not instanceof: DBOS hands a run's errors back as copies.
  const data: Record<string, unknown> = (err as Partial<SanomaError>).data ?? {};
  if (Array.isArray(data.issues)) body.issues = data.issues as InputIssue[];
  if (code === "not_approver") body.approver = data.approver as ErrorResponse["approver"];
  return new ApiError(status, body);
}

/** `asApiError`, logging what it turns into a 500: only those are unexpected. */
export function toApiError(err: unknown, where: string): ApiError {
  const api = asApiError(err);
  if (api.status >= 500) console.error(`sanoma app: ${where} failed:`, err);
  return api;
}

/** True for the router's not-found and redirects: answers, not failures, which go through as thrown. */
export const isRouterAnswer = (err: unknown): boolean => isNotFound(err) || isRedirect(err);

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
