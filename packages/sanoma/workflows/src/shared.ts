import type { AuthenticationStoreProblem } from "./authentication.ts";
import type { RunSummary } from "./client.ts";
import type { CredentialStatus } from "./env.ts";
import type { ApprovalState, Approver, Principal } from "./define.ts";
import type { OpEntry, WorkflowEntry } from "./describe.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { Effect } from "./op.ts";
import type { PreviewRequest } from "./policy.ts";
import type { DeclaredResource, ResourceProblem } from "./description.ts";
import type { OutlineNode } from "./outline.ts";

// Types only: resource types as a UI reads them. Erased from the bundle.
export type {
  Declared,
  Declaring,
  FieldReference,
  References,
  Resource,
  ResourceFields,
  ResourceSpec,
} from "./resource.ts";
export type { At, DeclaredResource, ResourceProblem } from "./description.ts";
export type { DriftField, DriftReport, DriftResult, DriftStatus } from "./drift.ts";
export type { ApplyPlan, ApplyReport, ApplyResult, PlanAnswer, PlanStep } from "./apply.ts";
export type { CredentialStatus } from "./env.ts";
export type { ChangeDeploy, ChangeEvent, ChangeFacts, ChangeReport, ChangeState, ChangeVerified } from "./change.ts";
export type { AvailableApp, AvailableApps } from "./apps-list.ts";

// What a UI in the browser may use from the runtime, besides types: `sanoma/workflows/shared`.
// Nothing here imports DBOS, Node or zod, so a browser bundle can carry it; the runtime uses the
// same functions, so a page answers these questions the way a run does.

// Sanoma's claims, data (`sanoma/claims` re-exports them).
export * from "./claims.ts";
// A sheet read into a collection's records, as the built-in `import` and the app's pages read it.
export * from "./import.ts";
// A site's `site.ts` declares itself with it (`sanoma/site` calls it, typing its icon).
export { defineSite, type SiteDefinition } from "./definitions.ts";

/**
 * What a `ctx.sleep` without a `{ name }` is called, in its outline node and its ledger record
 * (`name`); a name given may not be it.
 */
export const DEFAULT_SLEEP_NAME = "Sleep";

/** The built-in drift workflow's name, which a config's own workflows may not take; a UI and the scenarios name its runs by it. */
export const DRIFT_WORKFLOW = "drift";

/**
 * The built-in apply workflow's name: the only workflow that may call a writable resource type's
 * change operations (`create`, `update`, `delete`).
 */
export const APPLY_WORKFLOW = "apply";

/**
 * The vendor of the collections' operations, `data.<collection>.<op>`: a collection's `get`,
 * `list`, `save` and `delete`. No connector may take it.
 */
export const DATA_VENDOR = "data";

/** The one operation of a collection that stands for others: `saveMany`, each entry a `save` or `delete`. */
export const BATCH = "saveMany";
export const isBatch = (op: Pick<OpEntry, "vendor" | "name">): boolean =>
  op.vendor === DATA_VENDOR && op.name === BATCH;
/** The ids of the operations a batch's entries are: its collection's `save` and `delete`. */
export const entryOpsOf = (op: Pick<OpEntry, "resource">): string[] =>
  ["save", "delete"].map((name) => `${DATA_VENDOR}.${op.resource}.${name}`);

/** Every effect an operation may have, each an action group (`effect:<effect>`) of the Cedar schema. */
export const EFFECTS = ["read", "write", "publish", "send", "money", "access"] as const satisfies readonly Effect[];

/** What a workflow start's action id starts with, as a policy names it: `workflow:<name>`. */
export const WORKFLOW_ACTION = "workflow:";

/**
 * What to ask the policy ahead of a run of `workflow` (`Policy.preview`, the principal aside): its
 * start, then each operation it may call, with its effect, in the run (`inRun`). The run form's
 * will-ask line asks it for the person; the Permissions grid (`permissionsGrid`) for each group.
 */
export function previewRequests(
  workflow: Pick<WorkflowEntry, "name" | "ops">,
  ops: ReadonlyMap<string, Pick<OpEntry, "effect" | "vendor" | "resource" | "name">>,
): Omit<PreviewRequest, "principal">[] {
  // A batch is asked as its entries, the save and the delete the policy decides: no rule names it.
  const asked = workflow.ops.flatMap((id) => {
    const op = ops.get(id);
    return op && isBatch(op) ? entryOpsOf(op) : [id];
  });
  return [
    { action: { id: `${WORKFLOW_ACTION}${workflow.name}` } },
    ...[...new Set(asked)].map((id) => {
      const effect = ops.get(id)?.effect;
      return { action: effect === undefined ? { id } : { id, effect }, inRun: true };
    }),
  ];
}

/** A site's folder name under `sites/`, its URL segment: what the app mounts and `readSites` reads. */
export const SITE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * An app's folder name under `apps/`: a lowercase letter, then lowercase letters and digits. It
 * prefixes the names of what the folder declares (`qualified`), and is a segment of `ctx.data`,
 * `api.data` and a site's path, so it is an identifier and a URL segment alike.
 */
