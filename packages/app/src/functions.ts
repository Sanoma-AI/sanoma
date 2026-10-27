import { ANONYMOUS } from "@sanoma-ai/workflows/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  type ActorInfo,
  AdoptRequest,
  CallRequest,
  ChangesQuery,
  ClearCredentialRequest,
  ConnectExistingRequest,
  DecideCall,
  GoLiveRequest,
  PreviewQuery,
  RunsQuery,
  SetCredentialRequest,
} from "./api.ts";
import {
  adopt,
  appConfig,
  callApi,
  change,
  changes,
  clearCredential,
  credentials,
  decide,
  driftReport,
  fileSource,
  hasRemote,
  lastRuns,
  listRuns,
  nextFires,
  permissions,
  preview,
  readStartRun,
  runDetail,
  saysWho,
  scenarios,
  setCredential,
  signOutUrl,
  startRun,
  validate,
} from "./server/core.ts";
import { availableConnectors } from "./server/available.ts";
import { goLive, goLiveChoices, goLiveHost, goLiveProgress } from "./server/go-live.ts";
import { connectExisting, setSetupToken, setupStatus } from "./server/setup.ts";
import { withPrincipal } from "./middleware.ts";
import { chatFor } from "./server/agent/turn.ts";

// The page's reads and changes, as server functions: the app's only HTTP surface. Each parses its
// argument and calls the server core (server/core.ts). Failures, the actor header and the actor
// itself are handled once for all of them, in start.ts. Scripts reach the same runs through
// `SanomaClient` from @sanoma-ai/workflows, not through these.
//
// Runs carry `unknown` inputs and outputs, which Start's type check can't prove serializable.
// They are JSON (they come out of Postgres and the ledger as JSON), so that check is off for
// the outputs: `strict: { output: false }`.
const READ = { method: "GET", strict: { output: false } } as const;
const CHANGE = { method: "POST", strict: { output: false } } as const;

export const getConfig = createServerFn(READ).handler(({ context }) => appConfig(context.app));

/** A file the config names (a workflow's or a data file), as it is now; `null` for any other. */
export const getSource = createServerFn(READ)
  .validator(validate(z.object({ file: z.string().min(1) })))
  .handler(({ data, context }) => fileSource(context.app, data.file));

/**
 * Who the server resolves this request to, and whether the deployment says so itself; nobody for
 * `anonymous`, a public page's nobody (whose calls still run as `anonymous`). A resolver that
 * fails is logged, and the nav says so without its detail.
 */
export const getActor = createServerFn(READ).handler(async ({ context }): Promise<ActorInfo> => {
  const info = { fromServer: saysWho(context.app), signOut: signOutUrl(context.app) };
  try {
    const actor = await context.actor();
    return { ...info, actor: actor && actor.id !== ANONYMOUS ? actor : null };
  } catch (err) {
    console.error("sanoma app: resolveActor failed:", err);
    return { ...info, actor: null, error: "Could not tell who you are" };
  }
});

/** The config's scenarios, read again from their feature files whenever one has changed: the agent may be editing them. */
export const getScenarios = createServerFn(READ).handler(({ context }) => scenarios(context.app));

export const getRuns = createServerFn(READ)
  .validator(validate(RunsQuery))
  .handler(({ data, context }) => listRuns(context.app, data));

/** When each workflow on a schedule fires next, ISO 8601 by name. */
export const getNextFires = createServerFn(READ).handler(({ context }) => nextFires(context.app));

/** Each workflow's latest run, by name. */
export const getLastRuns = createServerFn(READ).handler(({ context }) => lastRuns(context.app));

/** The run, or the router's not-found when there is none. */
export const getRun = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => runDetail(context.app, data.id));

/** The changes, newest first: the open ones, the done ones, or all (`ChangesQuery`). */
export const getChanges = createServerFn(READ)
  .validator(validate(ChangesQuery))
  .handler(({ data, context }) => changes(context.app, data));

/** The change of a draft, by the draft's id, or the router's not-found when it has none. */
export const getChange = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => change(context.app, data.id));

