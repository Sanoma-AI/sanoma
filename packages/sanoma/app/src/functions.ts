import { ANONYMOUS, DRAFT_ID } from "sanoma/workflows/shared";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  type ActorInfo,
  CallRequest,
  ChangesQuery,
  ClearCredentialRequest,
  CloudSlug,
  PreviewConnectionRequest,
  ConnectConnectionRequest,
  AuthorizeConnectionRequest,
  ConnectionAttemptRequest,
  TestConnectionRequest,
  DisconnectConnectionRequest,
  DecideCall,
  HistoryRequest,
  InviteRequest,
  PreviewQuery,
  ProposeColumnChange,
  RunsQuery,
  SaveDraftRequest,
  SetCredentialRequest,
} from "./api.ts";
import {
  appBehind,
  appConfig,
  callApi,
  change,
  changes,
  clearCredential,
  credentials,
  connections,
  previewConnection,
  connectConnection,
  testConnection,
  disconnectConnection,
  decide,
  driftReport,
  fileSource,
  hostEnforcement,
  lastRuns,
  listRuns,
  nextFires,
  openChange,
  permissions,
  preview,
  readStartRun,
  recordHistory,
  remoteOf,
  runDetail,
  saveDraft,
  saves,
  saysWho,
  setCredential,
  signOutUrl,
  startRun,
  validate,
} from "./server/core.ts";
import { authorizeConnection } from "./server/connect.ts";
import { availableConnectors } from "./server/available.ts";
import { proposeColumnChange } from "./server/columns.ts";
import { companyState } from "./server/company-state.ts";
import { cloudAddress, goLiveChoices, goLiveProgress, goLiveSignIn } from "./server/go-live.ts";
import { sanomaSignIn, startSanomaSignIn } from "./server/sanoma-sign-in.ts";
import { hostDerived } from "./server/host-derived.ts";
import { invitePerson, peopleSignIns } from "./server/people.ts";
import { setSetupToken, setupStatus } from "./server/setup.ts";
import { setupProgress } from "./server/setup-progress.ts";
import { ENGINE_COOKIE } from "./components/shell/prefs.ts";
import { withPrincipal } from "./middleware.ts";
import { chatFor } from "./server/chat.ts";
import { chatModel } from "./server/models.ts";

// The page's reads and changes, as server functions: the app's only HTTP surface. Each parses its
// argument and calls the server core (server/core.ts). Failures, the actor header and the actor
// itself are handled once for all of them, in start.ts. Scripts reach the same runs through
// `SanomaClient` from sanoma/workflows, not through these.
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
  .handler(({ data, context }) => fileSource(context.app.snapshot, data.file));

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

/** The config's scenarios, as the snapshot read them from their feature files: the Node adapter's is read again once one changed. */
export const getScenarios = createServerFn(READ).handler(({ context }) => context.app.snapshot.scenarios);

export const getRuns = createServerFn(READ)
  .validator(validate(RunsQuery))
  .handler(({ data, context }) => listRuns(context.app, data));

/** When each workflow on a schedule fires next, ISO 8601 by name. */
export const getNextFires = createServerFn(READ).handler(({ context }) => nextFires(context.app.snapshot.description));

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

/** The change of a draft, by the draft's id, or null when it has none. */
export const getChange = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => change(context.app, data.id));

/**
 * Whether the repository's remote is one a connector reviews changes on (`remoteOf`), as Save and
 * a form's Save decide: the bar's Changes, a draft's Review, a column change waiting for admin.
 */
export const getRemote = createServerFn(READ).handler(({ context }) => remoteOf(context.app) !== undefined);

/** Sends the person's chat's draft for review: its change opened, its run's id. */
export const openChangeFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(z.object({ id: z.string().regex(DRAFT_ID) })))
  .handler(({ data, context }) => openChange(context.app, context.principal, data.id, context.origin));

/** The saves of a chat's draft, by the draft's id, newest first. */
export const getSaves = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().regex(DRAFT_ID) })))
  .handler(({ data, context }) => saves(context.app, data.id));

/** Saves the person's chat's draft, or undoes what it saved: the save's run id. */
export const saveDraftFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(SaveDraftRequest))
  .handler(({ data, context }) => saveDraft(context.app, context.principal, data, context.origin));

/** What the repository's host enforces on main: the Permissions page's line; null without a remote. */
export const getHostEnforcement = createServerFn(READ).handler(({ context }) => hostEnforcement(context.app));

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

/** Each vendor's credential statuses now: they change as people set them, and with the environment. */
export const getCredentials = createServerFn(READ).handler(({ context }) => credentials(context.app));

export const getConnections = createServerFn(READ)
  .middleware([withPrincipal])
  .handler(({ context }) => connections(context.app, context.principal));
export const previewConnectionFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(PreviewConnectionRequest))
  .handler(({ data, context }) => previewConnection(context.app, context.principal, data));
export const connectConnectionFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(ConnectConnectionRequest))
  .handler(({ data, context }) => connectConnection(context.app, context.principal, data));
/** Starts OAuth consent: the URL to open, and the cookie that binds the attempt to this browser. */
export const authorizeConnectionFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(AuthorizeConnectionRequest))
  .handler(async ({ data, context }) => {
    const { cookie, ...started } = await authorizeConnection(context.app, context.principal, data, getRequest());
    setResponseHeader("set-cookie", cookie);
    return started;
  });
export const connectionAttemptFn = createServerFn(READ)
  .middleware([withPrincipal])
  .validator(validate(ConnectionAttemptRequest))
  .handler(({ data, context }) => context.app.client.connectionAttempt(data.attempt, { actor: context.principal }));