export const APP_NAME = /^[a-z][a-z0-9]*$/;

/** Where a company's apps are, under its root: `apps/<app>/`. */
export const APPS_DIR = "apps";

/** The app a path relative to a company's root is in: `<app>` under `apps/<app>/`; undefined for any other. */
export function appOfPath(rel: string): string | undefined {
  const [top, app, ...rest] = rel.split("/");
  return top === APPS_DIR && app !== undefined && rest.length && APP_NAME.test(app) ? app : undefined;
}

/** A name declared under `apps/<app>/` as the runtime has it, `<app>.<name>`; one declared at the root as it is. */
export const qualified = (app: string | undefined, name: string): string =>
  app === undefined ? name : `${app}.${name}`;

/** A workflow's or collection's name as its file writes it, `qualified`'s undone: without its app. */
export const writtenName = ({ name, app }: { name: string; app?: string }): string =>
  app === undefined ? name : name.slice(app.length + 1);

/**
 * A site's key: its folder's name at the root, `<app>/<site>` in an app, so its pages are under
 * `/sites/<key>`. What `readSites` names a site by, and the app's build mounts it at.
 */
export const siteKey = (app: string | undefined, site: string): string => (app === undefined ? site : `${app}/${site}`);

/** A site's key (`siteKey`): a `SITE_NAME`, or an `APP_NAME`, `/` and a `SITE_NAME`, as a host's `domains` names a site. */
export const SITE_KEY = /^([a-z][a-z0-9]*\/)?[a-z][a-z0-9-]*$/;

/** A site's folder, relative to the root, by its key: `sites/<name>`, or an app's `apps/<app>/sites/<name>`. */
export function siteDir(key: string): string {
  const [app, site] = key.split("/");
  return site === undefined ? `sites/${key}` : `apps/${app}/sites/${site}`;
}

/**
 * A public site's language, as `defineSite({ locales })` names it: a BCP 47 language tag of a
 * language and subtags (`en`, `fr`, `pt-BR`), which is also its URL segment (`/pt-BR/…`) and a
 * content file's suffix (`<slug>.pt-BR.md`).
 */
export const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A public site's domain: a host name of two labels or more, lowercase (`sanoma.example`). */
export const DOMAIN_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The public sites' domains as a host hands them to the app in `SANOMA_DOMAINS` (`HostSpec`'s
 * `domains`): `<site>=<hostname>`, comma-separated, by site name.
 */
export const domainsText = (domains: Readonly<Record<string, string>>): string =>
  Object.keys(domains)
    .toSorted()
    .map((site) => `${site}=${domains[site]}`)
    .join(",");

/**
 * Where a hosted worker's port answers, with its instance token (`SANOMA_WAKEUP_TOKEN`) and
 * `?revision=<commit>`, the app bundle (`AppBundle` in `sanoma/app`) a host's Worker script runs
 * at that revision, built in a checkout of its own: the Cloudflare host asks for it at a deploy.
 */
export const APP_BUNDLE_PATH = "/__sanoma/app-bundle";
/** The header every answer of that route carries, so a host tells them from its own errors. */
export const APP_BUNDLE_HEADER = "x-sanoma-app-bundle";

/** Where a host with a `hostname` serves the app (`HostSpec`'s `hostname`): `https://<hostname>`. */
export const hostnameUrl = (hostname: string): string => `https://${hostname}`;

/** The site whose domain is also the app's `hostname`, compared in lower case; undefined when none is. */
export const siteAtHostname = (hostname: string, domains: Readonly<Record<string, unknown>>): string | undefined =>
  Object.entries(domains).find(([, domain]) => typeof domain === "string" && same(domain, hostname))?.[0];

/** The domains `domainsText` wrote, by site name; throws for a pair that is not `<site>=<hostname>`, or a site named twice. */
export function domainsOf(text: string): Record<string, string> {
  const domains: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const [site = "", domain = "", ...rest] = pair.trim().split("=");
    if (!SITE_KEY.test(site) || !DOMAIN_NAME.test(domain) || rest.length || Object.hasOwn(domains, site)) {
      throw new Error(
        `SANOMA_DOMAINS has "${pair}": write <site>=<hostname>, each site once, such as www=sanoma.example`,
      );
    }
    domains[site] = domain;
  }
  return domains;
}

/**
 * A record of a collection as `get`, `list` and `save` answer it: its key, the record, and when
 * and by whom it was last saved (`updatedBy`: a person's id, or `run:<id>` for a run). A record
 * saved under an older declaration comes back as it is stored, with `issues` saying where the
 * fields no longer accept it.
 */
export type Saved<R = Record<string, unknown>> = {
  key: string;
  record: R;
  /** ISO 8601. */
  updatedAt: string;
  updatedBy: string;
  issues?: { path: (string | number)[]; message: string }[];
};

