// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ADMIN,
  type ApprovalState,
  type DriftReport,
  errorCode,
  errorMessage,
  type InputIssue,
  invalidInput,
  isEnded,
  isRules,
  type LedgerRecord,
  loadPolicies,
  mayDeclarePeople,
  nextFire,
  PolicyDeniedError,
  type PreviewAnswer,
  Principal,
  remoteFor,
  type RunSummary,
  type SanomaError,
  type Source,
} from "@sanoma-ai/workflows";
import { apiNameOf, isVisitor } from "@sanoma-ai/workflows/shared";
import {
  type ConfigDescription,
  type DataValue,
  formatOptions,
  NotLiteral,
  permissionsGrid,
  setFields,
} from "@sanoma-ai/workflows/describe";
import { check, loadScenarios } from "@sanoma-ai/workflows/scenario";
import { isNotFound, isRedirect, notFound } from "@tanstack/react-router";
import { z } from "zod";
import {
  ACTOR_HEADER,
  type AdoptRequest,
  type AdoptResponse,
  ApiError,
  type AppConfig,
  type CallRequest,
  type ChangeDetail,
  ChangesQuery,
  type ClearCredentialRequest,
  type CredentialsResponse,
  type DecideCall,
  type EnforcementResponse,
  type ErrorResponse,
  type PatchRequest,
  type PatchResponse,
  type PermissionsResponse,
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
import { contentFields } from "../content-files.ts";
import { databaseHost, LOOPBACK } from "../loopback.ts";
import { secretValues } from "./secrets.ts";

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
 * What `getConfig` answers (`AppConfig`): the description `withoutSources`, where this instance
 * is, and the content kinds as they are now (`contentFields`).
 */
export const appConfig = (app: AppContext): AppConfig => ({
  ...withoutSources(app.description),
  place: app.place,
  databaseHost: databaseHost(app.resolved.databaseUrl),
  content: app.resolved.root === undefined ? [] : contentFields(app.resolved.root),
});

/**
 * When each workflow on a schedule fires next, ISO 8601 by name (`nextFire`, as the worker's
 * scheduler finds it): computed here, never in the browser from the cron. `resolveConfig` has
 * refused a schedule that never fires, or one DBOS cannot read.
 */
export function nextFires({ description }: Pick<AppContext, "description">, now = new Date()): Record<string, string> {
  const fires: Record<string, string> = {};
  for (const { name, trigger } of description.workflows) {
    if (trigger !== "manual") fires[name] = nextFire(trigger.schedule, trigger.timezone, now).toISOString();
  }
  return fires;
}

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
 * as the outline read it, with `\n` line endings) or a company file (a resource's, a collection's,
 * a site's or an app's, or a problem's `file`, relative to the config's root). Never a path the request makes up. `null` when the
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
      description.sites.some((site) => site.at?.file === file) ||
      description.apps.some((app) => app.at?.file === file) ||
      description.problems.some((p) => p.file === file));
  if (!workflowFile && !dataFile) return { source: null };
  try {
    const text = await readFile(workflowFile ? file : join(resolved.root!, file), "utf8");
    return { source: workflowFile ? text.replaceAll("\r\n", "\n") : text };
  } catch {
    return { source: null };
  }
}

/**
 * How many commits the app `folder`'s source has that the live checkout lacks, fetched now
 * (`Source.behind`), or why that cannot be told: offline, no shared history, or an instance whose
 * repository cannot fetch. Only an app the description lists, taken from a source.
 */
