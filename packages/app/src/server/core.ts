// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ApprovalState,
  type DriftReport,
  errorCode,
  errorMessage,
  type InputIssue,
  invalidInput,
  isEnded,
  type LedgerRecord,
  loadPolicies,
  type PreviewAnswer,
  Principal,
  type RunSummary,
  type SanomaError,
} from "@sanoma-ai/workflows";
import { AGENTS, apiNameOf, groupNamesOf } from "@sanoma-ai/workflows/shared";
import { type ConfigDescription, type DataValue, formatOptions, setFields } from "@sanoma-ai/workflows/describe";
import { check, loadScenarios } from "@sanoma-ai/workflows/scenario";
import { isNotFound, isRedirect, notFound } from "@tanstack/react-router";
import { z } from "zod";
import {
  ACTOR_HEADER,
  type AdoptRequest,
  type AdoptResponse,
  ApiError,
  type CallRequest,
  type ClearCredentialRequest,
  type CredentialsResponse,
  type DecideCall,
  type ErrorResponse,
  type PermissionsResponse,
  type PermissionsRow,
  type PreviewQuery,
  type RunDetail,
  RunsQuery,
  type ScenariosResponse,
  type SetCredentialRequest,
  type StartRunRequest,
  type StartRunResponse,
  startRunSchema,
} from "../api.ts";
import type { AppContext } from "../context.ts";
import { previewRequests } from "../lib/preview.ts";
import { LOOPBACK } from "../loopback.ts";

// What the server functions do. Server-only: each takes the app context that startApp passes
// with every request. Every expected failure is an ApiError.

/** A request's context once start.ts's `actor` middleware has run: the app, and who is asking. */
export interface ActorContext {
  app: AppContext;
  actor: () => Promise<Principal | undefined>;
}

/**
 * Says who is asking, when asked: start.ts's `actor` middleware gives each request this as
 * `context.actor`, and the login's resolver (the header's, by default) runs at most
 * once per request, so a read that needs no actor never calls it. A resolver that throws (its
 * session store is down, say) fails that call, inside the handler, so the error middleware
 * answers it as a logged 500.
 */
export function actorOf(app: AppContext, request: Request): ActorContext["actor"] {
  const resolve = app.login.resolveActor;
  let who: Promise<Principal | undefined> | undefined;
  return () =>
    (who ??= (async () => resolve(request))().catch((err: unknown) => {
      throw new Error(`Could not tell who you are: ${errorMessage(err)}`, { cause: err });
    }));
}

/**
 * Who is making a change (resolved at most once per request, see `actorOf`), or a 400 when
 * nobody is named. Only the loopback login reads the header, so only then does the answer
 * name it.
 */
export async function requireActor({ app, actor }: ActorContext): Promise<Principal> {
  const parsed = Principal.safeParse(await actor());
  if (parsed.success) return parsed.data;
  const error = saysWho(app)
    ? "This request does not say who is making it: sign in"
    : `Say who you are in the ${ACTOR_HEADER} header`;
  throw new ApiError(400, { error, code: "invalid_input" });
}

/** True when the login says who is asking; false for the loopback login, which takes the name the page sends. */
export const saysWho = (app: AppContext) => app.login.name !== LOOPBACK;

/** Where the page signs out, when the login has a route for it. */
export const signOutUrl = ({ login }: AppContext) => login.signOut;

/** The value, parsed by the schema, or a 400 `invalid_input` with zod's issues. */
export function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw asApiError(invalidInput(what, parsed.error.issues));
}

/** A server function's validator for a schema: the argument it parses, or a 400 `invalid_input` with zod's issues. */
export const validate =
  <T extends z.ZodType>(schema: T) =>
  (data: z.input<T>): z.output<T> =>
    parse(schema, data, "The request");

/**
 * `startRunFn`'s validator: a workflow and its input, or a scenario's name, each refused at its
 * own field (`startRunSchema`).
 */
export const readStartRun = (data: StartRunRequest): StartRunRequest =>
  parse(startRunSchema(data), data, "The request");