/**
 * What a collection's `list` takes: fields equal to a value or within a range (`where`), the
 * field to sort by (`-field` for descending; by key otherwise), and how many at most (1 to
 * 1000, default 100).
 */
export type ListQuery<R> = {
  where?: { [F in keyof R]?: Exclude<R[F], undefined> | Range<Exclude<R[F], undefined>> };
  order?: (keyof R & string) | `-${keyof R & string}`;
  limit?: number;
};

type Range<V> = { gt?: V; gte?: V; lt?: V; lte?: V };

/** How many records a collection's `list` answers: `default` when the query names no `limit`, `max` at most. */
export const LIST_LIMIT = { default: 100, max: 1000 } as const;

/** How many entries (records and deletes together) a collection's `saveMany` takes at most. */
export const BATCH_LIMIT = 1000;

/** What a collection's `delete` answers, and `saveMany` for each of its deletes: whether there was a record. */
export type Deleted = { key: string; deleted: boolean };

/** The kinds of value a field holds: text, a number, true or false, a date (ISO 8601) or a person's id. */
export const FIELD_TYPES = ["text", "number", "boolean", "date", "person"] as const;

const COLLECTION_NAME = /^[a-z][a-zA-Z0-9]*$/;
/** A field's name, as `collection()` takes it: letters, digits and _, not a digit first. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = `${FIELD_TYPES.map((t) => `"${t}"`).join(", ")}, { type, optional: true } or { enum: [...] }`;
/** Whether `v` is a plain object: not null, not a list. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Throws unless `collection()` takes this declaration: the name a lowercase letter then letters
 * and digits, at least one field, each a type, the type marked optional or an enum of distinct
 * strings, the key a required text field, the title a string. `collection()` and the reader of
 * `resources/data.ts` both ask it, so `sanoma check` refuses what the runtime would.
 */
export function checkCollection(declaration: { name?: unknown; key?: unknown; fields?: unknown; title?: unknown }) {
  const { name, key, fields, title } = declaration;
  const where = `collection("${String(name)}")`;
  if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
    throw new Error(`${where}: the name must be a lowercase letter, then letters and digits, such as "outbound"`);
  }
  if (!isRecord(fields) || !Object.keys(fields).length) {
    throw new Error(`${where}: it needs fields, by name: each one of ${KINDS}`);
  }
  for (const [field, kind] of Object.entries(fields)) checkField(where, field, kind);
  const keyKind: unknown = typeof key === "string" && Object.hasOwn(fields, key) ? fields[key] : undefined;
  if (!(keyKind === "text" || (isRecord(keyKind) && keyKind.type === "text" && keyKind.optional === undefined))) {
    throw new Error(`${where}: the key "${String(key)}" must be one of its fields, a required "text" one`);
  }
  if (title !== undefined && typeof title !== "string") throw new Error(`${where}: the title must be a string`);
}

/** Throws unless `kind` is a field `collection()` takes: a type, the type marked optional, or an enum of distinct strings. */
function checkField(where: string, field: string, kind: unknown): void {
  const refused = (why: string) => new Error(`${where}: the field "${field}" ${why}`);
  if (!FIELD_NAME.test(field)) throw refused("must be named with letters, digits and _, not a digit first");
  const types: readonly unknown[] = FIELD_TYPES;
  const kinds = `is ${JSON.stringify(kind)}; a field is one of ${KINDS}`;
  if (typeof kind === "string") {
    if (!types.includes(kind)) throw refused(kinds);
    return;
  }
  if (!isRecord(kind)) throw refused(kinds);
  const { type, enum: values, optional, ...rest } = kind;
  if (Object.keys(rest).length || (type === undefined) === (values === undefined)) throw refused(kinds);
  if (optional !== undefined && optional !== true) throw refused("may only be marked `optional: true`");
  if (type !== undefined && !types.includes(type)) throw refused(kinds);
  if (
    values !== undefined &&
    (!Array.isArray(values) ||
      !values.length ||
      values.some((v) => typeof v !== "string") ||
      new Set(values).size < values.length)
  ) {
    throw refused("needs an enum of distinct strings, at least one");
  }
}

/**
 * The built-in call workflow's name: one operation that may be called directly (`isDirect`),
 * made a run when the policy holds a direct call for an approval.
 */
export const CALL_WORKFLOW = "call";

/**
 * The built-in change workflow's name: the life of a change to the company's repository, from its
 * pull request to its merge. The only workflow that may call `sanoma.change.*`.
 */
export const CHANGE_WORKFLOW = "change";

/** What a draft's id may be (`ChangeInput.id`), the part of its branch and its change's run ids after `draft/` and `change:`. */
export const DRAFT_ID = /^[\w-]{1,64}$/;

/** The draft a run id of `prefix` is of: `<prefix>:<id>` (its first run) or `<prefix>:<id>~<n>` (a later one); undefined for any other. */
export const draftRunOf = (prefix: string) => {
  const run = new RegExp(`^${prefix}:(${DRAFT_ID.source.slice(1, -1)})(?:~\\d+)?$`);
  return (runId: string): string | undefined => run.exec(runId)?.[1];
};

