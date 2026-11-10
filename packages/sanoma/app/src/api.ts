import type {
  ApplyPlan,
  ApplyResult,
  ApprovalState,
  CallbackError,
  ChangeView,
  Authentication,
  ConnectionCard,
  ConnectionReview,
  SanomaClient,
  CredentialStatus,
  ErrorCode,
  HostEnforcement,
  InputIssue,
  LedgerRecord,
  PreviewRequest,
  Principal,
  RunSummary,
} from "sanoma/workflows";
import type { ConfigDescription, PermissionsGrid, Span } from "sanoma/workflows/describe";
import { ConfigDescriptionSchema } from "sanoma/workflows/description";
import type { RunCheck, Scenario } from "sanoma/workflows/scenario";
import { EFFECTS, RUN_STATUSES, type Saved } from "sanoma/workflows/shared";
import { z } from "zod";
import { ColumnChange } from "./components/grid/plan.ts";

/**
 * The shapes the app's server functions take and return. The page imports this file too, so
 * the server and the browser agree on them. Only types come from
 * `sanoma/workflows`, so the browser bundle never loads the runtime; values the page shares
 * with the runtime come from `sanoma/workflows/shared`, and the description's schema from
 * `sanoma/workflows/description`.
 */

/**
 * Who is asking, without a login: the page asks once and sends the name in this header with
 * every server function call, which the default loopback login reads.
 */
export const ACTOR_HEADER = "x-sanoma-actor";

/**
 * The same name, kept in a cookie by the page as well (URI-encoded), so the loopback login knows
 * who is asking while the server renders a page, whose loader may call `api`. The header wins.
 */
export const ACTOR_COOKIE = "sanoma_actor";

/** Where the page keeps the name in this browser's storage, which the header is sent from. */
export const ACTOR_KEY = "sanoma.actor";

const PlaceSchema = z.enum(["this-computer", "live"]);
/** What the open window is, from what this instance connects to; never a flag (`placeOf`). */
export type Place = z.infer<typeof PlaceSchema>;

/**
 * What `getConfig` answers: the description, less the workflows' sources, and where this instance
 * is: its `place`, and its database's host (only the host, never the URL; none when it cannot be
 * read), which the bar's badge says as its tip; and the repo's content kinds, each with the front
 * matter keys its files hold (`contentFields`).
 */
export const AppConfigSchema = ConfigDescriptionSchema.extend({
  place: PlaceSchema,
  databaseHost: z.string().optional(),
  content: z.array(z.strictObject({ kind: z.string(), fields: z.array(z.string()) })),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Who the server says is asking. With a login provider (`fromServer`), it is whoever signed in,
 * which the page shows and cannot change; with the default loopback login, it is whatever name
 * the page sends, so the page asks for one and keeps it.
 */
export interface ActorInfo {
  fromServer: boolean;
  /** Null when the request names nobody. */
  actor: Principal | null;
  /** Set when the login's `resolveActor` threw: it could not say. */
  error?: string;
  /** Where the page signs out (POST), when the login has its own routes. */
  signOut?: string;
}

const StartWorkflowRequest = z.object({ workflow: z.string().min(1, "Name a workflow"), input: z.unknown() });

const StartScenarioRequest = z.strictObject(
  { scenario: z.string().min(1, "Name a scenario") },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys" && issue.keys.some((key) => key === "workflow" || key === "input")
        ? "Send a workflow or a scenario, not both"
        : undefined,
  },
);

/**
 * What `startRunFn` takes: a workflow and its input, or a scenario's name, which starts a sandbox
 * run of the scenario's workflow with its input. The app never decides a sandbox run's approvals:
 * people do, as in a live run.
 */
export type StartRunRequest = z.infer<typeof StartWorkflowRequest> | z.infer<typeof StartScenarioRequest>;

/**
 * The schema a start request is read with, picked before parsing so each refusal names its own
 * field: the scenario's for an argument with a `scenario` key (which refuses a `workflow` or
 * `input` beside it), else the workflow's.
 */
export const startRunSchema = (body: unknown) =>
  typeof body === "object" && body !== null && "scenario" in body ? StartScenarioRequest : StartWorkflowRequest;

/** A started run's id and its workflow (for a scenario, the scenario's): its page's address. */
export interface StartRunResponse {
  runId: string;
  workflow: string;
}

/**
 * A decision on an approval, as the page's dialog sends it. `decideFn` answers with the
 * approval's `ApprovalState`: `approved` or `rejected` once the run has read the decision, or
 * still `pending` when the run did not read it within a few seconds, typically because no worker
 * is running. A pending decision stays queued, and the run reads it when it next runs. A run that
 * has finished, failed or been cancelled takes no decision: 409 `run_ended`.
 */
export const DecideRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

/** The decide server function's argument: the request plus where it goes. */
export const DecideCall = DecideRequest.extend({ runId: z.string().min(1), approvalId: z.string().min(1) });
export type DecideCall = z.infer<typeof DecideCall>;

/** How many runs one read lists. */
export const RUNS_LIMIT = { default: 50, max: 500 } as const;

/** What `getRuns` takes: the latest runs, or the latest with that status, of that workflow. */
export const RunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT.max).default(RUNS_LIMIT.default),
  status: z.enum(RUN_STATUSES).optional(),
  workflow: z.string().min(1).optional(),
});
export type RunsQuery = z.input<typeof RunsQuery>;

