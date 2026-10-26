import type {
  ApplyPlan,
  ApplyResult,
  ApprovalState,
  CredentialStatus,
  ErrorCode,
  InputIssue,
  LedgerRecord,
  PreviewAnswer,
  PreviewRequest,
  Principal,
  RunSummary,
} from "@sanoma-ai/workflows";
import type { ConfigDescription, Span } from "@sanoma-ai/workflows/describe";
import type { Check, Scenario } from "@sanoma-ai/workflows/scenario";
import { EFFECTS, RUN_STATUSES } from "@sanoma-ai/workflows/shared";
import { z } from "zod";

/**
 * The shapes the app's server functions take and return. The page imports this file too, so
 * the server and the browser agree on them. Only types come from
 * `@sanoma-ai/workflows`, so the browser bundle never loads the runtime; values the page shares
 * with the runtime come from `@sanoma-ai/workflows/shared`.
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

/** What the open window is, from what this instance connects to; never a flag (`placeOf`). */
export type Place = "this-computer" | "live";

/**
 * What `getConfig` answers: the description, less the workflows' sources, and where this instance
 * is: its `place`, and its database's host (only the host, never the URL), which the bar's badge
 * says as its tip.
 */
export type AppConfig = ConfigDescription & { place: Place; databaseHost: string };

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
   * For a sandbox run, each of its scenario's expectations checked against the ledger. Absent
   * until the run has been seeded, and when `checksError` says why there are none.
   */
  checks?: RunCheck[];
  /**
   * Why a seeded sandbox run has no checks: its scenario is no longer in the feature files (with
   * those that did not load), or the scenarios could not be read at all.
   */
  checksError?: string;
}

/** One of a sandbox run's checks, and whether its answer is final. */
export interface RunCheck extends Check {
  /**
   * True once the answer cannot change: the run has ended, or the check expects a call that
   * has been made. Until then a check not met is not failed yet, and one met (a call not made
   * so far) may still fail.
   */
  settled: boolean;
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

/** What `setCredentialFn` takes: a declared variable and its value, stored as the actor. The value is never sent back. */
export const SetCredentialRequest = z.object({
  name: z.string().min(1, "Name a variable"),
  value: z.string().min(1, "Enter a value").max(16_384),
});
export type SetCredentialRequest = z.infer<typeof SetCredentialRequest>;

/** What the connect page shows (`getSetupStatus`): the GitHub App, once created, and the pasted tokens' statuses. Never a value. */
export interface SetupStatus {
  githubApp: { slug: string; setBy?: string; setAt?: string } | null;
  tokens: CredentialStatus[];
}

/** The data file going live writes, relative to the config's root. */
export const INFRA = "resources/sanoma/infra.ts";

/** What going live chooses (`goLiveFn`): who holds the repository, Supabase's organization and region, the host's port. */
export const GoLiveRequest = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "Choose a GitHub account or organization"),
  /** The repository's name, and the Supabase project's and the host's. */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Lower case letters, digits and hyphens, starting with a letter or digit"),
  organization: z.string().min(1, "Choose a Supabase organization"),
  region: z.string().min(1, "Choose a region"),
  port: z.number().int().min(1024, "A port from 1024").max(65535, "A port up to 65535"),
});
export type GoLiveRequest = z.infer<typeof GoLiveRequest>;

/**
 * Whose a connector is: Sanoma's own (the `@sanoma-ai/` scope) or the community's, any other
 * package. Sanoma's reviewed list, when it exists, will say more.
 */
export type Tier = "official" | "community";

export const tierOf = (pkg: string): Tier => (pkg.startsWith("@sanoma-ai/") ? "official" : "community");

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

/** What the Go live page offers to choose from (`getGoLiveChoices`), and why a list is empty. */
export interface GoLiveChoices {
  /** The GitHub accounts a repository can be made in: the token's user and organizations, and the App's installations. */
  owners: { login: string; kind: "user" | "organization"; via: "token" | "app" }[];
  /** The Supabase organizations the stored token sees. */
  organizations: { id: string; name: string }[];
  regions: readonly string[];
  /** The host type the company runs on, `<vendor>.<type>`, and its title; null when the config has none. */
  host: { type: string; title: string } | null;
  /** The resource types going live needs that the config's connectors do not declare. */
  missing: string[];
  /** A name to suggest: the app's. */
  name: string;
  /** What could not be listed, and why. */
  errors: string[];
}