/** The draft a change's run is of: `change:<id>` or `change:<id>~<n>`; undefined for any other run id. */
export const changeIdOf = draftRunOf("change");

/**
 * A draft saved (`app-workflows.ts`), started by `SanomaClient.saveDraft`: without a remote,
 * merged into `main` and run at once; with one, its change opened, which the policy decides.
 */
export const SAVE_DRAFT_WORKFLOW = "save-draft";

/** A commit's full id, as git names it (SHA-1, or SHA-256). */
export const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The draft the undoing of the saved commit `sha` is made in: `undo-<its first 12 characters>`. */
export const undoDraftOf = (sha: string) => `undo-${sha.slice(0, 12)}`;

/** Opens a change: its draft's branch pushed and a pull request opened for it. */
export const CHANGE_OPEN = "sanoma.change.open";
/** Reports Sanoma's review of a change to its host (the `sanoma` commit status). */
export const CHANGE_REVIEW = "sanoma.change.review";
/** Merges a change; its resource is the `Sanoma::Change`, whose attributes are its facts (`ChangeFacts`). */
export const CHANGE_MERGE = "sanoma.change.merge";
/** Closes a change without merging it. */
export const CHANGE_CLOSE = "sanoma.change.close";
/** The DBOS event a change run publishes its `ChangeState` on. */
export const CHANGE_EVENT = "change";
/**
 * The `recv` topic a change run is told what happened to its change on (a `ChangeEvent`): never an
 * approval's, whose topic is its id (`approval-<n>`).
 */
export const CHANGE_TOPIC = "change:event";

/** Lists the apps on GitHub with Sanoma's claims: the one runtime operation a page may call (`isDirect`). */
export const APPS_LIST = "sanoma.apps.list";

/**
 * The built-in workflow that sends a staff or visitor sign-in code through the config's
 * `login.sender`, started by the runtime's agent `login` (`LOGIN_AGENT`): its input's code is
 * sealed, and the mail's body is recorded as `<text>` and `<html>`.
 */
export const LOGIN_CODE_WORKFLOW = "login-code";

/**
 * The app's own actions on the company's repository, each a built-in workflow the app starts and
 * the worker runs with the app's steps (`WorkerOptions.app`, `app-workflows.ts`): Adopt (a drifted
 * field's value at the vendor into its data file), a form's Save, going live (`infra.ts` written,
 * then the push and the host's apply) and connecting an existing repository or database.
 */
export const ADOPT_WORKFLOW = "adopt";
export const PATCH_WORKFLOW = "patch";
export const GO_LIVE_WORKFLOW = "go-live";
export const GO_LIVE_HOST_WORKFLOW = "go-live-host";
export const CONNECT_EXISTING_WORKFLOW = "connect-existing";

/**
 * What a git host's webhook says happened to the company's repository, done by the worker
 * (`follow-workflow.ts`): started by the app as `host-check`, one run per event (`SanomaClient.follow`).
 */
export const FOLLOW_WORKFLOW = "follow";

/**
 * An OAuth connection's exchange, run by the worker (`connect-workflow.ts`): started by the app's
 * callback as the person who consented (`SanomaClient.receiveConnection`), one run per attempt,
 * `connect:<attempt>`, given the attempt's opaque id and never its code.
 */
export const CONNECT_WORKFLOW = "connect";

/**
 * A move of the company's secrets from the selected store to another in `secrets.stores`, run by
 * the worker (`store-move-workflow.ts`): plan, prepare, transfer, verify, cutover and retire, one
 * run per move, its id the move's. Registered when a config names other stores.
 */
export const MIGRATE_STORE_WORKFLOW = "migrate-store";

/** A move's phases while it is under way: one at a time, its source paused for writes, cancellable. */
export const ACTIVE_MOVE_PHASES = ["prepared", "transferring", "verified"] as const;

/** A move's operations a person may call outside its run (`isDirect`): its plan, and cancelling it before its cutover. */
export const STORE_MOVE_DIRECT: ReadonlySet<string> = new Set([
  "sanoma.storeMigration.plan",
  "sanoma.storeMigration.cancel",
]);

/** Where a vendor sends the person back after consent: the app's route, `/connect/<vendor>/callback`. */
export const connectionCallbackPath = (vendor: string) => `/connect/${encodeURIComponent(vendor)}/callback`;

/**
 * A turn of a person's chat with the operator agent, run by the worker with the app's steps
 * (`chat-workflow.ts`): started by the app as the chat's person (`SanomaClient.startTurn`), one run
 * per message, `chat:<chat>:<message>`.
 */
export const CHAT_WORKFLOW = "chat";

/** What the run id of each of the chat `chat`'s turns starts with: exact, as a chat's id has no `:` (`DRAFT_ID`). */
export const chatRunPrefix = (chat: string) => `chat:${chat}:`;