/** What `getChanges` takes: the open changes (not ended), the done ones, or all; at most `limit` (20), newest first. */
export const ChangesQuery = z.object({
  open: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT.max).optional(),
});
export type ChangesQuery = z.input<typeof ChangesQuery>;

/**
 * A change as `getChange` reads it: the client's `ChangeView`, and the config's workflows whose
 * files it edits, by name (the workflows its stranded runs are of).
 */
export interface ChangeDetail extends ChangeView {
  edits: string[];
}

/** One run as `getRun` reads it: the run, its ledger, its approvals and a sandbox run's checks. */
export interface RunDetail {
  run: RunSummary;
  /** The run's ledger records in `seq` order. */
  ledger: LedgerRecord[];
  /**
   * Why the ledger could not be read, when it could not, or why a run that has started has no
   * records there. `ledger` is then empty.
   */
  ledgerError?: string;
  approvals: ApprovalState[];
  /**
   * For a sandbox run, each of its scenario's expectations checked against the ledger, as the
   * worker ran them when the run last waited or ended (`SanomaClient.runChecks`); until it first
   * has, each of its scenario's Then steps, not settled. Absent until the run has been seeded, and
   * when `checksError` says why there are none.
   */
  checks?: RunCheck[];
  /**
   * Why a seeded sandbox run has no checks: its scenario is no longer in the feature files (with
   * those that did not load), or the scenarios could not be read at all.
   */
  checksError?: string;
}

/**
 * A scenario as the page lists it: what it says and the input its run starts with, not how the
 * worker seeds and checks it.
 */
export type ScenarioEntry = Pick<Scenario, "name" | "workflow" | "file" | "text" | "steps" | "input">;

/** Every scenario, and why each feature file that could not be read could not. */
export interface ScenariosResponse {
  scenarios: ScenarioEntry[];
  errors: { file: string; message: string }[];
}

/**
 * Each vendor's declared variables and their statuses now, by vendor id
 * (`SanomaClient.credentials`): where each value is from and, for a stored one, who set it and
 * when. Never a value.
 */
export type CredentialsResponse = Record<string, CredentialStatus[]>;