/**
 * The description as the page gets it (`getConfig`): without the source of a workflow
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
 * as the outline read it, with `\n` line endings) or a data file (a resource's, a collection's
 * or a problem's `file`, relative to the config's root). Never a path the request makes up. `null` when the
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
    (description.resources.some((r) => r.file === file) ||
      description.collections.some((c) => c.declared?.file === file) ||
      description.problems.some((p) => p.file === file));
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
    ledger = await client.ledger(runId);
  } catch (err) {
    // A store reads a run nothing has recorded as no records, so this is a real failure (a
    // corrupt file, a permission): logged for the operator once, and the page shows the run and
    // why its ledger is missing.
    const ledgerError = errorMessage(err);
    logReadOnce(runId, ledgerError, "the ledger", err);
    return { run, ledger: [], ledgerError, approvals };
  }
  // A run that has started records run.started first. Seeing none, the likeliest cause is an
  // app on another ledger than the worker's (another database, or a jsonl directory relative to
  // another cwd).
  if (ledger.length === 0 && run.status !== "queued") {
    return { run, ledger, ledgerError: NO_RECORDS, approvals };
  }
  const seeded = ledger.find((r) => r.type === "scenario.seeded");
  if (!seeded) return { run, ledger, approvals };
  // Checked against the feature file as it reads now, which the agent may have changed since:
  // Cucumber runs the scenario's Then steps against the ledger.
  try {
    const loaded = await loadScenarios(resolved);
    const scenario = loaded.scenarios.find((s) => s.name === seeded.scenario);
    if (scenario) {
      const ended = isEnded(run.status);
      const checks = (await check(resolved, scenario, ledger)).map((c, i) => {
        const e = scenario.expect[i]!;
        // Met once: a call made, or a decision recorded, stays made.
        return { ...c, settled: ended || (c.ok && (("called" in e && e.called === true) || "decision" in e)) };
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
export async function scenarios({ resolved }: Pick<AppContext, "resolved">): Promise<ScenariosResponse> {
  try {
    const loaded = await loadScenarios(resolved);
    return {
      scenarios: loaded.scenarios.map(({ name, workflow, file, text, steps, input }) => ({
        name,
        workflow,
        file,
        text,
        steps,
        input,
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
    const { scenarios: all, errors } = await loadScenarios(resolved);
    const scenario = all.find((s) => s.name === body.scenario);
    const workflow = scenario && resolved.workflows.get(scenario.workflow);
    if (!scenario || !workflow) {
      const known = all.length ? `; the scenarios are ${all.map((s) => `"${s.name}"`).join(", ")}` : "; there are none";
      throw noSuch("scenario", `No scenario named "${body.scenario}"${known}${notLoaded(errors)}`);
    }
    return {
      runId: await client.start(workflow, scenario.input, { startedBy: actor, sandbox: scenario.name }),
      workflow: scenario.workflow,
    };
  }
  const workflow = resolved.workflows.get(body.workflow);
  if (!workflow) throw noSuch("workflow", `No workflow named "${body.workflow}"`);
  return { runId: await client.start(workflow, body.input, { startedBy: actor }), workflow: body.workflow };
}

/** The latest runs, or the latest with a status, of a workflow (`getRuns`). */
export const listRuns = ({ client }: AppContext, query: z.output<typeof RunsQuery>) => client.runs(query);

/**
 * Each workflow's latest run, by name (`getLastRuns`): one read of each workflow's newest, all at
 * once. A workflow never run has none.
 */
export async function lastRuns({ client, description }: AppContext): Promise<Record<string, RunSummary>> {
  const latest = await Promise.all(description.workflows.map((wf) => client.runs({ workflow: wf.name, limit: 1 })));
  return Object.fromEntries(latest.flatMap(([run]) => (run ? [[run.workflow, run]] : [])));
}

/** The report of a drift run once it ends (`SanomaClient.driftReport`). */
export const driftReport = ({ client }: AppContext, runId: string): Promise<DriftReport> => client.driftReport(runId);