export const testConnectionFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(TestConnectionRequest))
  .handler(({ data, context }) => testConnection(context.app, context.principal, data));
export const disconnectConnectionFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(DisconnectConnectionRequest))
  .handler(({ data, context }) => disconnectConnection(context.app, context.principal, data));

/** The latest moves of the secrets between stores, with each secret's receipt and never a value. */
export const getStoreMoves = createServerFn(READ)
  .middleware([withPrincipal])
  .handler(({ context }) => context.app.client.storeMoves({ actor: context.principal }));
export const setCredentialFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(SetCredentialRequest))
  .handler(({ data, context }) => setCredential(context.app, context.principal, data));

export const clearCredentialFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(ClearCredentialRequest))
  .handler(({ data, context }) => clearCredential(context.app, context.principal, data));

/** What is connected for going live: the GitHub App's slug, whether each token is set, and how people will sign in. */
export const getSetupStatus = createServerFn(READ).handler(async ({ context }) =>
  setupStatus(context.app, await context.actor()),
);

/** Stores a pasted setup token (`GITHUB_TOKEN`, `SUPABASE_ACCESS_TOKEN`) as the actor; never sent back. */
export const setSetupTokenFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(SetCredentialRequest))
  .handler(({ data, context }) => setSetupToken(context.app, context.principal, data));

/** The connector packages on npm. */
export const getAvailableConnectors = createServerFn(READ).handler(() => availableConnectors());

/** How many commits a taken app is behind its source, as the worker last checked; or why that cannot be told. */
export const getAppBehind = createServerFn(READ)
  .validator(validate(z.object({ folder: z.string().min(1) })))
  .handler(({ data, context }) => appBehind(context.app, data.folder));

/** What going live can choose from: GitHub accounts, Supabase organizations and regions, the host. */
export const getGoLiveChoices = createServerFn(READ).handler(async ({ context }) =>
  goLiveChoices(context.app, await context.actor()),
);

/** How far going live is: `infra.ts`, the bindings, the latest apply run, the host. */
export const getGoLiveProgress = createServerFn(READ).handler(({ context }) => goLiveProgress(context.app));

/**
 * The company's state: the badge's and Home's, or with `force` Hosting's, with where the host
 * answers and whether it does.
 */
export const getCompanyState = createServerFn(READ)
  .validator(validate(z.object({ force: z.boolean().optional() })))
  .handler(({ data, context }) => companyState(context.app, data));

/** Home's setup card: each step done or not, the agent's from the engine cookie too. */
export const getSetupProgress = createServerFn(READ).handler(({ context }) =>
  setupProgress(context.app, getCookie(ENGINE_COOKIE)),
);

/** What apply gives the declared host that derives: its image, source, branch, domains and keys (never a value). */
export const getHostDerived = createServerFn(READ).handler(({ context }) => hostDerived(context.app));

/** Signs the person going live in on the host, by a sealed invite request: the link to open. */
export const goLiveSignInFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .handler(({ context }) => goLiveSignIn(context.app, context.principal));

/**
 * Starts signing in to Sanoma, on this computer: the Cloud's page to open in the browser, for the
 * company's address (`address`, when the person changed it); the callback stores the token.
 */
export const startSanomaSignInFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(z.object({ address: CloudSlug.optional() })))
  .handler(({ data, context }) => startSanomaSignIn(context.app, context.principal, context.origin, data));

/** Whether a Cloud token is stored, and whether a sign-in to Sanoma is being made: never the token. */
export const getSanomaSignIn = createServerFn(READ).handler(({ context }) => sanomaSignIn(context.app));

/** Whether an address at Sanoma Cloud can be the company's: free, its account's own, or someone else's. */
export const getCloudAddress = createServerFn(READ)
  .middleware([withPrincipal])
  .validator(validate(z.object({ slug: CloudSlug })))
  .handler(({ data, context }) => cloudAddress(context.app, context.principal, data.slug));

/** When each declared person last signed in, and whether this app mints invite links. */
export const getPeopleSignIns = createServerFn(READ).handler(({ context }) => peopleSignIns(context.app));

/** A one-use invite link for a declared person, minted by the host's staff login. */
export const inviteFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(InviteRequest))
  .handler(({ data, context }) => invitePerson(context.app, context.principal, data.person, context.origin));

/** Whether the chat has a model to answer on, its connector's key set: the composer says "Connect a model" until then. */
export const getChatModel = createServerFn(READ).handler(({ context }) => chatModel(context.app));

/** The person's chats, the newest first; a turn is `POST /api/chat` (routes/api/chat.ts). */
export const getChats = createServerFn(READ)
  .middleware([withPrincipal])
  .handler(({ context }) => context.app.client.chats.list(context.principal.id));

/** The person's chat with its transcript, or null. */
export const getChat = createServerFn(READ)
  .middleware([withPrincipal])
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => chatFor(context.app, context.principal, data.id));

/** A collection's record's writes, newest first, from the ledger: for someone the policy lets read the record. */
export const getHistory = createServerFn(READ)
  .middleware([withPrincipal])
  .validator(validate(HistoryRequest))
  .handler(({ data, context }) => recordHistory(context.app, context.principal, data));

/**
 * A change to a collection's columns, from the grid's column menu or its New column panel: the
 * collection's declaration edited by a `patch` run, the change it opened carrying the plan (`proposeColumnChange`).
 */
export const proposeColumnChangeFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(ProposeColumnChange))
  .handler(({ data, context }) => proposeColumnChange(context.app, context.principal, data));

/**
 * A site's `api` (api-client.ts): an operation called directly, or a workflow started or its runs
 * read, as the person asking (`callApi`).
 */
export const callFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(CallRequest))
  .handler(({ data, context }) => callApi(context.app, context.principal, data));