export async function appBehind(
  { source, description }: Pick<AppContext, "source" | "description">,
  folder: string,
): Promise<{ behind: number } | { error: string }> {
  if (!description.apps.some((app) => app.name === folder && app.source !== undefined)) {
    return { error: `No app apps/${folder}/ taken from a source` };
  }
  if (!source?.behind) return { error: "This instance's repository cannot fetch an app's source" };
  try {
    return { behind: await source.behind(folder) };
  } catch (err) {
    return { error: errorMessage(err) };
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

/** Refuses the request with a 400 `invalid_input`, its issue at `field`, as a form shows it beside the field. */
export function invalid(field: string, error: string): never {
  throw new ApiError(400, {
    error,
    code: "invalid_input",
    issues: [{ path: [field], message: error, code: "custom" }],
  });
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

/** The changes, newest first, open or done or all (`SanomaClient.changes`). */
export const changes = ({ client }: AppContext, query: z.output<typeof ChangesQuery>) => client.changes(query);

/**
 * The change of the draft `id` (`SanomaClient.change`), with the config's workflows whose files
 * it edits (`edits`), or null when the draft has none.
 */
export async function change({ client, resolved, source }: AppContext, id: string): Promise<ChangeDetail | null> {
  const view = await client.change(id);
  if (!view) return null;
  // As the planner finds them: a workflow's file relative to the repository's root, in `touches`.
  const touched = new Set(view.state.facts?.touches);
  const edits = source
    ? [...resolved.workflows.values()]
        .filter((wf) => touched.has(relative(source.root, wf.file).split(sep).join("/")))
        .map((wf) => wf.name)
    : [];
  return { ...view, edits };
}

/**
 * Whether the repository has a remote (`Source.remoteUrl`): where a change is reviewed, so the bar
 * shows Changes. Not the URL itself, which may carry a token. A repository git cannot read has
 * none, logged, so every page's bar still renders.
 */
export function hasRemote({ source }: AppContext): Promise<boolean> {
  if (!source) return Promise.resolve(false);
  // Every page's root loader asks: git is asked at most once a minute per repository.
  const kept = remotes.get(source);
  if (kept && Date.now() - kept.at < 60_000) return kept.has;
  const has = remoteUrlOf(source).then((url) => url !== undefined);
  remotes.set(source, { at: Date.now(), has });
  return has;
}

/** The repository's remote URL (`Source.remoteUrl`); none when git cannot read it, logged. */
const remoteUrlOf = async (source: Source): Promise<string | undefined> => {
  try {
    return await source.remoteUrl?.();
  } catch (err) {
    console.error("sanoma app: reading the repository's remote failed:", err);
    return undefined;
  }
};

/** Each repository's last answer to `hasRemote`, and when it was asked. */
const remotes = new WeakMap<object, { at: number; has: Promise<boolean> }>();

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
  const page = new URL(`/changes/${encodeURIComponent(id)}`, origin).href;
  return { runId: await client.openChange({ id, title: chat.title, page }, { startedBy: actor }) };
}

/**
 * What the repository's host enforces on `main` (`SourceHost.enforcement`), with the host's name:
 * the Permissions page's line. Null without a remote, or when no connector's remote half is for
 * its host; a repository git cannot read has none (`remoteUrlOf`). A host that cannot be asked
 * is logged, and answered as enforcing nothing, saying so (its error stays in the log).
 */
export async function hostEnforcement({
  client,
  description,
  resolved,
  source,
}: Pick<AppContext, "client" | "description" | "resolved" | "source">): Promise<EnforcementResponse> {
  const url = source && (await remoteUrlOf(source));
  const found = url === undefined ? undefined : remoteFor(resolved.remotes, url);
  if (!found) return null;
  const host = description.vendors[found.vendor]!.title;
  try {
    return { host, ...(await found.remote.open(found.repo, { secrets: secretValues(client) }).enforcement("main")) };
  } catch (err) {
    console.error(`sanoma app: asking ${host} what it enforces on main failed:`, err);
    return { host, pullRequest: false, check: false, reason: `${host} could not be asked; the app's log says why.` };
  }
}

/** The report of a drift run once it ends (`SanomaClient.driftReport`). */
export const driftReport = ({ client }: AppContext, runId: string): Promise<DriftReport> => client.driftReport(runId);

/** The adopt or patch under way, if any: one at a time, so two never read the same file and both write it. */
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

async function adoptNow(app: AppContext, actor: Principal, { runId, id, paths }: AdoptRequest): Promise<AdoptResponse> {
  const { client, resolved } = app;
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
  let text: string;
  try {
    text = await setFields(
      await readFile(join(resolved.root, file), "utf8"),
      id.slice(at + 1),
      fields,
      formatOptions(resolved.root),
    );
  } catch (err) {
    throw new ApiError(409, { error: `Could not adopt into ${file}: ${errorMessage(err)}` });
  }
  return written(app, actor, file, text, `Adopt ${paths.join(", ")} of ${result.name} from ${result.vendor}`);
}

/**
 * Writes `text` into the checkout's `file` (relative to the root), then commits it through the
 * app's source, when it has one, as `actor`: what Adopt and a patch without a remote land as.
 */
async function written(
  { resolved, source }: AppContext,
  actor: Principal,
  file: string,
  text: string,
  message: string,
): Promise<{ file: string; revision?: string }> {
  const path = join(resolved.root!, file);
  await writeFile(path, text);
  if (!source) return { file };
  try {
    const commit = await source.commit({ paths: [relative(source.root, path)], message, author: actor.id });
    return { file, ...(commit && { revision: commit.revision }) };
  } catch (err) {
    // Said, not hidden behind a 500's "Something went wrong": the file is written, and uncommitted.
    throw new ApiError(500, { error: `Wrote ${file}, but could not commit it: ${errorMessage(err)}` });
  }
}

/**
 * A form's Save: sets `fields` of the declaration at `at` (one the description names: a resource,
 * a collection, a site or an app) in its file (`setFields`), as `actor`, and lands it. With a
 * repository that drafts and has a remote a connector's remote half is for, it is a change: the
 * file written in a draft of its own (`ui-<id>`), committed there, and the change opened for
 * review (`SanomaClient.openChange`), whose run holds a change to the rules for `admin`; the
 * change's run id. Otherwise the file is written in the checkout and committed as Adopt does, but
 * a change to the rules (a people file) only by someone in `admin`: a 403 for anyone else, since
 * nothing would review it. A 404 for a declaration the description does not name; a 409, with the
 * writer's reason, for a field the file computes or a declaration that is no object literal.
 * Patches run one at a time, with Adopt's.
 */
export function patch(
  app: AppContext,
  actor: Principal,
  request: PatchRequest,
  origin?: string,
): Promise<PatchResponse> {
  const done = adopting.then(() => patchNow(app, actor, request, origin));
  adopting = done.catch(() => undefined);
  return done;
}

async function patchNow(
  app: AppContext,
  actor: Principal,
  { at, fields }: PatchRequest,
  origin: string | undefined,
): Promise<PatchResponse> {
  const { description, resolved, source, client } = app;
  const named = [
    ...description.resources.map((r) => r.at),
    ...description.collections.map((c) => c.declared?.at),
    ...description.sites.map((s) => s.at),
    ...description.apps.map((a) => a.at),
  ].some((known) => known?.file === at.file && known.export === at.export);
  if (!named) {
    throw new ApiError(404, { error: `${at.file}#${at.export} is not a declaration`, code: "invalid_input" });
  }
  if (resolved.root === undefined) throw new Error("The config has no root, so its files cannot be written");
  const root = resolved.root;
  const message = `Change ${Object.keys(fields).join(", ")} of ${at.export === "default" ? at.file : at.export}`;
  /** The file under `dir` as it is, and with the fields set; a 409 saying why they cannot be. */
  const edited = async (dir: string) => {
    try {
      const before = await readFile(join(dir, at.file), "utf8");
      return { before, text: await setFields(before, at.export, fields, formatOptions(root)) };
    } catch (err) {
      const error = err instanceof NotLiteral ? err.reason : `Could not write ${at.file}: ${errorMessage(err)}`;
      throw new ApiError(409, { error });
    }
  };
  if (source?.draft && (await reviewsChanges(app))) {
    // The file as the draft has it: main's, which the change is reviewed against.
    const id = `ui-${randomUUID().slice(0, 8)}`;
    const draft = await source.draft(id);
    const inDraft = join(draft.root, relative(source.root, root));
    try {
      const { text } = await edited(inDraft);
      await writeFile(join(inDraft, at.file), text);
      await draft.commit({ paths: [relative(draft.root, join(inDraft, at.file))], message, author: actor.id });
    } catch (err) {
      // No change will open on it: the draft would be left behind with nothing to close it.
      await source.closeDraft?.(id);
      throw err;
    }
    const page = origin && new URL(`/changes/${encodeURIComponent(id)}`, origin).href;
    return { change: await client.openChange({ id, title: message, ...(page && { page }) }, { startedBy: actor }) };
  }
  const { before, text } = await edited(root);
  if ((isRules(at.file) || mayDeclarePeople(before)) && !actor.groups?.includes(ADMIN)) {
    throw new ApiError(403, {
      error: `A change to ${at.file} waits for an admin, and this company has no remote to review on`,
      code: "not_approver",
    });
  }
  return written(app, actor, at.file, text, message);
}

/**
 * Whether a change can be reviewed: the repository drafts and has a remote that a connector's
 * remote half is for (`remoteFor`), as opening a change needs.
 */
async function reviewsChanges({ resolved, source }: AppContext): Promise<boolean> {
  if (!source?.draft || !source.diff) return false;
  const url = await remoteUrlOf(source);
  return url !== undefined && remoteFor(resolved.remotes, url) !== undefined;
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

/** Each app's grid, by its resolved config: built from the policy and the description, both read once as the app starts. */
const grids = new WeakMap<object, PermissionsResponse>();

/**
 * The Permissions page's grid (`getPermissions`): the policy, its grid (`permissionsGrid`, the
 * one `sanoma check` reports too: nobody's own answer, the actor asking is not used), then the
 * policy's files as the description read them as the app started (`policy.files`, `sourcesOf`).
 */
export function permissions(app: Pick<AppContext, "resolved" | "description">): PermissionsResponse {
  let grid = grids.get(app.resolved);
  if (!grid) {
    const { resolved, description } = app;
    const { files, ...policy } = description.policy;
    grid = { policy, ...permissionsGrid(resolved, description), files: sourcesOf(files) };
    grids.set(resolved, grid);
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
 * Anything else is `invalid_input`. A visitor (`isVisitor`) calls no built-in workflow and reads
 * only the result of a run it started: its other reads are `policy_denied`.
 */
export async function callApi(app: AppContext, actor: Principal, { name, input, id }: CallRequest): Promise<unknown> {
  const { client, description, resolved } = app;
  if (resolved.ops.has(name)) {
    return client.call(name, input ?? {}, { actor, ...(id === undefined ? {} : { id }) });
  }
  const [api, method = "start", ...rest] = name.split(".");
  // Two workflows of one api name (a problem describeConfig reports) are neither.
  const named = rest.length ? [] : description.workflows.filter((wf) => apiNameOf(wf.name) === api);
  const entry = named.length === 1 ? named[0] : undefined;
  const visitor = isVisitor(actor);
  if (!entry || (visitor && entry.builtin)) throw notCallable(name);
  const workflow = entry.name;
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
      while (!isEnded((await runOf(app, workflow, runId, visitor ? actor : undefined)).status)) {
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

const STATUS: Partial<Record<NonNullable<ErrorResponse["code"]>, number>> = {
  invalid_input: 400,
  not_approver: 403,
  not_admitted: 403,
  policy_denied: 403,
  run_not_found: 404,
  no_pending_approval: 404,
  already_decided: 409,
  approval_withdrawn: 409,
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
