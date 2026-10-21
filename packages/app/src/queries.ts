import type { RunStatus, RunSummary } from "@sanoma-ai/workflows";
import type { CollectionEntry, ConfigDescription, OpEntry, WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { apiNameOf, isEnded, LIST_LIMIT, type ListQuery, type Saved } from "@sanoma-ai/workflows/shared";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { linkOptions, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { z } from "zod";
import {
  type CredentialsResponse,
  pendingApprovals,
  RUNS_LIMIT,
  type RunsQuery,
  type ScenariosResponse,
  type StartRunRequest,
  type StartRunResponse,
} from "./api.ts";
import {
  getActor,
  getConfig,
  getCredentials,
  getDriftReport,
  getGoLiveChoices,
  getGoLiveProgress,
  getLastRuns,
  getRun,
  getRuns,
  getScenarios,
  getSetupStatus,
  getSource,
  startRunFn,
} from "./functions.ts";
import type { UntypedApi } from "./api-client.ts";
import { api } from "./site.ts";

/** How often the runs and a run's detail refresh while a page shows them. */
export const POLL_MS = 2_000;

/** The config cannot change while the app runs. The root route loads it for every page. */
export const configQuery = () =>
  queryOptions({ queryKey: ["config"], queryFn: () => getConfig(), staleTime: Number.POSITIVE_INFINITY });

/**
 * A file the config names, as it is when a page first shows it: a workflow's (its outline's
 * `file`) or a data file (a resource's `file`). Not in the config: a page that shows one asks.
 */
export const sourceQuery = (file: string) =>
  queryOptions({
    queryKey: ["source", file],
    queryFn: () => getSource({ data: { file } }),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** The file a workflow's outline was read from; none when it was read from `run`'s text, or not at all. */
export const workflowFile = (workflow: Pick<WorkflowEntry, "outline">): string | undefined =>
  "file" in workflow.outline ? workflow.outline.file : undefined;

/** The config's operations by id, for `select`: built once per config, not on every render. */
export const opsById = (config: ConfigDescription) => new Map(config.ops.map((op) => [op.id, op]));

/** One collation, so the server and the browser sort alike. */
const byTitle = (a: string, b: string) => a.localeCompare(b, "en");

/** A vendor a workflow calls, by id, and its title (its id when the config gives none). */
export type CalledVendor = { id: string; title: string };

/**
 * The outside vendors these operations are from, each once, sorted by title: those a connector
 * brings (`config.vendors`), never the built-in `sanoma` and `data`, which call nothing outside.
 */
const vendorsCalling = (config: ConfigDescription, ops: Map<string, OpEntry>, ids: readonly string[]): CalledVendor[] =>
  [...new Set(ids.flatMap((id) => ops.get(id)?.vendor ?? []))]
    .flatMap((id) => {
      const vendor = config.vendors[id];
      return vendor ? [{ id, title: vendor.title }] : [];
    })
    .toSorted((a, b) => byTitle(a.title, b.title));

/** The vendors the workflow's operations call, sorted by title: for `select`. None for a workflow the config does not have. */
export const vendorsOf = (name: string) => (config: ConfigDescription) =>
  vendorsCalling(config, opsById(config), workflowNamed(name)(config)?.ops ?? []);

/** `vendorsOf` for every workflow of the config, by name, in one pass: for `select`. */
export const vendorsByWorkflow = (config: ConfigDescription) => {
  const ops = opsById(config);
  return Object.fromEntries(config.workflows.map((wf) => [wf.name, vendorsCalling(config, ops, wf.ops)]));
};

/**
 * Each vendor, sorted by title, with its operations (in `ops`' order) and the workflows that may
 * call one of them: for `select`.
 */
export const connectorsOf = (config: ConfigDescription) =>
  Object.entries(config.vendors)
    .map(([id, vendor]) => {
      const ops = config.ops.filter((op) => op.vendor === id);
      const ids = new Set(ops.map((op) => op.id));
      const workflows = config.workflows
        .filter((wf) => wf.ops.some((op) => ids.has(op)))
        .map(({ name, title }) => ({ name, title }));
      const resourceTypes = config.resourceTypes.filter((type) => type.vendor === id);
      return { id, vendor, ops, workflows, resourceTypes };
    })
    .toSorted((a, b) => byTitle(a.vendor.title, b.vendor.title));

export type ConnectorEntry = ReturnType<typeof connectorsOf>[number];

/** The config's connector for this vendor id, if it has one: for `select`, or called with the config. */
export const connectorNamed = (id: string) => (config: ConfigDescription) =>
  connectorsOf(config).find((connector) => connector.id === id);

/** The config's workflow of this name, if it has one: for `select`, or called with the config. */
export const workflowNamed = (name: string) => (config: ConfigDescription) =>
  config.workflows.find((wf) => wf.name === name);

/** The config's collection of this name, if it has one: for `select`, or called with the config. */
export const collectionNamed = (name: string) => (config: ConfigDescription) =>
  config.collections.find((c) => c.name === name);

/**
 * What uses the collection: the workflows that name one of its operations in `uses`, sorted by
 * title, the built-in `call` (which may call every direct operation) left out. For `select`.
 */
export const usedBy = (collection: string) => (config: ConfigDescription) => {
  const ops = new Set(collectionNamed(collection)(config)?.ops);
  const workflows = config.workflows
    .filter((wf) => !wf.builtin && wf.ops.some((op) => ops.has(op)))
    .toSorted((a, b) => byTitle(a.title ?? a.name, b.title ?? b.name));
  return { workflows };
};

/** A collection's enum fields, each with its values, in the collection's order. */
export const enumFields = (fields: CollectionEntry["fields"]) =>
  Object.entries(fields).flatMap(([name, kind]) =>
    typeof kind === "object" && "enum" in kind ? [{ name, values: kind.enum as readonly string[] }] : [],
  );

/** Each workflow's title (its name when it has none), by name: for `select`. */
export const workflowTitles = (config: ConfigDescription) =>
  Object.fromEntries(config.workflows.map((wf) => [wf.name, wf.title ?? wf.name]));

/**
 * The config's workflow of this name, for a page under its own. The root route has loaded the
 * config. None for a retired workflow: one the config no longer has, whose runs remain.
 */
export const useWorkflow = (name: string) => useSuspenseQuery({ ...configQuery(), select: workflowNamed(name) }).data;

/**
 * The config's scenarios. Unlike the config they change while the app runs (the agent edits the
 * feature files), so they are read again every 5 seconds while the page is open and when its
 * window regains focus.
 */
export const scenariosQuery = () =>
  queryOptions({
    queryKey: ["scenarios"],
    queryFn: () => getScenarios(),
    refetchInterval: 5_000,
  });

/** The workflow's scenarios, and every feature file that could not be read: for `select`. */
export const scenariosFor =
  (workflow: string) =>
  ({ scenarios, errors }: ScenariosResponse) => ({
    scenarios: scenarios.filter((s) => s.workflow === workflow),
    errors,
  });

/** The scenarios with a step about the operation `op` (seeding it, failing it, expecting it, or forbidding it). */
export const scenariosNaming =
  (op: string) =>
  ({ scenarios }: ScenariosResponse) =>
    scenarios.filter((s) => s.steps.some((step) => step.op === op));

/**
 * Each vendor's credential statuses. They change while the app runs (someone sets one, here or
 * elsewhere), so a page reads them again once they are 5 seconds old.
 */
export const credentialsQuery = () =>
  queryOptions({ queryKey: ["credentials"], queryFn: () => getCredentials(), staleTime: 5_000 });

/** What is connected for going live (the connect page): under the credentials' key, so setting one refreshes both. */
export const setupStatusQuery = () =>
  queryOptions({ queryKey: ["credentials", "setup"], queryFn: () => getSetupStatus(), staleTime: 5_000 });

/** What going live can choose from: read once a minute at most, as each list asks GitHub or Supabase. */
export const goLiveChoicesQuery = () =>
  queryOptions({ queryKey: ["credentials", "go-live"], queryFn: () => getGoLiveChoices(), staleTime: 60_000 });

/** How far going live is: read every 2 s while a run goes on or the host is not answering yet. */
export const goLiveProgressQuery = () =>
  queryOptions({
    queryKey: [...RUNS_KEY, "go-live"],
    queryFn: () => getGoLiveProgress(),
    refetchInterval: (query) => {
      const progress = query.state.data;
      const running = progress?.run && !isEnded(progress.run.status);
      return running || (progress?.bound.host && !progress.host?.healthy) ? POLL_MS : false;
    },
  });

/** The vendor's credential statuses, if its drivers declare any: for `select`. */
export const credentialsFor = (vendor: string) => (all: CredentialsResponse) => all[vendor];

/**
 * Who the server says is asking. A login lasts the page's life; the header name is kept in the
 * browser. A resolver that failed is asked again every 10 s, so the nav recovers with it.
 */
export const actorQuery = () =>
  queryOptions({
    queryKey: ["actor"],
    queryFn: () => getActor(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (query) => (query.state.data?.error ? 10_000 : false),
  });

/** Every list of runs is under this key: invalidating it refreshes them all. */
export const RUNS_KEY = ["runs"] as const;

/**
 * How often a list of runs refreshes, for `refetchInterval`: every `fast` ms while one of them
 * can still change, else every 30 s. Starting a run or deciding refreshes it at once.
 */
export const runsRefetchInterval = (fast: number) => (query: { state: { data?: RunSummary[] | undefined } }) =>
  query.state.data?.some((run) => !isEnded(run.status)) ? fast : 30_000;

/** The latest runs, or the latest of a workflow or with a status (`RunsQuery`). */
export const runsQuery = (query: RunsQuery = {}) =>
  queryOptions({
    queryKey: [...RUNS_KEY, query],
    queryFn: () => getRuns({ data: query }),
    refetchInterval: POLL_MS,
  });

/**
 * The runs waiting on an approval: every one, up to `getRuns`'s largest page. Under RUNS_KEY, so
 * a decision refreshes it; fresh as long as its poll, so a peek opening does not read it again.
 */
export const waitingRunsQuery = () =>
  queryOptions({
    queryKey: [...RUNS_KEY, "waiting"],
    queryFn: () => getRuns({ data: { status: "waiting", limit: RUNS_LIMIT.max } }),
    refetchInterval: 5_000,
    staleTime: 5_000,
  });

/** The approvals still pending across the runs, each with its run, newest first: for `select`. */
export const pendingOf = (runs: RunSummary[]) =>
  runs
    .flatMap((run) => pendingApprovals(run).map((approval) => ({ run, approval })))
    .toSorted((a, b) => b.approval.requestedAt - a.approval.requestedAt);

/**
 * The latest runs, whatever their status, whose approvals the Inbox's Decided reads. Under
 * RUNS_KEY, so a decision refreshes it. Polled as `runsRefetchInterval` says (every 5 s while a
 * run can still change, else every 30 s), and fresh for 5 s, so a peek opening reads it at most
 * once in that time.
 */
export const recentRunsQuery = () =>
  queryOptions({
    ...runsQuery({ limit: RUNS_LIMIT.default }),
    refetchInterval: runsRefetchInterval(5_000),
    staleTime: 5_000,
  });

/**
 * Each workflow's latest run, by name (none for a workflow never run): the Workflows overview's
 * Last run and its panel's order. One read per workflow, so polled every 5 s only while a last
 * run is queued or running, else every 30 s: one waiting on a person changes when someone
 * decides, which refreshes it at once from this tab. Under RUNS_KEY, and fresh for 5 s.
 */
export const lastRunsQuery = () =>
  queryOptions({
    queryKey: [...RUNS_KEY, "last"],
    queryFn: () => getLastRuns(),
    refetchInterval: (query) =>
      Object.values(query.state.data ?? {}).some((run) => run.status === "queued" || run.status === "running")
        ? 5_000
        : 30_000,
    staleTime: 5_000,
  });

/** The approvals decided across the runs, each with its run, latest decision first: for `select`. */
export const decidedOf = (runs: RunSummary[]) =>
  runs
    .flatMap((run) => run.approvals.filter((a) => a.status !== "pending").map((approval) => ({ run, approval })))
    .toSorted(
      (a, b) => (b.approval.decidedAt ?? b.approval.requestedAt) - (a.approval.decidedAt ?? a.approval.requestedAt),
    );

/** What the Inbox lists (`?show=`): the pending approvals you may decide, all of them, or the decided. */
const INBOX_FILTERS = ["mine", "waiting", "decided"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/**
 * The Inbox's search: `?show=`, its filter, and `?approval=<runId>/<approvalId>`, the approval it
 * opens. Any other filter reads as none.
 */
export const InboxSearch = z.object({
  show: z.enum(INBOX_FILTERS).optional().catch(undefined),
  approval: z.string().min(1).optional().catch(undefined),
});

/** An approval's `?approval=`: its run's id and its own. */
export const approvalKey = ({ run, approval }: { run: Pick<RunSummary, "runId">; approval: { id: string } }) =>
  `${run.runId}/${approval.id}`;

/** What a workflow's panel may show (`?runs=`), the first (all) by default. */
export const RUN_FILTERS = ["all", "live", "sandbox", "waiting", "failed"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

/**
 * How each filter picks runs: a `status` the server is asked for, so an older failed run is not
 * lost behind the newest; or a `match` over the latest runs, for what the server cannot pick.
 */
const FILTERS: Record<RunFilter, { status?: RunStatus; match?: (run: RunSummary) => boolean }> = {
  all: {},
  live: { match: (run) => run.sandbox === undefined },
  sandbox: { match: (run) => run.sandbox !== undefined },
  waiting: { status: "waiting" },
  failed: { status: "failed" },
};

/**
 * A workflow page's search, on either pane: `?runs=`, its panel's filter (any other value reads as
 * all); `?new`, the New run panel in the inspector (the page's links write `?new=true`, and a bare
 * `?new` typed by hand opens it too); and `?scenario=`, Sandbox mode and the scenario it runs
 * (without it, Live), which also marks the workflow's graph.
 */
export const WorkflowSearch = z.object({
  runs: z.enum(RUN_FILTERS).optional().catch(undefined),
  new: z
    .union([z.literal(true), z.literal("").transform(() => true as const)])
    .optional()
    .catch(undefined),
  scenario: z.string().optional().catch(undefined),
});

/** How many runs a workflow's panel lists: the latest. */
export const WORKFLOW_RUNS_LIMIT = RUNS_LIMIT.default;

/** A workflow's panel's runs for a filter: the workflow's latest, with the filter's status. */
export const workflowRunsQuery = (name: string, filter: RunFilter = "all") =>
  queryOptions({
    ...runsQuery({ workflow: name, limit: WORKFLOW_RUNS_LIMIT, status: FILTERS[filter].status }),
    refetchInterval: runsRefetchInterval(POLL_MS),
  });

/** True when the filter picks from the latest runs (`match`), so older runs it would keep go unseen. */
export const picksFromLatest = (filter: RunFilter) => FILTERS[filter].match !== undefined;

/** Of the runs `workflowRunsQuery` read, those the filter keeps: all of them, unless it picks by `match`. */
export const workflowRuns = (filter: RunFilter, runs: RunSummary[]) => {
  const { match } = FILTERS[filter];
  return match ? runs.filter(match) : runs;
};

/**
 * The Workflows overview, all of it, for `<Link>`: lit there alone, not on All runs (`?view=runs`,
 * the same route) nor on a filter of it (`?filter=`, which the link would drop).
 */
export const OVERVIEW = linkOptions({ to: "/workflows", search: {}, activeOptions: { exact: true } });

/** A run's page, under its workflow's: for `<Link>`, `navigate` and `redirect`. */
export const runLink = (run: Pick<RunSummary, "runId" | "workflow">) =>
  linkOptions({ to: "/workflows/$name/runs/$id", params: { name: run.workflow, id: run.runId } });

/**
 * Starts a run (or a scenario's sandbox run), then says so, refreshes the lists of runs and,
 * unless `navigate` is false, opens the run's page. A live run starts as a site's does, through
 * `api.<workflow>.start` (`callFn`, a new id per attempt); a sandbox run through `startRunFn`. A
 * failure is the caller's to show: the start form puts it on its fields. The one place the
 * browser starts a run.
 */
export function useStartRun({ navigate = true }: { navigate?: boolean } = {}) {
  const start = useServerFn(startRunFn);
  const go = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: StartRunRequest): Promise<StartRunResponse> => {
      if ("scenario" in request) return start({ data: request });
      // Untyped: a company's `.sanoma/api.ts` types `api` for its sites, never for the app.
      const { runId } = (await (api as UntypedApi)[apiNameOf(request.workflow)].start(request.input)) as {
        runId: string;
      };
      return { runId, workflow: request.workflow };
    },
    onSuccess: async (started, request) => {
      toast.success(
        "scenario" in request ? `Started a sandbox run of “${request.scenario}”` : `Started ${started.workflow}`,
      );
      // The lists show the new run at once, not at their next poll.
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      if (navigate) await go(runLink(started));
    },
  });
}

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ["run", id],
    queryFn: () => getRun({ data: { id } }),
    // A finished run has nothing left to change.
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return !status || isEnded(status) ? false : POLL_MS;
    },
  });

/** Every collection's records are under this key, each collection's under its name after it. */
export const DATA_KEY = ["data"] as const;

/**
 * A collection's records, as `data.<name>.list` answers this query: called through `api` (the
 * site's path, `callFn`) as the person asking, whom the policy decides each read for.
 */
export const recordsQuery = (name: string, query: ListQuery<Record<string, unknown>>) =>
  queryOptions({
    queryKey: [...DATA_KEY, name, query],
    queryFn: () => (api as UntypedApi).data[name].list(query) as Promise<Saved[]>,
    // Read while the server rendered the page, not again as it hydrates; a save or a delete
    // refreshes them at once.
    staleTime: 5_000,
  });

/** The choices of the grid's limit, up to `list`'s most; it lists `LIST_LIMIT.default` at first. */
export const LIMIT_CHOICES = [25, LIST_LIMIT.default, 250, LIST_LIMIT.max] as const;

/**
 * The grid's search (`/data/<name>`): `?order=` (a field, or `-field` for descending), `?limit=`,
 * `?key=` (the keys that start with it), `?where=` (an enum field's value, by field), and the
 * record open in the form, `?record=<key>`, or `?new` for a new one. Anything else reads as none.
 */
export const DataSearch = z.object({
  order: z.string().min(1).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT.max).optional().catch(undefined),
  key: z.string().min(1).optional().catch(undefined),
  where: z.record(z.string(), z.string()).optional().catch(undefined),
  record: z.string().min(1).optional().catch(undefined),
  new: WorkflowSearch.shape.new,
});
export type DataSearch = z.infer<typeof DataSearch>;