/** Metadata-only account management. Secret values are accepted only by the two intake calls. */
export interface ConnectionsResponse {
  cards: (ConnectionCard & {
    workflows: { name: string; title: string; selection: "default" | "selected" | "possible" }[];
  })[];
  rules: { id: string; name: string; vendor: string; method: string; scopes: readonly string[] }[];
  methods: Record<
    string,
    Record<
      string,
      {
        kind: Authentication["kind"];
        verifiable: boolean;
        schema?: Record<string, unknown>;
        /** An OAuth method that can revoke its grant at the provider (Revoke). */
        revocable?: boolean;
      }
    >
  >;
  store: Awaited<ReturnType<SanomaClient["secretStoreStatus"]>>;
  bootstrap: {
    name: "SANOMA_SIGNING_KEY" | "SANOMA_SECRETS_KEY";
    ready: boolean;
    delivery: "environment" | "mounted-file" | "missing";
  }[];
}
const ConnectionReference = z.object({ vendor: z.string().min(1), $connection: z.string().min(1) });
export const ConnectionTarget = z.union([
  z.object({ connection: ConnectionReference }),
  z.object({ rule: z.string().min(1) }),
]);
const SecureCredentials = z
  .unknown()
  .refine(
    (value) => value === undefined || JSON.stringify(value).length <= 1_048_576,
    "The credential bundle is too large",
  );
export const PreviewConnectionRequest = z.object({
  target: ConnectionTarget,
  requestId: z.string().min(1).max(200),
  credentials: SecureCredentials.optional(),
});
export type PreviewConnectionRequest = z.infer<typeof PreviewConnectionRequest>;
const ConnectionReviewSchema: z.ZodType<ConnectionReview> = z.object({
  target: ConnectionTarget,
  id: z.string(),
  vendor: z.string(),
  method: z.string(),
  definition: z.string(),
  credential: z.string().optional(),
  location: z
    .object({ store: z.string(), namespace: z.string(), path: z.string(), management: z.enum(["sanoma", "external"]) })
    .optional(),
  expectedRevision: z.string().nullable(),
  requiredScopes: z.array(z.string()),
  expectedAccount: z.string().optional(),
  previousAccount: z.string().optional(),
  previousLocation: z
    .object({ store: z.string(), namespace: z.string(), path: z.string(), management: z.enum(["sanoma", "external"]) })
    .optional(),
  requestId: z.string().min(1).max(200),
  authorization: z.string(),
  account: z.string(),
  scopes: z.array(z.string()),
  credentialVersion: z.string().nullable(),
  expiresAt: z.number().optional(),
});
export const ConnectConnectionRequest = z.object({
  review: ConnectionReviewSchema,
  credentials: SecureCredentials.optional(),
});
export type ConnectConnectionRequest = z.infer<typeof ConnectConnectionRequest>;
/** What `authorizeConnectionFn` takes: the connection, its request, and the OAuth application when it is entered or replaced. */
export const AuthorizeConnectionRequest = z.object({
  target: ConnectionTarget,
  requestId: z.string().min(1).max(200),
  // Within the stored application's 8 KiB bundle.
  client: z.object({ clientId: z.string().min(1).max(1024), clientSecret: z.string().min(1).max(4096) }).optional(),
});
export type AuthorizeConnectionRequest = z.infer<typeof AuthorizeConnectionRequest>;
/** What `connectionAttemptFn` takes: an attempt the actor started. */
export const ConnectionAttemptRequest = z.object({ attempt: z.string().min(1).max(200) });
export type ConnectionAttemptRequest = z.infer<typeof ConnectionAttemptRequest>;

/** Why an OAuth callback came back without a connection, as the connector page's `?error=` says it. */
export const CALLBACK_ERRORS = {
  expired: "The connection attempt expired. Connect again.",
  mismatch: "This browser did not start that connection attempt. Connect again from this page.",
  replayed: "That consent was already used. Connect again to authorize a new one.",
  declined: "Consent was declined at the provider. Nothing changed.",
  rejected: "The provider refused the authorization. Check the OAuth application, then connect again.",
  failed: "The connection could not be completed. Connect again.",
} as const satisfies Record<CallbackError["reason"] | "failed", string>;
export type CallbackErrorReason = keyof typeof CALLBACK_ERRORS;
export const TestConnectionRequest = z.object({
  connection: ConnectionReference,
  requestId: z.string().min(1).max(200),
});
export type TestConnectionRequest = z.infer<typeof TestConnectionRequest>;
/** Disconnect, or with `revoke`, revoke the OAuth grant at the provider first (`sanoma.connection.revoke`). */
export const DisconnectConnectionRequest = TestConnectionRequest.extend({
  expectedRevision: z.string().min(1),
  revoke: z.boolean().optional(),
});
export type DisconnectConnectionRequest = z.infer<typeof DisconnectConnectionRequest>;