/** The run id of the chat `chat`'s turn for the message `message`. */
export const chatRunId = (chat: string, message: string) => `${chatRunPrefix(chat)}${message}`;

/** The feature files that did not load (`loadScenarios`' errors), as a scenario not found names them after its name. */
export const notLoaded = (errors: readonly { message: string }[]) =>
  errors.length ? `; these files did not load: ${errors.map((e) => e.message).join("; ")}` : "";

/**
 * A sheet's rows into a collection, as a run of the person who started it (`import-workflow.ts`):
 * the app's Import pages start it, when the config has a collection.
 */
export const IMPORT_WORKFLOW = "import";

/** The `recv` topic a turn's run is told on (`ChatTell`): a stop, a sign-in code, its own turn's end. */
export const CHAT_TOPIC = "chat:tell";

/** The workflows the runtime adds itself, which a config's own may not be named: drift, apply, call, change, login-code, follow, chat, import, connect, migrate-store and the app's actions. */
export const BUILT_IN_WORKFLOWS: ReadonlySet<string> = new Set([
  DRIFT_WORKFLOW,
  APPLY_WORKFLOW,
  CALL_WORKFLOW,
  CHANGE_WORKFLOW,
  LOGIN_CODE_WORKFLOW,
  FOLLOW_WORKFLOW,
  CHAT_WORKFLOW,
  IMPORT_WORKFLOW,
  CONNECT_WORKFLOW,
  MIGRATE_STORE_WORKFLOW,
  ADOPT_WORKFLOW,
  PATCH_WORKFLOW,
  GO_LIVE_WORKFLOW,
  GO_LIVE_HOST_WORKFLOW,
  CONNECT_EXISTING_WORKFLOW,
  SAVE_DRAFT_WORKFLOW,
]);

/**
 * Every run status, in the order a run may pass through them: waiting on the queue, running,
 * waiting for an approval, or ended. `waiting` is `running` with an approval pending.
 */
export const RUN_STATUSES = ["queued", "running", "waiting", "finished", "failed", "cancelled"] as const;

/** Where a run is: one of `RUN_STATUSES`, so a new status reaches every list and map of them. */
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The statuses of a run that has ended: it reads no more decisions. */
export const ENDED_STATUSES = ["finished", "failed", "cancelled"] as const satisfies readonly RunStatus[];

/** True when the run has finished, failed or been cancelled. */
export const isEnded = (status: RunStatus): boolean => (ENDED_STATUSES as readonly RunStatus[]).includes(status);

/**
 * Why the run's own actor may not decide an approval on it: separation of duties (`mayDecide`),
 * while someone else could decide it.
 */
export const OWN_CHANGE = "own change";

/** A run as `mayDecide` reads it: who started it, its own actor. */
type DecidedRun = { actor?: Pick<Principal, "id"> | undefined };

/**
 * True when `by` may decide the approval on `run`: `by.id` is the approver, or `by.groups` holds
 * the approver group. The run's own actor is refused only while someone else could decide (separation
 * of duties): the approver is a group with another declared person in `people` (an agent does not
 * count). Pure: everything it reads is passed in.
 */
export const mayDecide = (
  approval: Pick<ApprovalState, "approver">,
  by: Principal,
  run: DecidedRun,
  people: readonly PeopleResource[],
): boolean => refusalOf(approval, by, run, people) === undefined;

/** Why `by` may not decide the approval on `run` (`mayDecide`), naming who may, or `OWN_CHANGE`; undefined when they may. */
export function refusalOf(
  { approver }: Pick<ApprovalState, "approver">,
  by: Principal,
  run: DecidedRun,
  people: readonly PeopleResource[],
): string | undefined {
  if (isVisitor(by)) return "a visitor decides no approval";
  if (typeof approver === "string") {
    return approver === by.id ? undefined : `${by.id} is not the approver; ${approverLabel(approver)} is`;
  }
  if (!by.groups?.includes(approver.group)) return `${by.id} is not in ${approverLabel(approver)}`;
  if (by.id !== run.actor?.id) return undefined;
  const someoneElse = personsOf(people).some(
    ({ id }) => id !== by.id && principalOf(id, people)?.groups?.includes(approver.group),
  );
  return someoneElse ? OWN_CHANGE : undefined;
}

/** A declared resource as the people functions read it: only the runtime's people types count. */
export type PeopleResource = Pick<DeclaredResource, "vendor" | "type" | "desired">;

/** The group the runtime holds a change to the rules for, and the one that hands out invite links. */
export const ADMIN = "admin";

/** The group every agent is in, the runtime's own among them: no data file declares it. */
export const AGENTS = "agents";

/** The group every visitor of a public site is in: no data file declares it. */
export const VISITORS = "visitors";

/** The principal a public page runs as when nobody is signed in: no groups. */
export const ANONYMOUS = "anonymous";