/** An apply run as the Go live page follows it: its status, the plan it waits on, and what it did. */
export interface GoLiveRun {
  runId: string;
  status: RunSummary["status"];
  /** What it asks a person to approve, in the Inbox; the plan. */
  pending?: { approvalId: string; plan?: ApplyPlan };
  results?: ApplyResult[];
  error?: string;
}

/** How far going live is (`getGoLiveProgress`): told from the files, the lockfile and the runs, so a reload picks it up. */
export interface GoLiveProgress {
  /** `resources/sanoma/infra.ts`, once written. */
  infra: string | null;
  bound: { repo: boolean; store: boolean; host: boolean };
  /** The latest apply run. */
  run: GoLiveRun | null;
  /** Where the host answers, from the last apply that made or changed it, and whether `/healthz` answers. */
  host: { url: string; healthy: boolean } | null;
}
/**
 * What `connectExistingFn` takes: a GitHub repository (`owner/name`, or a name of the connector's
 * owner) and a Supabase project's ref, either or both.
 */
export const ConnectExistingRequest = z
  .object({
    repository: z
      .string()
      .trim()
      .regex(/^([\w-]+\/)?(?!\.\.?$)[\w.-]+$/, "Enter a repository as owner/name")
      .optional(),
    project: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+$/, "Enter a project's ref: lowercase letters and digits")
      .optional(),
  })
  .refine((r) => r.repository || r.project, { message: "Enter a repository, a project's ref, or both" });
export type ConnectExistingRequest = z.infer<typeof ConnectExistingRequest>;

/**
 * What `connectExistingFn` answers: the data file it wrote, relative to the root, and its text;
 * its commit, on `branch` (with its `diff`) when the repository has a remote and the change waits
 * for a person to merge it; and the apply run that binds what it declares.
 */
export interface ConnectExistingResponse {
  file: string;
  text: string;
  revision?: string;
  branch?: string;
  diff?: string;
  runId: string;
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
 * What `adoptFn` takes: a drift run, a resource it found drifted, and the fields whose value at
 * the vendor to write into the resource's data file.
 */
export const AdoptRequest = z.object({
  runId: z.string().min(1),
  id: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export type AdoptRequest = z.infer<typeof AdoptRequest>;

/** What `adoptFn` answers: the data file it wrote, relative to the root, and the commit, when the app has a source. */
export interface AdoptResponse {
  file: string;
  revision?: string;
}

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

/** A row of the Permissions grid: a workflow (its start) or an operation, and the policy's answer for each column. */
export interface PermissionsRow {
  id: string;
  title?: string;
  cells: PreviewAnswer[];
}

/**
 * The Permissions page's grid (`getPermissions`): the policy, its columns (`null` for someone in
 * no group, then the declared groups, `agents` and `visitors`, sorted, then `anonymous`), and a row for each workflow's start,
 * with a row for each operation it uses (`ops`, in its order), and for each operation a person
 * may call directly, each with a cell per column; then the policy's files, its source.
 */
export interface PermissionsResponse {
  policy: ConfigDescription["policy"];
  groups: (string | null)[];
  workflows: (PermissionsRow & { ops: PermissionsRow[] })[];
  ops: PermissionsRow[];
  /**
   * Each `policies/**\/*.cedar` file by path, its text with `\n` line endings, and each policy in
   * it (a rule's `id`) with its `span` in that text; none when the root has no policies.
   */
  files: { file: string; text: string; policies: { id: string; span: Span }[] }[];
}

/** The `body` of the error a server function fails with. */
export interface ErrorResponse {
  error: string;
  /** The runtime's code, when the error has one. Branch on this, never on `error`. */
  code?: ErrorCode;
  /** For `invalid_input`: what is wrong with the request or the input. */
  issues?: InputIssue[];
  /** For `not_approver`: who may decide. */
  approver?: ApprovalState["approver"];
  /** For `not_approver`: why not, `OWN_CHANGE` for the run's own actor while someone else could decide. */
  reason?: string;
  /** For `approval_pending`: the run of the built-in `call` workflow the call waits in; for `run_running`, the run. */
  runId?: string;
}

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
