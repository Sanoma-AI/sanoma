// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AppBehind,
  type ApprovalState,
  type DriftReport,
  deploymentKey,
  errorMessage,
  invalidInput,
  isEnded,
  type LedgerRecord,
  loadPolicies,
  nextFire,
  PolicyDeniedError,
  type PreviewAnswer,
  Principal,
  remoteFor,
  type RunSummary,
  type SanomaClient,
  SanomaError,
} from "sanoma/workflows";
import {
  AGENT_BUILT_IN_REFUSAL,
  AGENT_BUILT_INS,
  apiNameOf,
  APPLY_WORKFLOW,
  CALL_WORKFLOW,
  DESCRIBE_CALL,
  isDeclaredAgent,
  isVisitor,
  flatten,
  LOGIN_CODE_WORKFLOW,
  notLoaded,
  type Saved,
  undoDraftOf,
} from "sanoma/workflows/shared";
import { agentActing, type ConfigDescription, permissionsGrid } from "sanoma/workflows/describe";
import { isNotFound, isRedirect, notFound } from "@tanstack/react-router";
import { z } from "zod";
import {
  ACTOR_HEADER,
  AGENT_HEADER,
  ApiError,
  asApiError,
  type AppConfig,
  CallRequest,
  type ChangeDetail,
  type SaveDetail,
  type SaveDraftRequest,
  ChangesQuery,
  type ClearCredentialRequest,
  type CredentialsResponse,
  type ConnectionsResponse,
  type PreviewConnectionRequest,
  type ConnectConnectionRequest,
  type TestConnectionRequest,
  type DisconnectConnectionRequest,
  type DecideCall,
  type EnforcementResponse,
  type FieldChange,
  type HistoryEntry,
  type RecordHistory,
  runFailure,
  type HistoryRequest,
  type PermissionsResponse,
  type PreviewQuery,
  type ApplyAhead,
  type RunDetail,
  RunsQuery,
  SEALED_SHOWN,
  type SetCredentialRequest,
  type StartRunRequest,
  type StartRunResponse,
  startRunSchema,
} from "../api.ts";
import type { AppContext } from "../context.ts";
import { bearerOf } from "../login/public.ts";
import { databaseHost, headerValue, LOOPBACK } from "../loopback.ts";
import type { AppSnapshot } from "../snapshot.ts";
import { secretValues } from "./secrets.ts";

// What the server functions do. Server-only: each takes the app context the app hands every
// request, and reads the company from its snapshot, never a file. Every expected failure is an
// ApiError. What writes the repository or runs a child process is a run the worker executes
// (`steps/`): a server function starts it.

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

/**
 * Who a call is made as: `actor`, the person the login admitted, or, when the request names a
 * declared agent in the `x-sanoma-agent` header (`AGENT_HEADER`, URI-encoded or not, as
 * `x-sanoma-actor` is), that agent acting on their
 * behalf (`agentActing`, over the snapshot's people: an id that is not a declared agent, or one
 * that acts for someone else alone, is `not_admitted`). Only the loopback login takes the header;
 * on a host it is a 400, since the sign-in says who acts there.
 */