/** `visitor:<login connector's vendor>:<provider subject>`: the form a signed-in visitor's id takes. */
const VISITOR_ID = /^visitor:[^\s:]+:\S+$/;

/** `token:<id>`: a caller of a public site's api with a token (`SanomaClient.tokens`), a visitor too. */
const TOKEN_ID = /^token:\S+$/;

/**
 * True for `anonymous`, a visitor's id and a token's (`token:<id>`): a principal no data file
 * declares and the staff logins never admit. Marked by the id alone, since a principal crosses to
 * the worker as JSON.
 */
export const isVisitor = (p: Pick<Principal, "id">): boolean =>
  p.id === ANONYMOUS || VISITOR_ID.test(p.id) || isToken(p);

/** True for an api token's principal (`token:<id>`), whose groups are its row's. */
export const isToken = (p: Pick<Principal, "id">): boolean => TOKEN_ID.test(p.id);

/**
 * The visitor a public site's login vouches for: `subject` from the provider behind the `login`
 * connector, in `visitors`. Throws for a login or subject that would make an id `isVisitor` does not tell.
 */
export function visitorPrincipal(login: string, subject: string): Principal {
  const id = `visitor:${login}:${subject}`;
  if (!VISITOR_ID.test(id)) throw new Error(`"${id}" is not a visitor's id: visitor:<login connector>:<subject>`);
  return { id, groups: [VISITORS] };
}

/** Who a public page runs as when nobody is signed in. */
export const ANONYMOUS_PRINCIPAL: Principal = Object.freeze({ id: ANONYMOUS, groups: [] });

/** The runtime's agent that registers the instance's wakeup (`register`'s `CallContext.by`). */
export const WAKEUP_AGENT = "wakeup";
/** The runtime's agent a scheduled run is started by (`trigger: { schedule }`): the policy decides its starts. */
export const SCHEDULE_AGENT = "schedule";
/** The runtime's agent that checks and deploys the hosts: drift's, and a host's webhook's (`SanomaClient.follow`), whose apply after a push to `main` is its too. */
export const HOST_CHECK_AGENT = "host-check";
/** The runtime's agent that sends a sign-in code (`LOGIN_CODE_WORKFLOW`): a company's policy exempts it from its holds on sending. */
export const LOGIN_AGENT = "login";
/** The runtime's agent that renews OAuth grants when they are due (`sanoma.connection.refresh`, called by the worker): the policy decides each. */
export const RENEWAL_AGENT = "renewal";
/** The runtime's own agents (scenarios, the host check, scheduled runs, the wakeup's registration, sign-in codes, grant renewals), declared whether a data file names them or not. */
export const RUNTIME_AGENTS: readonly string[] = [
  "scenarios",
  HOST_CHECK_AGENT,
  SCHEDULE_AGENT,
  WAKEUP_AGENT,
  LOGIN_AGENT,
  RENEWAL_AGENT,
];

/** The declared resources of one of the runtime's people types, by `desired`. */
const peopleOfType = <T>(resources: readonly PeopleResource[], type: "person" | "agent" | "group") =>
  resources.flatMap((r) => (r.vendor === "sanoma" && r.type === type ? [r.desired as T] : []));

type PersonFields = { id: string; name?: string; email?: string; github?: string };
type AgentFields = { id: string; onBehalfOf?: string };
type GroupFields = { name: string; members: string[] };

/** The groups a policy may name and a principal may be in: the declared ones, `agents` and `visitors`, sorted. */
export const groupNamesOf = (resources: readonly PeopleResource[]): string[] =>
  [...new Set([...peopleOfType<GroupFields>(resources, "group").map((g) => g.name), AGENTS, VISITORS])].toSorted();

/** The declared people (`sanoma.person`), in the order declared: not agents, who never sign in. */
export const personsOf = (resources: readonly PeopleResource[]): PersonFields[] =>
  peopleOfType<PersonFields>(resources, "person");

/** The ids of the declared people and agents (not the runtime's own). */
export const principalIdsOf = (resources: readonly PeopleResource[]): string[] =>
  [...personsOf(resources), ...peopleOfType<AgentFields>(resources, "agent")].map((p) => p.id);

/** True when the data files declare a person, agent or group: then only a declared principal is admitted. */
export const declaresPeople = (resources: readonly PeopleResource[]): boolean =>
  resources.some((r) => r.vendor === "sanoma");

/**
 * The principal a declared person or agent (or one of the runtime's own agents) acts as, read
 * from the data files' resources: its id, every group that lists it (and `agents` for an agent),
 * sorted, and an agent's `onBehalfOf`. Undefined for an id nobody declares.
 */