/**
 * Whether the chat has a model to answer on (`getChatModel`): the connector whose model the loop
 * uses, when one has a model half, and whether its key is set.
 */
export interface ChatModel {
  vendor?: string;
  ready: boolean;
}

/** What `setCredentialFn` takes: a declared variable and its value, stored as the actor. The value is never sent back. */
export const SetCredentialRequest = z.object({
  name: z.string().min(1, "Name a variable"),
  value: z.string().min(1, "Enter a value").max(16_384),
});
export type SetCredentialRequest = z.infer<typeof SetCredentialRequest>;

/** What the connect page shows (`getSetupStatus`): the GitHub App, once created, and the pasted tokens' statuses. Never a value. */
export interface SetupStatus {
  /**
   * The company's GitHub App, once its keys are stored, with `missing`: the permissions the
   * manifest asks for that GitHub's listing of the App lacks (one made before the manifest asked
   * for them, or by hand), as `<name>: <level>`; null when GitHub did not say.
   */
  githubApp: { slug: string; setBy?: string; setAt?: string; missing: string[] | null } | null;
  tokens: CredentialStatus[];
  /** Which of `tokens` is the identity enrollment writer's URL, when the config names one with `secret()`. */
  enrollmentWriter?: string;
  /**
   * How people will sign in on the host: `you`, the email declared for the person asking (the
   * invite that signs them in once the host answers goes to it); `sender`, the config's
   * `login.sender` operation, and whether its connector's credentials are set; whether the GitHub
   * App's client is stored, for "Sign in with GitHub"; and the public sites with a login
   * (`sites`), whose visitors that client lets sign in with GitHub too. Neither a sender nor GitHub
   * leaves invite links alone: a warning, not blocking.
   */
  signIn: {
    you: string | null;
    sender: string | null;
    senderConnected: boolean;
    github: boolean;
    sites: { name: string; login: string }[];
  };
}

/** The People page's sign-in facts (`getPeopleSignIns`): whether this app mints invite links, and when each person last signed in. */
export interface PeopleSignIns {
  invites: boolean;
  /** By person id: when (milliseconds since the epoch) and how; one who never signed in is left out. */
  last: Record<string, { at: number; method: string }>;
}

/** What `inviteFn` takes: the declared person to mint a one-use invite link for. */
export const InviteRequest = z.object({ person: z.string().min(1) });
export type InviteRequest = z.infer<typeof InviteRequest>;

/** A one-use link that signs a person in, until `expiresAt` (ISO 8601). */
export interface InviteLink {
  url: string;
  expiresAt: string;
}

/**
 * The vendors `/setup` connects with pasted tokens, as the pages show them and going live reads
 * them: each one's id, its setup tokens (`SETUP_TOKENS`, asked for only when the config declares
 * a type of the vendor), all of which must be stored for it to be connected, and what connecting
 * it does.
 */
export const SETUP_VENDORS: readonly {
  vendor: string;
  title: string;
  tokens: readonly string[];
  about: string;
}[] = [
  {
    vendor: "supabase",
    title: "Supabase",
    tokens: ["SUPABASE_ACCESS_TOKEN"],
    about: "An access token, which lists and creates projects.",
  },
  {
    vendor: "neon",
    title: "Neon",
    tokens: ["NEON_API_KEY"],
    about: "An organization API key, which creates projects.",
  },
  {
    vendor: "cloudflare",
    title: "Cloudflare",
    tokens: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    about:
      "An API token and the account, so the company runs on Cloudflare Containers and stops when nothing is due. Connect it before choosing where the company goes.",
  },
  {
    vendor: "agent37",
    title: "Agent37",
    tokens: ["AGENT37_API_KEY"],
    about:
      "Optional: an API key, so that coding agents work for the live company in a box of their own at Agent37. Connect it before choosing where the company goes, which declares the box.",
  },
  {
    vendor: "sanoma",
    title: "Wakeup service",
    tokens: ["SANOMA_WAKEUP_URL", "SANOMA_WAKEUP_ACCOUNT_TOKEN"],
    about:
      "Optional: a wakeup service's URL and an account there, so a host with no clock of its own stops when nothing is due and starts again in time. Connect it before choosing where the company goes, which declares the wakeup.",
  },
];

