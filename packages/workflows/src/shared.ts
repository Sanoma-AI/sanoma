import type { RunSummary } from "./client.ts";
import type { CredentialStatus } from "./env.ts";
import type { ApprovalState, Approver, Principal } from "./define.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { Effect } from "./op.ts";
import type { DeclaredResource, ResourceProblem } from "./resources.ts";
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
export type { DeclaredResource, ResourceProblem } from "./resources.ts";
export type { DriftField, DriftReport, DriftResult, DriftStatus } from "./drift.ts";
export type { ApplyPlan, ApplyReport, ApplyResult, PlanAnswer, PlanStep } from "./apply.ts";
export type { CredentialStatus } from "./env.ts";

// What a UI in the browser may use from the runtime, besides types: `@sanoma-ai/workflows/shared`.
// Nothing here imports DBOS, Node or zod, so a browser bundle can carry it; the runtime uses the
// same functions, so a page answers these questions the way a run does.

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

/** Every effect an operation may have, each an action group (`effect:<effect>`) of the Cedar schema. */
export const EFFECTS = ["read", "write", "publish", "send", "money", "access"] as const satisfies readonly Effect[];

/** What a workflow start's action id starts with, as a policy names it: `workflow:<name>`. */
export const WORKFLOW_ACTION = "workflow:";

/** A site's folder name under `sites/`, its URL segment: what the app mounts and `readSites` reads. */
export const SITE_NAME = /^[a-z][a-z0-9-]*$/;

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

/** The kinds of value a field holds: text, a number, true or false, a date (ISO 8601) or a person's id. */
export const FIELD_TYPES = ["text", "number", "boolean", "date", "person"] as const;

const COLLECTION_NAME = /^[a-z][a-zA-Z0-9]*$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = `${FIELD_TYPES.map((t) => `"${t}"`).join(", ")}, { type, optional: true } or { enum: [...] }`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

/** The workflows the runtime adds itself, which a config's own may not be named: drift, apply and call. */
export const BUILT_IN_WORKFLOWS: ReadonlySet<string> = new Set([DRIFT_WORKFLOW, APPLY_WORKFLOW, CALL_WORKFLOW]);

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

/** The group every agent is in, the runtime's own among them: no data file declares it. */
export const AGENTS = "agents";

/** The runtime's own agents (scenarios, the host check, scheduled runs), declared whether a data file names them or not. */
export const RUNTIME_AGENTS: readonly string[] = ["scenarios", "host-check", "schedule"];

/** The declared resources of one of the runtime's people types, by `desired`. */
const peopleOfType = <T>(resources: readonly PeopleResource[], type: "person" | "agent" | "group") =>
  resources.flatMap((r) => (r.vendor === "sanoma" && r.type === type ? [r.desired as T] : []));

type PersonFields = { id: string; name?: string; email?: string; github?: string };
type AgentFields = { id: string; onBehalfOf?: string };
type GroupFields = { name: string; members: string[] };

/** The groups a policy may name and a principal may be in: the declared ones and `agents`, sorted. */
export const groupNamesOf = (resources: readonly PeopleResource[]): string[] =>
  [...new Set([...peopleOfType<GroupFields>(resources, "group").map((g) => g.name), AGENTS])].toSorted();

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
 * declared person's or agent's id; undefined when it is neither.
 */
export function approverOf(name: string, resources: readonly PeopleResource[]): Approver | undefined {
  if (groupNamesOf(resources).includes(name)) return { group: name };
  return principalOf(name, resources) && name;
}

/** True for two strings the same but for case: an email or a GitHub login. */
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

/** Where a data-file problem is, `file:line:column`; undefined for one that is the config's, with no file. */
export const problemAt = (p: ResourceProblem): string | undefined =>
  p.file === undefined ? undefined : `${p.file}:${p.line}:${p.column}`;

/**
 * A problem as one line: `file:line:column: message`, or `file: message` without a position, or
 * the message alone without a file.
 */
export function problemLine(p: { file?: string; line?: number; column?: number; message: string }): string {
  if (p.file === undefined) return p.message;
  return p.line === undefined ? `${p.file}: ${p.message}` : `${p.file}:${p.line}:${p.column ?? 1}: ${p.message}`;
}

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
 * `api.outboundNext`. `describeConfig` reports two workflows that come out the same, or one that
 * comes out as a vendor's id or `data`, as a problem on the workflow.
 */
export const apiNameOf = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

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

/** A collection as a site's `api.data.<name>` has it: its four operations (`Saved`, `ListQuery`). */
export interface CollectionApi<R> {
  get: OpFn<{ key: string }, Saved<R> | null>;
  list(query?: ListQuery<R>): Promise<Saved<R>[]>;
  save: OpFn<{ record: R }, Saved<R>>;
  delete: OpFn<{ key: string }, { deleted: boolean }>;
}