export function principalOf(id: string, resources: readonly PeopleResource[]): Principal | undefined {
  const agent = peopleOfType<AgentFields>(resources, "agent").find((a) => a.id === id);
  const isAgent = agent !== undefined || RUNTIME_AGENTS.includes(id);
  if (!isAgent && !peopleOfType<PersonFields>(resources, "person").some((p) => p.id === id)) return undefined;
  const groups = peopleOfType<GroupFields>(resources, "group")
    .filter((g) => g.members.includes(id))
    .map((g) => g.name);
  return {
    id,
    groups: [...new Set(isAgent ? [...groups, AGENTS] : groups)].toSorted(),
    ...(agent?.onBehalfOf !== undefined && { onBehalfOf: agent.onBehalfOf }),
  };
}

/**
 * Who `name` is as an approver: a declared group's name (or `agents`) as `{ group }`, else a
 * declared person's or agent's id; undefined when it is neither, and for `visitors`, who decide nothing.
 */
export function approverOf(name: string, resources: readonly PeopleResource[]): Approver | undefined {
  if (name === VISITORS) return undefined;
  if (groupNamesOf(resources).includes(name)) return { group: name };
  return principalOf(name, resources) && name;
}

/** True for two strings the same but for case: an email, a GitHub login or a hostname. */
const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * The id of the declared person a sign-in vouches for, or undefined: by email first, then by
 * GitHub login (each ignoring case), then by id. Never an agent's: agents do not sign in.
 */
export function personOf(
  login: { email?: string; github?: string; id?: string },
  resources: readonly PeopleResource[],
): string | undefined {
  const people = personsOf(resources);
  return (
    people.find((p) => same(p.email, login.email)) ??
    people.find((p) => same(p.github, login.github)) ??
    people.find((p) => login.id !== undefined && p.id === login.id)
  )?.id;
}

/** Who may decide, as text: the person's id, or "group <name>". */
export const approverLabel = (approver: Approver): string =>
  typeof approver === "string" ? approver : `group ${approver.group}`;

/** An error's message, or the value as text when it is not an Error. */
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A mistake in how the bin was called or in what it found: its message is printed alone, and the exit code is 2. */
export class UsageError extends Error {}

/** The entries of `sanoma` a browser bundle may load: plain values and React, no server, runtime or credentials. */
export const CLIENT_ENTRIES: ReadonlySet<string> = new Set([
  "sanoma/site",
  "sanoma/ui",
  "sanoma/ui.css",
  "sanoma/claims",
  "sanoma/workflows/shared",
  "sanoma/workflows/description",
]);

/** The specifiers of `sanoma`'s `exports` (its `package.json`'s) that are server code: every one but `CLIENT_ENTRIES`. */
export const serverEntries = (exports: object): string[] =>
  Object.keys(exports)
    .map((key) => `sanoma${key.slice(1)}`)
    .filter((name) => !CLIENT_ENTRIES.has(name));

/** True when an outline's op id, a computed segment shown as `*`, could be this op: `a.*.c` fits `a.b.c`. */
export function fitsOp(pattern: string, op: string): boolean {
  const want = pattern.split(".");
  const got = op.split(".");
  return want.length === got.length && want.every((segment, i) => segment === "*" || segment === got[i]);
}

/** A node's child lists, in order: the lists a `path`'s segments index into. */
export const childLists = (node: OutlineNode): OutlineNode[][] => {
  switch (node.kind) {
    case "all":
      return node.branches;
    case "branch":
      return node.cases;
    case "each":
    case "repeat":
      return [node.body];
    case "try":
      return [node.body, node.handler];
    default:
      return [];
  }
};

/** Every node of an outline, nested ones included, in order. */
export function flatten(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flatten(childLists(node).flat())]);
}

/**
 * Where a problem is, `file:line:column`, `file#export` or `file`; undefined for one that is the
 * config's, with no file.
 */
export const problemAt = (p: ResourceProblem): string | undefined => {
  if (p.file === undefined) return undefined;
  if (p.line !== undefined) return `${p.file}:${p.line}:${p.column ?? 1}`;
  return p.export === undefined ? p.file : `${p.file}#${p.export}`;
};

/**
 * A problem as one line: `file:line:column: message`, `file#export: message` or `file: message`
 * without a position, or the message alone without a file.
 */
export function problemLine(p: ResourceProblem): string {
  const at = problemAt(p);
  return at === undefined ? p.message : `${at}: ${p.message}`;
}

/**
 * Where the export `name` (`default` for the default export) is in a file's text, as UTF-16
 * offsets: from its `export` to the next `export`, `import`, `const` or comment at the start of a
 * line, or the end, less trailing blank space. Read from the text alone, for highlighting it; undefined
 * when no line starts it.
 */