export function actingFor(app: AppContext, request: Request, actor: Principal): Principal {
  const named = headerValue(request, AGENT_HEADER);
  if (named === undefined) return actor;
  if (saysWho(app)) {
    throw new ApiError(400, {
      error: `The ${AGENT_HEADER} header is taken on this machine alone: on a host, the sign-in says who is asking`,
      code: "invalid_input",
    });
  }
  const agent = named.trim();
  if (!agent) {
    throw new ApiError(400, { error: `The ${AGENT_HEADER} header names no agent`, code: "invalid_input" });
  }
  return agentActing(agent, actor.id, app.snapshot.people);
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
 * What `getConfig` answers (`AppConfig`): the snapshot's description (`withoutSources`), where
 * this instance is, and the content kinds.
 */
export const appConfig = ({ snapshot, place, resolved }: AppContext): AppConfig => ({
  ...snapshot.description,
  place,
  databaseHost: databaseHost(resolved.databaseUrl),
  content: snapshot.content,
});

/**
 * The company as an agent reads it (`agentDescription`): what it may start, call and look up, as
 * JSON Schema, and nothing an agent has no use for or should not see.
 */
export interface AgentDescription {
  /** The company's name as people read it. */
  name: string;
  /** The company's own workflows (none of the runtime's): started by `name`, or `apiName` through `callApi`. */
  workflows: {
    name: string;
    apiName: string;
    title?: string;
    trigger: ConfigDescription["workflows"][number]["trigger"];
    input: Record<string, unknown>;
  }[];
  /** The operations that may be called directly (`OpEntry.direct`), outside a run: a lookup is one whose effect is read. */
  ops: {
    id: string;
    effect: string;
    description?: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }[];
  /** The collections, with their operations' ids. */
  collections: {
    name: string;
    title?: string;
    key: string;
    fields: ConfigDescription["collections"][number]["fields"];
    ops: string[];
  }[];
}

/**
 * The snapshot's description narrowed for an agent (`DESCRIBE_CALL`): each of the company's own
 * workflows' name, api name, title, trigger and input; each direct operation's contract; each
 * collection's fields. One projection for `/mcp` and a site or script alike. Left out on purpose:
 * the runtime's own workflows (`builtin`: an agent starts none; drift is `/mcp`'s own tool), the
 * policy and its text, files and source, the resources' desired values, secret bindings,
 * connections, sites and the database's host.
 */
export const agentDescription = (description: ConfigDescription): AgentDescription => ({
  name: description.name,
  workflows: description.workflows
    .filter((wf) => !wf.builtin)
    .map((wf) => ({
      name: wf.name,
      apiName: apiNameOf(wf.name),
      ...(wf.title !== undefined && { title: wf.title }),
      trigger: wf.trigger,
      input: wf.input,
    })),
  ops: description.ops
    .filter((op) => op.direct)
    .map((op) => ({
      id: op.id,
      effect: op.effect,
      ...(op.description !== undefined && { description: op.description }),
      input: op.input,
      output: op.output,
    })),
  collections: description.collections.map((c) => ({
    name: c.name,
    ...(c.title !== undefined && { title: c.title }),
    key: c.key,
    fields: c.fields,
    ops: c.ops,
  })),
});

/**
 * When each workflow on a schedule fires next, ISO 8601 by name (`nextFire`, as the worker's
 * scheduler finds it): computed here, never in the browser from the cron. `resolveConfig` has
 * refused a schedule that never fires, or one DBOS cannot read.
 */
export function nextFires(description: Pick<ConfigDescription, "workflows">, now = new Date()): Record<string, string> {
  const fires: Record<string, string> = {};
  for (const { name, trigger } of description.workflows) {
    if (trigger !== "manual") fires[name] = nextFire(trigger.schedule, trigger.timezone, now).toISOString();
  }
  return fires;
}

/**
 * A file the description names, as the snapshot read it: a workflow's file (its outline's `file`,
 * with `\n` line endings) or a company file (a resource's, a collection's, a site's or an app's,
 * or a problem's `file`, relative to the config's root). Never a path the request makes up. `null`
 * when the description names no such file, or it could not be read: not a 404, which a page's
 * loader would take for its own page not being found.
 */
export const fileSource = ({ sources }: Pick<AppSnapshot, "sources">, file: string): { source: string | null } => ({
  source: Object.hasOwn(sources, file) ? sources[file]! : null,
});

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

/** A `login-code` run's start with its sealed code cut to what the page shows (`SEALED_SHOWN`), which is all a reader is sent. */
function sealedShown(record: LedgerRecord): LedgerRecord {
  if (record.type !== "run.started" || typeof record.input !== "object" || record.input === null) return record;
  const { code } = record.input as { code?: unknown };
  return typeof code === "string"
    ? { ...record, input: { ...record.input, code: code.slice(0, SEALED_SHOWN) } }
    : record;
}

/**
 * The apply that `run`, a queued apply, waits for (`SanomaClient.applyAhead`), as the page names
 * it; undefined for any other run, and once it is the one running.
 */
export async function applyAheadOf(client: SanomaClient, run: RunSummary): Promise<ApplyAhead | undefined> {
  if (run.workflow !== APPLY_WORKFLOW || run.status !== "queued") return undefined;
  const ahead = await client.applyAhead(run.runId);
  return ahead && { runId: ahead.runId, status: ahead.status, startedBy: ahead.startedBy, createdAt: ahead.createdAt };
}

/** The run with its ledger and approvals, a sandbox run's checks as the worker last ran them, and the apply a queued one waits for; or a 404. */
export async function runDetail(app: AppContext, runId: string): Promise<RunDetail> {
  const { client, snapshot } = app;
  const run = await client.run(runId);
  if (!run) throw new ApiError(404, { error: `No run ${runId}`, code: "run_not_found" });
  const [read, told, ahead] = await Promise.all([
    client.ledger(runId).then(
      (records) => ({ records }),
      (err: unknown) => ({ err }),
    ),
    // Beside the ledger: the worker writes them for a seeded run only, each time it waits and when it ends.
    client.runChecks(runId).catch((err: unknown) => {
      const error = errorMessage(err);
      logReadOnce(runId, error, "the checks", err);
      return { error };
    }),
    applyAheadOf(client, run),
  ]);
  // What every answer has: the run, its approvals, and the apply a queued one waits for.
  const base = { run, approvals: run.approvals, ...(ahead && { ahead }) };
  if ("err" in read) {
    // A store reads a run nothing has recorded as no records, so this is a real failure (a
    // corrupt file, a permission): logged for the operator once, and the page shows the run and
    // why its ledger is missing.
    const ledgerError = errorMessage(read.err);
    logReadOnce(runId, ledgerError, "the ledger", read.err);
    return { ...base, ledger: [], ledgerError };
  }
  const ledger = run.workflow === LOGIN_CODE_WORKFLOW ? read.records.map(sealedShown) : read.records;
  // A run that has started records run.started first. Seeing none, the likeliest cause is an
  // app on another ledger than the worker's (another database, or a jsonl directory relative to
  // another cwd).
  if (ledger.length === 0 && run.status !== "queued") {
    return { ...base, ledger, ledgerError: NO_RECORDS };
  }
  const seeded = ledger.find((r) => r.type === "scenario.seeded");
  if (!seeded) return { ...base, ledger };
  if (!told) {
    // Not checked yet (the worker checks a seeded run when it first waits): its scenario's Then
    // steps, each not answered yet.
    const scenario = snapshot.scenarios.scenarios.find((s) => s.name === seeded.scenario);
    const pending = scenario?.steps.filter((step) => step.kind === "then");
    return {
      ...base,
      ledger,
      ...(pending && { checks: pending.map(({ text }) => ({ step: text, ok: false, settled: false })) }),
    };
  }
  if ("error" in told) return { ...base, ledger, checksError: told.error };
  // Every answer is final once the run has ended.
  const ended = isEnded(run.status);
  return { ...base, ledger, checks: told.checks.map((c) => ({ ...c, settled: ended || c.settled })) };
}

/**
 * How many commits the taken app `folder` is behind its source, or why that cannot be told, as
 * the worker last checked (at its start and after the checkout follows `main`). Only an app the
 * description lists, taken from a source.
 */
export async function appBehind(
  { client, snapshot }: Pick<AppContext, "client" | "snapshot">,
  folder: string,
): Promise<AppBehind> {
  if (!snapshot.description.apps.some((app) => app.name === folder && app.source !== undefined)) {
    return { error: `No app apps/${folder}/ taken from a source` };
  }
  return (
    (await client.appBehind(folder)) ?? {
      error: "Not told yet: the worker checks each app's source when it starts and after each push to main",
    }
  );
}

/**
 * Refuses the request with `invalid_input`, its issue at `field`, as a form shows it beside the
 * field: a 400 from a server function (`asApiError`), and from a run's `.result` (an app step's).
 */
export function invalid(field: string, error: string): never {
  throw new SanomaError("invalid_input", error, { issues: [{ path: [field], message: error, code: "custom" }] });
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
  { client, resolved, snapshot }: AppContext,
  actor: Principal,
  body: StartRunRequest,
): Promise<StartRunResponse> {
  if ("scenario" in body) {
    const { scenarios: all, errors } = snapshot.scenarios;
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
export async function lastRuns({ client, snapshot }: AppContext): Promise<Record<string, RunSummary>> {
  const { workflows } = snapshot.description;
  const latest = await Promise.all(workflows.map((wf) => client.runs({ workflow: wf.name, limit: 1 })));
  return Object.fromEntries(latest.flatMap(([run]) => (run ? [[run.workflow, run]] : [])));
}

/** The changes, newest first, open or done or all (`SanomaClient.changes`). */
export const changes = ({ client }: AppContext, query: z.output<typeof ChangesQuery>) => client.changes(query);

/**
 * The change of the draft `id` (`SanomaClient.change`), with the config's workflows whose files
 * it edits (`edits`), or null when the draft has none.
 */
export async function change({ client, snapshot }: AppContext, id: string): Promise<ChangeDetail | null> {
  const view = await client.change(id);
  if (!view) return null;
  // As the planner finds them: a workflow's file relative to the repository's root, in `touches`.
  return { ...view, edits: workflowsIn(snapshot, view.state.facts?.touches ?? []) };
}

/** The config's workflows, by name, whose files (relative to the repository's root) are among `files`. */
const workflowsIn = (snapshot: AppContext["snapshot"], files: readonly string[]) =>
  Object.entries(snapshot.repository?.workflows ?? {}).flatMap(([name, file]) => (files.includes(file) ? [name] : []));

/** The connector whose remote half is for the repository's remote (`remoteFor`); none without a remote, or without such a connector. */
export const remoteOf = ({ resolved, snapshot }: Pick<AppContext, "resolved" | "snapshot">) => {
  const url = snapshot.repository?.remote;
  return url === undefined ? undefined : remoteFor(resolved.remotes, url);
};

/** A change's page in this app at `origin`, which its pull request's status links. */
export const changePage = (id: string, origin: string) => new URL(`/changes/${encodeURIComponent(id)}`, origin).href;

/**
 * Sends the draft of `actor`'s chat `id` for review: opens its change (`SanomaClient.openChange`,
 * the open one when it has one), titled as the chat is, its page this app's `/changes/<id>` at
 * `origin`, where the pull request's status links. The change's run id; a 404 for a chat that is
 * not the actor's.
 */
export async function openChange(
  { client }: Pick<AppContext, "client">,
  actor: Principal,
  id: string,
  origin: string,
): Promise<{ runId: string }> {
  const chat = await client.chats.get(id);
  if (chat?.person !== actor.id) throw new ApiError(404, { error: `No chat ${id}` });
  return {
    runId: await client.openChange({ id, title: chat.title, page: changePage(id, origin) }, { startedBy: actor }),
  };
}

/**
 * The saves of the draft `id` (`SanomaClient.saves`), newest first, each with the config's
 * workflows whose files it saved (`edits`), as the files say now.
 */
export async function saves({ client, snapshot }: AppContext, id: string): Promise<SaveDetail[]> {
  return (await client.saves(id)).map((save) => ({
    ...save,
    edits: workflowsIn(snapshot, save.output && "files" in save.output ? save.output.files : []),
  }));
}

/**
 * Saves the draft of `actor`'s chat `id` (`SanomaClient.saveDraft`) at `head`, the commit its card
 * showed, titled as the chat, its change's page this app's `/changes/<id>` at `origin`. With
 * `undo`, a commit the chat's draft was saved as (`SanomaClient.savedAs`: by a save, or its
 * change's merge), that commit is undone instead, from a draft of its own (`undoDraftOf`), titled
 * "Undo" and the chat's title. The save's run id; a 404 for a chat that is not the actor's, a 409
 * for a commit the chat did not save.
 */
export async function saveDraft(
  { client }: Pick<AppContext, "client">,
  actor: Principal,
  { id, head, undo }: SaveDraftRequest,
  origin: string,
): Promise<{ runId: string }> {
  const chat = await client.chats.get(id);
  if (chat?.person !== actor.id) throw new ApiError(404, { error: `No chat ${id}` });
  if (undo !== undefined && !(await client.savedAs(id, undo))) {
    throw new ApiError(409, { error: `${undo.slice(0, 7)} is not a commit this chat saved` });
  }
  const draft = undo === undefined ? id : undoDraftOf(undo);
  const input =
    undo === undefined
      ? { id, title: chat.title, ...(head !== undefined && { head }) }
      : { id: draft, title: `Undo ${chat.title}`, undo, chat: id };
  return { runId: await client.saveDraft({ ...input, page: changePage(draft, origin) }, { startedBy: actor }) };
}

/**
 * What the repository's host enforces on `main` (`SourceHost.enforcement`), with the host's name:
 * the Permissions page's line. Null without a remote, or when no connector's remote half is for
 * its host. A host that cannot be asked
 * is logged, and answered as enforcing nothing, saying so (its error stays in the log).
 */
export async function hostEnforcement(
  app: Pick<AppContext, "client" | "snapshot" | "resolved">,
): Promise<EnforcementResponse> {
  const found = remoteOf(app);
  if (!found) return null;
  const { client, snapshot } = app;
  const host = snapshot.description.vendors[found.vendor]!.title;
  try {
    return { host, ...(await found.remote.open(found.repo, { secrets: secretValues(client) }).enforcement("main")) };
  } catch (err) {
    console.error(`sanoma app: asking ${host} what it enforces on main failed:`, err);
    return { host, pullRequest: false, check: false, reason: `${host} could not be asked; the app's log says why.` };
  }
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

/** What the policy would answer `actor` for each request, its input unknown (`Policy.preview`). */
export function preview(
  { resolved: { policy } }: Pick<AppContext, "resolved">,
  actor: Principal,
  requests: PreviewQuery,
): PreviewAnswer[] {
  return policy.preview(requests.map((request) => ({ ...request, principal: actor })));
}

/** Each grid, by the description it was built from: again once the files change (the people, their groups). */
const grids = new WeakMap<object, PermissionsResponse>();

/** The policy's files by the resolved config, as the first grid read them: the text of the policy it enforces, read once as the app starts. */
const policyFiles = new WeakMap<object, PermissionsResponse["files"]>();

/**
 * The Permissions page's grid (`getPermissions`): the policy, its grid (`permissionsGrid`, the
 * one `sanoma check` reports too: nobody's own answer, the actor asking is not used) over the
 * people as the files declare them now, then the policy's files as the policy was read (`sourcesOf`):
 * a `.cedar` file edited since shows once the app restarts, as its rules apply.
 */
export function permissions({ resolved, snapshot }: Pick<AppContext, "resolved" | "snapshot">): PermissionsResponse {
  const { description } = snapshot;
  let grid = grids.get(description);
  if (!grid) {
    const { files: read, ...policy } = description.policy;
    let files = policyFiles.get(resolved);
    if (!files) policyFiles.set(resolved, (files = sourcesOf(read)));
    grid = { policy, ...permissionsGrid(resolved, description), files };
    grids.set(description, grid);
  }
  return grid;
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

/** No credential reads. Account visibility and creation choices are checked by the runtime. */
export async function connections(
  { client, resolved, snapshot: { description } }: AppContext,
  actor: Principal,
): Promise<ConnectionsResponse> {
  const cards = (await client.connections({ actor })).map((card) => {
    const isDefault = resolved.connections.catalog.definitions.get(card.id)?.default === true;
    const workflows = description.workflows
      .filter((workflow) => !workflow.builtin)
      .flatMap((workflow) => {
        if (!("nodes" in workflow.outline)) {
          return workflow.ops.some((id) => id.startsWith(`${card.vendor}.`))
            ? [{ name: workflow.name, title: workflow.title ?? workflow.name, selection: "possible" as const }]
            : [];
        }
        const calls = flatten(workflow.outline.nodes).filter(
          (node) => node.kind === "op" && (node.ops ?? [node.id]).some((id) => id.split(".")[0] === card.vendor),
        );
        const selections = calls.flatMap((call) => {
          if (call.kind !== "op") return [];
          if (!call.connection) return isDefault ? ["default" as const] : [];
          if ("dynamic" in call.connection) return ["possible" as const];
          return call.connection.id === card.id ? ["selected" as const] : [];
        });
        const selection = selections.includes("selected")
          ? "selected"
          : selections.includes("default")
            ? "default"
            : selections[0];
        return selection ? [{ name: workflow.name, title: workflow.title ?? workflow.name, selection }] : [];
      });
    return { ...card, workflows };
  });
  const rules = (await client.connectionRules({ actor })).map(({ id, rule }) => ({
    id,
    name: rule.name,
    vendor: rule.vendor,
    method: rule.method,
    scopes: rule.scopes,
  }));
  const methods: ConnectionsResponse["methods"] = {};
  for (const [vendor, definitions] of resolved.connections.catalog.methods) {
    methods[vendor] = Object.fromEntries(
      Object.entries(definitions).map(([name, method]) => {
        let schema: Record<string, unknown> | undefined;
        if (method.schema) {
          // Input fields describe the contract. Do not seed sensitive inputs with schema defaults.
          schema = JSON.parse(
            JSON.stringify(
              z.toJSONSchema(method.schema, { io: "input", unrepresentable: "any" }),
              (key, value: unknown) => (["default", "examples"].includes(key) ? undefined : value),
            ),
          ) as Record<string, unknown>;
        }
        return [
          name,
          {
            kind: method.kind,
            verifiable: !!method.verify,
            ...(schema && { schema }),
            ...(method.kind === "oauth2" && { revocable: !!method.revoke }),
          },
        ];
      }),
    );
  }
  const names: ("SANOMA_SIGNING_KEY" | "SANOMA_SECRETS_KEY")[] = ["SANOMA_SIGNING_KEY"];
  if (!resolved.secrets.store) names.push("SANOMA_SECRETS_KEY");
  const bootstrap: ConnectionsResponse["bootstrap"] = names.map((name) => {
    let ready = false;
    try {
      deploymentKey(name);
      ready = true;
    } catch {
      /* Only readiness is public. */
    }
    return {
      name,
      ready,
      delivery: process.env[`${name}_FILE`] ? "mounted-file" : process.env[name] ? "environment" : "missing",
    };
  });
  return { cards, rules, methods, store: await client.secretStoreStatus({ actor }), bootstrap };
}

/** Secure form intake, outside workflow arguments and approval records. */
export const previewConnection = ({ client }: AppContext, actor: Principal, data: PreviewConnectionRequest) =>
  client.previewConnection(data.target, data.credentials, { actor, id: data.requestId });
export const connectConnection = ({ client }: AppContext, actor: Principal, data: ConnectConnectionRequest) =>
  client.connectConnection(data.review, data.credentials, { actor });
export const testConnection = (
  { client }: AppContext,
  actor: Principal,
  { connection, requestId }: TestConnectionRequest,
) => client.call("sanoma.connection.test", { connection }, { actor, id: requestId });
export const disconnectConnection = (
  { client }: AppContext,
  actor: Principal,
  { connection, expectedRevision, requestId, revoke }: DisconnectConnectionRequest,
) =>
  client.call(
    revoke ? "sanoma.connection.revoke" : "sanoma.connection.disconnect",
    { connection, expectedRevision },
    { actor, id: requestId },
  );

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
 * `<name>.result` (`{ runId, waitMs? }`, at most 20 s; a failed run's failure, `runFailure`), `.latest`, `.runs` (`{ limit? }`),
 * `.approvals` and `.ledger` (`{ runId }`) read its runs, a run of another workflow being none.
 * `sanoma.describe` (`DESCRIBE_CALL`, a name of the runtime's vendor, so none of the company's)
 * answers `agentDescription`. Anything else is `invalid_input`. A visitor (`isVisitor`) calls no
 * built-in workflow, reads no description and reads only the result of a run it started: its other
 * reads are `policy_denied`. A declared agent (`isDeclaredAgent`) starts no built-in workflow but
 * those in `AGENT_BUILT_INS` (`policy_denied`), as the client refuses it too.
 */
export async function callApi(app: AppContext, actor: Principal, { name, input, id }: CallRequest): Promise<unknown> {
  const { client, resolved } = app;
  if (name === DESCRIBE_CALL) {
    if (isVisitor(actor)) throw new PolicyDeniedError(name, "a visitor does not read the company's description");
    return agentDescription(app.snapshot.description);
  }
  if (resolved.ops.has(name)) {
    return client.call(name, input ?? {}, { actor, ...(id === undefined ? {} : { id }) });
  }
  const [api, method = "start", ...rest] = name.split(".");
  // Two workflows of one api name (a problem describeConfig reports) are neither.
  const named = rest.length ? [] : app.snapshot.description.workflows.filter((wf) => apiNameOf(wf.name) === api);
  const entry = named.length === 1 ? named[0] : undefined;
  const visitor = isVisitor(actor);
  if (!entry || (visitor && entry.builtin)) throw notCallable(name);
  const workflow = entry.name;
  // As `SanomaClient.start` refuses it: a declared agent starts no built-in but `call` and those it may.
  if (
    method === "start" &&
    entry.builtin &&
    workflow !== CALL_WORKFLOW &&
    isDeclaredAgent(actor) &&
    !AGENT_BUILT_INS.has(workflow)
  ) {
    throw new PolicyDeniedError(name, AGENT_BUILT_IN_REFUSAL);
  }
  if (visitor && method !== "start" && method !== "result") {
    throw new PolicyDeniedError(name, "a visitor reads only the result of a run it started");
  }
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
      let run: RunSummary;
      while (!isEnded((run = await runOf(app, workflow, runId, visitor ? actor : undefined)).status)) {
        if (Date.now() >= until) {
          throw new ApiError(409, { error: `Run ${runId} is still running`, code: "run_running", runId });
        }
        await sleep(RESULT_POLL_MS);
      }
      try {
        return await client.result(runId);
      } catch (err) {
        throw run.status === "finished" ? err : runFailure(run, err);
      }
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
      const ledger = await client.ledger(runId);
      return workflow === LOGIN_CODE_WORKFLOW ? ledger.map(sealedShown) : ledger;
    }
    default:
      throw notCallable(name);
  }
}

/** How many of a record's calls `recordHistory` reads: a run's reads of it count, so one a workflow polls still shows its writes. */
const HISTORY_CALLS = 500;

/**
 * The record `key` of the collection `name`, its writes newest first (`HistoryEntry`), from the
 * ledger's calls on its target (`SanomaClient.history`): those that wrote it, a run's reads and
 * the failed calls left out, each save against the write before it; `more` when there were
 * more calls than `HISTORY_CALLS`.
 */
export async function recordHistory(
  app: AppContext,
  actor: Principal,
  { name, key }: HistoryRequest,
): Promise<RecordHistory> {
  // The ledger keeps every record a write saved, and `history` answers whoever asks: so only
  // someone the policy lets read the record reads its history, asked as `callFn` asks the read
  // (its refusal, a 403, is the answer). A direct read is not recorded, so asking adds no line.
  // One id per record, so a read the policy holds is one run for the person however often the
  // panel asks again, not an approval each time.
  const get = `data.${name}.get`;
  await callApi(app, actor, { name: get, input: { key }, id: `history:${name}/${key}` });
  // The read answered, so the collection is there, and its target is the one its calls are recorded on.
  const target = app.resolved.ops.get(get)!.target!({ key });
  // Its fields in the order declared, then any a record holds that it no longer declares.
  const declared = Object.keys(app.resolved.collections.get(name)!.fields);
  const deleteOp = `data.${name}.delete`;
  // One more than the limit, to know whether there are more.
  const read = await app.client.history(target, HISTORY_CALLS + 1);
  const more = read.length > HISTORY_CALLS;
  const writes = read.slice(0, HISTORY_CALLS).filter(
    (r): r is Extract<LedgerRecord, { type: "op.called" }> =>
      r.type === "op.called" &&
      r.effect === "write" &&
      r.output !== undefined &&
      // A delete of a record that was not there changed nothing.
      (r.op !== deleteOp || (r.output as { deleted: boolean }).deleted),
  );
  // A sandbox run's writes went to its fakes, not to the collection: only its run says it is one.
  const runs = [...new Set(writes.filter((r) => r.workflow !== CALL_WORKFLOW).map((r) => r.runId))];
  const sandbox = new Set(
    (await Promise.all(runs.map((id) => app.client.run(id)))).flatMap((run) => (run?.sandbox ? [run.runId] : [])),
  );
  // Newest first, as `history` reads them: each against the write after it in the list, the one before it in time.
  const kept = writes.filter((w) => !sandbox.has(w.runId));
  const recordOf = (r: (typeof kept)[number] | undefined) =>
    r && r.op !== deleteOp ? (r.output as Saved).record : undefined;
  const entries = kept.map((r, i): HistoryEntry => {
    const after = recordOf(r);
    const before = recordOf(kept[i + 1]);
    return {
      at: r.at,
      by: r.actor.id,
      workflow: r.workflow,
      runId: r.runId,
      change: !after ? "deleted" : before ? fieldChanges(declared, before, after) : "created",
    };
  });
  // With more, the oldest write read may not be the record's first: it is only what the next changed.
  return { writes: more ? entries.slice(0, -1) : entries, more };
}

/** The fields whose values differ between two records, those `declared` first in its order. */
function fieldChanges(
  declared: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const fields = new Set([...declared, ...Object.keys(after), ...Object.keys(before)]);
  return [...fields]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

/**
 * `POST /api/call`: `callApi` over plain JSON, for a client that is not the app's page, such as
 * Sanoma Cloud's connector with a bearer token, taken only on a public site's host. The body is a
 * `CallRequest`; the answer is the call's output as JSON (`null` for none), or an `ApiError`'s body
 * with its status.
 */
export async function postCall(request: Request, context: ActorContext): Promise<Response> {
  // Only a public site's login reads a token: elsewhere the request would act as the cookie's
  // person, unchecked for CSRF (the route skips it for a token).
  if (context.app.site === undefined && bearerOf(request) !== undefined) {
    return Response.json({ error: "An api token is taken only on a public site's host" }, { status: 401 });
  }
  try {
    const actor = await requireActor(context);
    const call = parse(CallRequest, await request.json().catch(() => undefined), "The request");
    return Response.json((await callApi(context.app, actor, call)) ?? null);
  } catch (err) {
    const { status, body } = toApiError(err, "an api call");
    return Response.json(body, { status });
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

/** The run, when it is one of the workflow's (and `startedBy`'s, when given); a 404 otherwise. */
async function runOf(
  { client }: AppContext,
  workflow: string,
  runId: string,
  startedBy?: Principal,
): Promise<RunSummary> {
  const run = await client.run(runId);
  if (run?.workflow !== workflow || (startedBy && run.startedBy?.id !== startedBy.id))
    throw new ApiError(404, { error: `No run ${runId} of ${workflow}`, code: "run_not_found" });
  return run;
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