/**
 * How much of a `login-code` run's sealed code its page is sent and shows (`runDetail`): enough
 * to tell two runs apart, never what this deployment could open.
 */
export const SEALED_SHOWN = 4;

/** The data file going live writes, relative to the config's root. */
export const INFRA = "resources/sanoma/infra.ts";

/**
 * What a live instance with no sandbox declared lacks, for the coding agents, which would otherwise
 * run inside it: said by the chat's refusal (`NO_BOX`) and the Hosting page.
 */
export const DECLARE_BOX = `Coding agents work in a box of their own on a live instance, and this company declares none: declare one in ${INFRA} (\`export const box = agent37.instance({})\`, with the agent37 connector in sanoma.config.ts) and set AGENT37_API_KEY`;

/**
 * Why a host of type `hostType` that stops when idle has no Wakeup, `wakes` being the connected
 * wakeups and the host types each wakes, when known: going live's refusal to declare one, and
 * Hosting's notice on a host declared without one.
 */
export const noWakeup = (hostType: string, wakes?: string) =>
  `No connected wakeup wakes a ${hostType}${wakes ? ` (${wakes})` : ""}: going live declares none, and the host stays up`;

/** A connector package on npm (`getAvailableConnectors`). */
export interface AvailableConnector {
  /** The npm package name, what `pnpm add` takes. */
  package: string;
  /** The vendor's name, from the package's `sanoma` field. */
  title: string;
  description?: string;
  /** Its latest version. */
  version: string;
  /** Its logos as `data:` URLs, as installed vendors' are: an `<img>`'s only. */
  logo?: { src: string; dark?: string };
  /** Where its code and README are, as an https URL. */
  homepage?: string;
}

/** The connectors npm lists; `error` when npm could not be searched. */
export interface AvailableConnectors {
  connectors: AvailableConnector[];
  error?: string;
}

/** What going live (on Hosting) offers to choose from (`getGoLiveChoices`), and why a list is empty. */
export interface GoLiveChoices {
  /** The GitHub accounts a repository can be made in: the token's user and organizations, and the App's installations. */
  owners: { login: string; kind: "user" | "organization"; via: "token" | "app" }[];
  /** The Supabase organizations the stored token sees, for a Supabase project; null for a database that takes none. */
  organizations: { id: string; name: string }[] | null;
  /**
   * The database type the company's records go in, `<vendor>.<type>`, its title, the regions it
   * takes (null when it lists none) and whether it takes a size; null when the config has none.
   */
  database: { type: string; title: string; regions: readonly string[] | null; size: boolean } | null;
  /** The host type the company runs on, `<vendor>.<type>`, its title and whether its URL is public; null when the config has none. */
  host: { type: string; title: string; publicUrl: boolean } | null;
  /** The resource types going live needs that the config's connectors do not declare. */
  missing: string[];
  /** The vendors to connect first, by title: the chosen database's and host's, when not connected. */
  connect: string[];
  /** A name to suggest: the app's. */
  name: string;
  /** What could not be listed, and why. */
  errors: string[];
}

/** An apply run as going live (on Hosting) follows it: its status, the plan it waits on, and what it did. */
export interface GoLiveRun {
  runId: string;
  status: RunSummary["status"];
  /** What it asks a person to approve, in the Inbox; the plan. */
  pending?: { approvalId: string; plan?: ApplyPlan };
  results?: ApplyResult[];
  error?: string;
}

/**
 * What apply gives the declared host that derives (`getHostDerived`), shown read-only on Hosting:
 * the runtime image, the repository and branch it runs, the sites' domains it attaches, and the
 * keys it is given, whether each is stored and since when. Never a value.
 */