/** The grid's search with no record open in the form: for a link's or `navigate`'s `search`. */
export const closeRecord = (prev: DataSearch): DataSearch => ({ ...prev, record: undefined, new: undefined });

/** The highest code point: after every string that starts with a prefix, under `list`'s byte order. */
const LAST = "\u{10FFFF}";

/**
 * What the grid asks `list` for, from its search: an order of a field the collection has, an
 * enum field equal to one of its values, the keys that start with `?key=` (a range, as `list`
 * compares text byte by byte), and the limit, 100 by default. What names nothing is left out.
 */
export function listQueryOf(
  { key, fields }: Pick<CollectionEntry, "key" | "fields">,
  search: Pick<DataSearch, "order" | "limit" | "key" | "where">,
): ListQuery<Record<string, unknown>> & { limit: number } {
  const where: Record<string, unknown> = {};
  for (const { name, values } of enumFields(fields)) {
    const value = search.where?.[name];
    if (value !== undefined && values.includes(value)) where[name] = value;
  }
  if (search.key) where[key] = { gte: search.key, lt: search.key + LAST };
  const order = search.order && Object.hasOwn(fields, search.order.replace(/^-/, "")) ? search.order : undefined;
  return {
    ...(Object.keys(where).length > 0 && { where }),
    ...(order && { order }),
    limit: search.limit ?? LIST_LIMIT.default,
  };
}

/** A finished drift run's report, which never changes. */
export const driftReportQuery = (runId: string) =>
  queryOptions({
    queryKey: ["drift-report", runId],
    queryFn: () => getDriftReport({ data: { runId } }),
    staleTime: Number.POSITIVE_INFINITY,
  });