/** The adopt under way, if any: one at a time, so two never read the same file and both write it. */
let adopting: Promise<unknown> = Promise.resolve();

/**
 * Adopt: writes what the vendor holds into the data file, for fields a finished drift run found
 * drifted (`paths`, of the resource `id`), by that run's report, never a value the request gives.
 * Then commits the file through the app's source, when it has one, as the actor. The next drift
 * run reads the file as it is now. One adopt runs at a time. A 409 when the file no longer
 * declares the resource or the field's place, or the field is (or holds) a reference to another
 * resource; it does not check that the field still holds what the run read.
 */
export function adopt(app: AppContext, actor: Principal, request: AdoptRequest): Promise<AdoptResponse> {
  const done = adopting.then(() => adoptNow(app, actor, request));
  adopting = done.catch(() => undefined);
  return done;
}

async function adoptNow(
  { client, resolved, source }: AppContext,
  actor: Principal,
  { runId, id, paths }: AdoptRequest,
): Promise<AdoptResponse> {
  const result = (await client.driftReport(runId)).resources.find((r) => r.id === id);
  if (result?.status !== "drifted") {
    throw new ApiError(404, { error: `Run ${runId} found no drift on ${id}`, code: "invalid_input" });
  }
  const fields: Record<string, DataValue> = {};
  for (const path of paths) {
    const field = result.fields.find((f) => f.path === path);
    if (!field) throw new ApiError(400, { error: `${path} of ${id} has not drifted`, code: "invalid_input" });
    fields[path] = field.actual as DataValue;
  }
  if (resolved.root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  // The id is `<file>#<export>`, the file relative to the root: the drift run read it there.
  const at = id.lastIndexOf("#");
  const file = id.slice(0, at);
  const path = join(resolved.root, file);
  let text: string;
  try {
    text = await setFields(await readFile(path, "utf8"), id.slice(at + 1), fields, formatOptions(resolved.root));
  } catch (err) {
    throw new ApiError(409, { error: `Could not adopt into ${file}: ${errorMessage(err)}` });
  }
  await writeFile(path, text);
  if (!source) return { file };
  try {
    const commit = await source.commit({
      paths: [relative(source.root, path)],
      message: `Adopt ${paths.join(", ")} of ${result.name} from ${result.vendor}`,
      author: actor.id,
    });
    return { file, ...(commit && { revision: commit.revision }) };
  } catch (err) {
    // Said, not hidden behind a 500's "Something went wrong": the file is written, and uncommitted.
    throw new ApiError(500, { error: `Wrote ${file}, but could not commit it: ${errorMessage(err)}` });
  }
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

/** What the policy would answer `actor` for each request, its input unknown (`Policy.preview`). */
export function preview(
  { resolved: { policy } }: Pick<AppContext, "resolved">,
  actor: Principal,
  requests: PreviewQuery,
): PreviewAnswer[] {
  return policy.preview(requests.map((request) => ({ ...request, principal: actor })));
}

/**
 * Whom the `agents` column's agent acts for: a hold `@hold("on-behalf-of")` asks them. Only an
 * agent acts for someone, so in any other column that hold refuses, as it does a person.
 */
const ACTS_FOR = "whom it acts for";

/** Each app's grid, by its resolved config: built from the policy and the description, both read once as the app starts. */
const grids = new WeakMap<object, PermissionsResponse>();

/**
 * The Permissions page's grid (`getPermissions`): for someone in no group, then for each group,
 * the declared ones and `agents`, what the policy would answer someone in it alone
 * (`{ id: "group:<name>", groups: [name] }`, an agent acting for `ACTS_FOR`), the input unknown
 * (`preview`), for the start of each of the config's own workflows, by name, each with the
 * operations it uses, in the order it declares them, then each operation a person may call
 * directly, by id. Nobody's own answer: the actor asking is not used. Then the policy's files
 * as the app read them when it started (`sourcesOf`).
 */
export function permissions(app: Pick<AppContext, "resolved" | "description" | "policyFiles">): PermissionsResponse {
  let grid = grids.get(app.resolved);
  if (!grid) grids.set(app.resolved, (grid = gridOf(app)));
  return grid;
}

function gridOf(app: Pick<AppContext, "resolved" | "description" | "policyFiles">): PermissionsResponse {
  const { description } = app;
  const groups = [null, ...groupNamesOf(description.resources)];
  const opsById = new Map(description.ops.map((op) => [op.id, op]));
  const workflows = description.workflows.filter((w) => !w.builtin);
  const direct = description.ops.filter((op) => op.direct).toSorted((a, b) => a.id.localeCompare(b.id));
  // Every row's question, in the grid's order: each workflow's start, then the operations it may
  // call, as the run form asks them (`previewRequests`); then each direct operation.
  const asked = workflows.map((w) => previewRequests(w, opsById));
  const requests: PreviewQuery = [...asked.flat(), ...direct.map(({ id, effect }) => ({ action: { id, effect } }))];
  const columns = groups.map((group) =>
    preview(
      app,
      group === null
        ? { id: "group:", groups: [] }
        : { id: `group:${group}`, groups: [group], ...(group === AGENTS && { onBehalfOf: ACTS_FOR }) },
      requests,
    ),
  );
  const rows = requests.map(({ action: { id } }, i): PermissionsRow => ({
    id,
    cells: columns.map((answers) => answers[i]!),
  }));
  // Each workflow's rows, as many as it asked: its start, then one per operation it may call.
  let at = 0;
  return {
    policy: description.policy,
    groups,
    workflows: workflows.map(({ name, title }, i) => {
      const [start, ...called] = rows.slice(at, (at += asked[i]!.length));
      return { ...start!, id: name, ...(title !== undefined && { title }), ops: called };
    }),
    ops: rows.slice(at),
    files: sourcesOf(app.policyFiles ?? []),
  };
}

/**
 * The policy files, each with `\n` line endings, as the Code view counts offsets, and the span
 * of each of its policies (`loadPolicies`) in that text.
 */
function sourcesOf(read: { file: string; text: string }[]): PermissionsResponse["files"] {
  const files = read.map(({ file, text }) => ({ file, text: text.replaceAll("\r\n", "\n") }));
  const { policies } = loadPolicies(files);
  return files.map(({ file, text }) => {
    // Where each line starts: a policy's line and column, from 1, back to an offset.
    const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
    return {
      file,
      text,
      policies: policies
        .filter((p) => p.file === file)
        .map(({ id, line, column, text: policy }) => {
          const start = starts[line - 1]! + column - 1;
          return { id, span: [start, start + policy.length] as const };
        }),
    };
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

/** The longest a site's `api.<workflow>.result` waits for a run in one request, and how often it looks. */
export const RESULT_WAIT_MS = 20_000;
const RESULT_POLL_MS = 250;

const RunRef = z.object({ runId: z.string().min(1) });
const ResultRef = RunRef.extend({ waitMs: z.number().int().min(0).optional() });
const RunsLimit = RunsQuery.pick({ limit: true });

/**
 * A site's `api` call (`callFn`), as the person asking. An operation's id calls it directly
 * (`SanomaClient.call`, which refuses one that is not direct), with `{}` for no input. A
 * workflow's api name (`apiNameOf`) starts it, as does `<name>.start`, answering `{ runId }`;
 * `<name>.result` (`{ runId, waitMs? }`, at most 20 s), `.latest`, `.runs` (`{ limit? }`),
 * `.approvals` and `.ledger` (`{ runId }`) read its runs, a run of another workflow being none.
 * Anything else is `invalid_input`.
 */
export async function callApi(app: AppContext, actor: Principal, { name, input, id }: CallRequest): Promise<unknown> {
  const { client, description, resolved } = app;
  if (resolved.ops.has(name)) {
    return client.call(name, input ?? {}, { actor, ...(id === undefined ? {} : { id }) });
  }
  const [api, method = "start", ...rest] = name.split(".");
  // Two workflows of one api name (a problem describeConfig reports) are neither.
  const named = rest.length ? [] : description.workflows.filter((wf) => apiNameOf(wf.name) === api);
  const workflow = named.length === 1 ? named[0]!.name : undefined;
  if (!workflow) throw notCallable(name);
  const read = <T extends z.ZodType>(schema: T) => parse(schema, input ?? {}, "The input");
  switch (method) {
    case "start": {
      const options = { startedBy: actor, ...(id === undefined ? {} : { runId: id }) };
      return { runId: await client.start(workflow, input, options) };
    }
    case "result": {
      const { runId, waitMs = RESULT_WAIT_MS } = read(ResultRef);
      const until = Date.now() + Math.min(waitMs, RESULT_WAIT_MS);
      // Its status polled here rather than `client.result`'s wait, whose DBOS poller outlives
      // the timeout: a page asks again every 20 s while a run waits for days.
      while (!isEnded((await runOf(app, workflow, runId)).status)) {
        if (Date.now() >= until) {
          throw new ApiError(409, { error: `Run ${runId} is still running`, code: "run_running", runId });
        }
        await sleep(RESULT_POLL_MS);
      }
      return client.result(runId);
    }
    case "latest":
      return client.latest(workflow);
    case "runs":
      return listRuns(app, { ...read(RunsLimit), workflow });
    case "approvals":
      return (await runOf(app, workflow, read(RunRef).runId)).approvals;
    case "ledger": {
      const { runId } = read(RunRef);
      await runOf(app, workflow, runId);
      return client.ledger(runId);
    }
    default:
      throw notCallable(name);
  }
}

/** The 400 for a name `callApi` does not know. */
const notCallable = (name: string) =>
  new ApiError(400, {
    error:
      `api.${name} is neither an operation nor a workflow: call an operation by its id, a workflow by its ` +
      "camelCase name, or its .start, .result, .latest, .runs, .approvals or .ledger",
    code: "invalid_input",
  });

/** The run, when it is one of the workflow's; a 404 otherwise. */
async function runOf({ client }: AppContext, workflow: string, runId: string): Promise<RunSummary> {
  const run = await client.run(runId);
  if (run?.workflow !== workflow)
    throw new ApiError(404, { error: `No run ${runId} of ${workflow}`, code: "run_not_found" });
  return run;
}

const STATUS: Partial<Record<NonNullable<ErrorResponse["code"]>, number>> = {
  invalid_input: 400,
  not_approver: 403,
  not_admitted: 403,
  policy_denied: 403,
  run_not_found: 404,
  no_pending_approval: 404,
  already_decided: 409,
  run_ended: 409,
  run_running: 409,
  approval_pending: 409,
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
  if (code === "not_approver") {
    body.approver = data.approver as ErrorResponse["approver"];
    if (typeof data.reason === "string") body.reason = data.reason;
  }
  if ((code === "approval_pending" || code === "run_running") && typeof data.runId === "string")
    body.runId = data.runId;
  return new ApiError(status, body);
}

/** `asApiError`, logging what it turns into a 500: only those are unexpected. */
export function toApiError(err: unknown, where: string): ApiError {
  const api = asApiError(err);
  if (api.status >= 500) console.error(`sanoma app: ${where} failed:`, err);
  return api;
}

/** True for the router's not-found and redirects: answers, not failures, which go through as thrown. */
const isRouterAnswer = (err: unknown): boolean => isNotFound(err) || isRedirect(err);

/**
 * What a server function fails with when it throws `err` (start.ts's `apiErrors` throws it, with
 * an ApiError's status): the router's not-found and redirects as they are; a read (`GET`) that
 * finds nothing as the router's not-found, so the page shows its not-found view; anything else
 * as an ApiError, a 500 logged (`toApiError`).
 */
export function serverFnFailure(err: unknown, method: string): unknown {
  if (isRouterAnswer(err)) return err;
  const api = toApiError(err, "a server function");
  return api.status === 404 && method === "GET" ? notFound() : api;
}