export interface HostDerived {
  /** The host's declaration id. */
  id: string;
  /** The runtime image it runs; undefined when sanoma is not installed. */
  image?: string;
  /** The repository it clones: a declared one's `owner/name`, or the app's `origin`. */
  source?: string;
  /** The branch it runs: the declared one, else the repository's default branch; undefined when it cannot be told yet. */
  ref?: string;
  /** Each public site's domain, by site name. */
  domains: Record<string, string>;
  /** The keys it is given: stored or not, and when each was set. */
  keys: { name: string; stored: boolean; setAt?: string }[];
}

/** How far going live is (`getGoLiveProgress`): told from the files, the lockfile and the runs, so a reload picks it up. */
export interface GoLiveProgress {
  /** `resources/sanoma/infra.ts`, once written. */
  infra: string | null;
  /** What the first apply makes, of what `infra.ts` declares: the repository, its deploy key and the database. */
  beforeHost: string[];
  /** Whether those are all bound in the lockfile, and whether the host is. */
  bound: { beforeHost: boolean; host: boolean };
  /** The latest apply run. */
  run: GoLiveRun | null;
  /** Where the host answers, from the last apply that made or changed it, and whether `/healthz` answers. */
  host: { url: string; healthy: boolean } | null;
}
/** Said at the top of `infra.ts` when it declares an existing database, and on the page. */
export const PASSWORD_NOTE = [
  "The database password is declared as a generated secret, since Supabase never reads it back.",
  "Binding the project changes nothing; the next apply that changes it sets a new password.",
];

/** What `clearCredentialFn` takes: a declared variable, whose stored value it deletes. */
export const ClearCredentialRequest = z.object({ name: z.string().min(1, "Name a variable") });
export type ClearCredentialRequest = z.infer<typeof ClearCredentialRequest>;

/**
 * What `callFn` takes, as a site's `api` sends it: an operation's id (`data.outbound.list`), a
 * workflow's api name (`outboundNext`, which starts it) or one of its methods
 * (`outboundNext.start`, `.result`, `.latest`, `.runs`, `.approvals`, `.ledger`); the input; and,
 * for a call or a start, a new id per attempt, so a retried request is made once.
 */
export const CallRequest = z.object({
  name: z.string().min(1, "Name an operation or a workflow"),
  input: z.unknown().optional(),
  // Letters, digits, _ and -: never one of the runtime's own run ids (`call:<actor>:<id>`, `direct:…`).
  id: z
    .string()
    .regex(/^[\w-]{1,200}$/, "An id is letters, digits, _ and -")
    .optional(),
});
export type CallRequest = z.infer<typeof CallRequest>;

/** What `getHistory` reads: the history of the record `key` of the collection `name`. */
export const HistoryRequest = z.object({ name: z.string().min(1), key: z.string().min(1) });
export type HistoryRequest = z.infer<typeof HistoryRequest>;

/** What `proposeColumnChangeFn` takes: a change to the columns of the collection `collection`. */
export const ProposeColumnChange = z.object({ collection: z.string().min(1), change: ColumnChange });
export type ProposeColumnChange = z.infer<typeof ProposeColumnChange>;

/** A field one write changed: its value before and after, each absent where the field was not set. */
export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

/**
 * One write of a record, from the ledger (`getHistory`): when, as whom, in which run of which
 * workflow (`call` for a person's own, a `direct:` run having no page), and what it did: made
 * the record (`created`, its first save or the first after a delete), `deleted` it, or changed
 * these fields of the one before (none for a save of the same record).
 */
export interface HistoryEntry {
  at: number;
  by: string;
  workflow: string;
  runId: string;
  change: "created" | "deleted" | FieldChange[];
}

/**
 * A record's history (`getHistory`): its writes, newest first, and `more` when the ledger held
 * more calls on it than were read (its reads count), so older writes are not among them.
 */
export interface RecordHistory {
  writes: HistoryEntry[];
  more: boolean;
}