/** Whether the repository has a remote, where its changes are reviewed: the bar's Changes. */
export const getRemote = createServerFn(READ).handler(({ context }) => hasRemote(context.app));

export const startRunFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(readStartRun)
  .handler(({ data, context }) => startRun(context.app, context.principal, data));

/** The policy's answers ahead of a call (`preview`), as the session's actor, never one the page names. */
export const previewFn = createServerFn(READ)
  .middleware([withPrincipal])
  .validator(validate(PreviewQuery))
  .handler(({ data, context }) => preview(context.app, context.principal, data));

/**
 * The Permissions page's grid (`permissions`): what the policy would answer each group, whoever
 * is asking.
 */
export const getPermissions = createServerFn(READ).handler(({ context }) => permissions(context.app));

export const decideFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(DecideCall))
  .handler(({ data, context }) => decide(context.app, context.principal, data));

/** A drift run's report, once it has ended. */
export const getDriftReport = createServerFn(READ)
  .validator(validate(z.object({ runId: z.string().min(1) })))
  .handler(({ data, context }) => driftReport(context.app, data.runId));

/** Writes what the vendor holds for drifted fields into their data file, and commits it when the app has a source. */
export const adoptFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(AdoptRequest))
  .handler(({ data, context }) => adopt(context.app, context.principal, data));

/** Each vendor's credential statuses now: they change as people set them, and with the environment. */
export const getCredentials = createServerFn(READ).handler(({ context }) => credentials(context.app));

export const setCredentialFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(SetCredentialRequest))
  .handler(({ data, context }) => setCredential(context.app, context.principal, data));

export const clearCredentialFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(ClearCredentialRequest))
  .handler(({ data, context }) => clearCredential(context.app, context.principal, data));

/** What is connected for going live: the GitHub App's slug, and whether each token is set. */
export const getSetupStatus = createServerFn(READ).handler(({ context }) => setupStatus(context.app));

/** Stores a pasted setup token (`GITHUB_TOKEN`, `SUPABASE_ACCESS_TOKEN`) as the actor; never sent back. */
export const setSetupTokenFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(SetCredentialRequest))
  .handler(({ data, context }) => setSetupToken(context.app, context.principal, data));

/** The connector packages on npm. */
export const getAvailableConnectors = createServerFn(READ).handler(() => availableConnectors());

/** What going live can choose from: GitHub accounts, Supabase organizations and regions, the host. */
export const getGoLiveChoices = createServerFn(READ).handler(({ context }) => goLiveChoices(context.app));

/** How far going live is: `infra.ts`, the bindings, the latest apply run, the host. */
export const getGoLiveProgress = createServerFn(READ).handler(({ context }) => goLiveProgress(context.app));

/** Writes `infra.ts` for the choices and applies the repository and the database. */
export const goLiveFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(GoLiveRequest))
  .handler(({ data, context }) => goLive(context.app, context.principal, data));

/** Pushes the local repository, then applies the host. */
export const goLiveHostFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .handler(({ context }) => goLiveHost(context.app, context.principal));
/** Declares an existing repository and/or project in infra.ts, commits it, and starts the apply that binds them. */
export const connectExistingFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(ConnectExistingRequest))
  .handler(({ data, context }) => connectExisting(context.app, context.principal, data));

/** The person's chats, the newest first; a turn is `POST /api/chat` (routes/api/chat.ts). */
export const getChats = createServerFn(READ)
  .middleware([withPrincipal])
  .handler(({ context }) => context.app.client.chats.list(context.principal.id));

/** The person's chat with its transcript, or null. */
export const getChat = createServerFn(READ)
  .middleware([withPrincipal])
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => chatFor(context.app, context.principal, data.id));

/**
 * A site's `api` (api-client.ts): an operation called directly, or a workflow started or its runs
 * read, as the person asking (`callApi`).
 */
export const callFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(CallRequest))
  .handler(({ data, context }) => callApi(context.app, context.principal, data));