export function exportSpan(text: string, name: string): [number, number] | undefined {
  const declared = name === "default" ? "default" : `const\\s+${name.replaceAll("$", "\\$")}`;
  const start = new RegExp(`^export\\s+${declared}(?![\\w$])`, "m").exec(text);
  if (!start) return undefined;
  const after = start.index + start[0].length;
  // A comment at the start of a line is the next declaration's.
  const next = /^(?:(?:export|import|const)\b|\/[/*])/m.exec(text.slice(after));
  const end = next ? after + next.index : text.length;
  return [start.index, start.index + text.slice(start.index, end).trimEnd().length];
}

/** A warning as one line, as `problemLine` with `warning: ` before its message: what is worth fixing but not wrong. */
export const warningLine = (p: Parameters<typeof problemLine>[0]): string =>
  problemLine({ ...p, message: `warning: ${p.message}` });

/**
 * Whether a host is this machine: `localhost`, `127.x.x.x` or `::1` (bare, or bracketed as a URL's
 * `hostname` has it). The one rule for what the app listens on and answers to, and for where the
 * bin may start Postgres.
 */
export const isLoopback = (host: string) =>
  ["localhost", "::1", "[::1]"].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Whether a driver's environment variable lets it run: set, or unset and optional. */
export const credentialReady = ({ status, optional }: CredentialStatus): boolean =>
  status === "set" || (status === "missing" && optional);

/**
 * A workflow's name in a site's `api`: kebab-case made camelCase, `outbound-next` as
 * `api.outboundNext`, and an app's workflow one name with its app, `crm.follow-up` as
 * `api.crmFollowUp`. `describeConfig` reports two workflows that come out the same, or one that
 * comes out as a vendor's id or `data`, as a problem on the workflow.
 */
export const apiNameOf = (name: string): string => name.replace(/[-.]([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * A workflow as a site's `api` has it (`api.<apiNameOf(name)>`), started as the person on the
 * page. Called, it starts a run and resolves with its output once the run ends, or rejects with
 * its error; `start` gives the run's id at once, and the rest read runs of this workflow.
 */
export interface WorkflowFn<I, O> {
  (input: I): Promise<O>;
  /** Starts a run with this input, and answers with its id. */
  start(input: I): Promise<{ runId: string }>;
  /** The run's output once it ends, or its error; `run_running` when it has not ended within `waitMs` (at most 20 s). */
  result(runId: string, waitMs?: number): Promise<O>;
  /** The newest finished run's output, and when it finished (ms since the epoch); null when none has. */
  latest(): Promise<{ runId: string; output: O; at: number } | null>;
  /** Its latest runs, newest first. */
  runs(query?: { limit?: number }): Promise<RunSummary[]>;
  /** The run's approvals, decided and waiting. */
  approvals(runId: string): Promise<ApprovalState[]>;
  /** The run's ledger records, in order. */
  ledger(runId: string): Promise<LedgerRecord[]>;
}

/** An operation a site may call directly (a read, or a collection's write), as the person on the page. */
export type OpFn<I, O> = (input: I) => Promise<O>;

/** A collection as a site's `api.data.<name>` has it: its six operations (`Saved`, `ListQuery`, `Deleted`). */
export interface CollectionApi<R> {
  get: OpFn<{ key: string }, Saved<R> | null>;
  list(query?: ListQuery<R>): Promise<Saved<R>[]>;
  /** How many records there are, or match `where` (as `list` takes it). */
  count(query?: Pick<ListQuery<R>, "where">): Promise<{ count: number }>;
  save: OpFn<{ record: R; ifAbsent?: boolean; ifRecord?: Record<string, unknown> }, Saved<R>>;
  /**
   * Saves and deletes together, all or none, at most `BATCH_LIMIT` entries, each key once: the
   * records' receipts then the deletes' answers, in the order sent. The policy decides each entry
   * as its own `save` or `delete`; a deny refuses the batch (`policy_denied`, with the `denied`
   * keys), a hold holds it whole, and a record an entry's `ifRecord` or `ifAbsent` refuses refuses
   * it (status 409, `record_changed`) with every such entry in `conflicts: { key, current }[]`.
   */
  saveMany: OpFn<
    {
      records?: { record: R; ifAbsent?: boolean; ifRecord?: Record<string, unknown> }[];
      deletes?: { key: string; ifRecord?: Record<string, unknown> }[];
    },
    (Saved<R> | Deleted)[]
  >;
  /** Deletes the record, or with `ifRecord` only while it still matches (status 409, `record_changed`, otherwise). */
  delete: OpFn<{ key: string; ifRecord?: Record<string, unknown> }, Deleted>;
}

/**
 * What each `ConnectionCard.storageProblem` (`authenticationStoreProblem`) means, for the
 * connector page and `sanoma check` alike.
 */
export const STORAGE_PROBLEMS: Readonly<Record<AuthenticationStoreProblem, string>> = {
  read_only: "writes its credentials (a refresh replaces them), and they are bound read-only",
  unsupported: "replaces its credentials with a conditional write, which this store does not offer",
  too_large: "may keep credentials larger than this store holds",
};

/** What to do instead, for each `STORAGE_PROBLEMS` entry: on the connector page and in `sanoma check`. */
export const STORAGE_ADVICE: Readonly<Record<AuthenticationStoreProblem, string>> = {
  read_only: "bind them to a path Sanoma manages in a writable store, such as the built-in one",
  unsupported: "choose the built-in store or another that offers conditional writes",
  too_large: "choose a store with a larger limit",
};