/** What `previewFn` asks (`PreviewRequest` without its principal): at most 200 actions, each on a target when known. */
export const PreviewQuery = z
  .array(
    z.object({
      action: z.object({ id: z.string().min(1), effect: z.enum(EFFECTS).optional() }),
      resource: z.string().min(1).optional(),
      inRun: z.boolean().optional(),
    }),
  )
  .max(200) satisfies z.ZodType<Omit<PreviewRequest, "principal">[]>;
export type PreviewQuery = z.infer<typeof PreviewQuery>;

export type { PermissionsRow } from "sanoma/workflows/describe";
export type { RunCheck } from "sanoma/workflows/scenario";

/**
 * The Permissions page's grid (`getPermissions`): the policy, then the grid (`permissionsGrid`:
 * its columns, a row for each workflow's start with a row for each operation it uses, and for
 * each operation a person may call directly, each with a cell per column), then the policy's
 * files, its source.
 */
export interface PermissionsResponse extends PermissionsGrid {
  policy: Omit<ConfigDescription["policy"], "files">;
  /**
   * Each `policies/**\/*.cedar` file by path, its text with `\n` line endings, and each policy in
   * it (a rule's `id`) with its `span` in that text; none when the root has no policies.
   */
  files: { file: string; text: string; policies: { id: string; span: Span }[] }[];
}

/**
 * What the repository's host enforces on `main` (`getHostEnforcement`), with the host's name (its
 * connector's title): whether it refuses a change that is not a pull request and requires the
 * `sanoma` check; null without a remote, or with no connector for its host.
 */
export type EnforcementResponse = (HostEnforcement & { host: string }) | null;

/** The `body` of the error a server function fails with. */
export interface ErrorResponse {
  error: string;
  /**
   * The runtime's code, when the error has one, `record_changed`: a collection's `save` with
   * `ifRecord` finding the record changed since, or gone (a `saveMany` any entry's, `ifAbsent`
   * too), or `record_exists`: a `save` with `ifAbsent` finding one. Branch on this, never on `error`.
   */
  code?: ErrorCode | "record_changed" | "record_exists";
  /** For `invalid_input`: what is wrong with the request or the input. */
  issues?: InputIssue[];
  /** For `not_approver`: who may decide. */
  approver?: ApprovalState["approver"];
  /** For `not_approver`: why not, `OWN_CHANGE` for the run's own actor while someone else could decide. */
  reason?: string;
  /** For `approval_pending`: the run of the built-in `call` workflow the call waits in; for `run_running`, the run. */
  runId?: string;
  /** For a form's Save refused (`invalid_input` from a `patch` run): the field its file computes, by dotted path, which only the code changes. */
  field?: string;
  /** For `record_changed` and `record_exists`, when the runtime says: the record as it stands now, or null once it is gone. */
  current?: Saved<Record<string, Json>> | null;
  /** For a `saveMany`'s `record_changed`: every record it found changed, or gone, as it stands now. */
  conflicts?: { key: string; current: Saved<Record<string, Json>> | null }[];
  /** For a `saveMany`'s `policy_denied`: the keys of every entry the policy denied, saves and deletes alike. */
  denied?: string[];
}

/** A JSON value, as a record's fields hold them. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * An error with the HTTP status and body a server function answers with. Every server function
 * fails with one, and the page receives it as one (start.ts registers how it travels).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse;

  constructor(status: number, body: ErrorResponse) {
    super(body.error);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The error body an error carries, when it is an `ApiError`. */
export const errorBodyOf = (err: unknown): ErrorResponse | undefined =>
  err instanceof ApiError ? err.body : undefined;

/** A run's short name, for a title: "Run" and its id's first 8 characters (a UUID's first group). */
export const runName = (runId: string) => `Run ${runId.slice(runId.lastIndexOf(":") + 1).slice(0, 8)}`;

/** Who started a run, as text. */
export const starterName = (run: Pick<RunSummary, "startedBy">): string => run.startedBy?.id ?? "unknown";

/** A run's approvals still waiting for a decision. */
export const pendingApprovals = (run: Pick<RunSummary, "approvals">): ApprovalState[] =>
  run.approvals.filter((a) => a.status === "pending");
