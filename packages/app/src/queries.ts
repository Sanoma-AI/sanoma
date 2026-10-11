import type { RunStatus, RunSummary } from "@sanoma/workflows";
import type { ConfigDescription, OpEntry, WorkflowEntry } from "@sanoma/workflows/describe";
import { isEnded } from "@sanoma/workflows/shared";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { linkOptions, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { z } from "zod";
import { pendingApprovals, RUNS_LIMIT, type RunsQuery, type ScenariosResponse, type StartRunRequest } from "./api.ts";
import {
  getActor,
  getConfig,
  getDriftReport,
  getRun,
  getRuns,
  getScenarios,
  getSource,
  startRunFn,
} from "./functions.ts";

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

/** The vendors these operations are from, each once, sorted by title. */
const vendorsCalling = (config: ConfigDescription, ops: Map<string, OpEntry>, ids: readonly string[]): CalledVendor[] =>
  [...new Set(ids.flatMap((id) => ops.get(id)?.vendor ?? []))]
    .map((id) => ({ id, title: config.vendors[id]?.title ?? id }))
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

/** The runs waiting on an approval: every one, up to the API's largest page. Under RUNS_KEY, so a decision refreshes it. */
export const waitingRunsQuery = () =>
  queryOptions({
    queryKey: [...RUNS_KEY, "waiting"],
    queryFn: () => getRuns({ data: { status: "waiting", limit: RUNS_LIMIT.max } }),
    refetchInterval: 5_000,
  });

/** The approvals still pending across the runs, each with its run, newest first: for `select`. */
export const pendingOf = (runs: RunSummary[]) =>
  runs
    .flatMap((run) => pendingApprovals(run).map((approval) => ({ run, approval })))
    .toSorted((a, b) => b.approval.requestedAt - a.approval.requestedAt);

/**
 * How many approvals are pending, as `pendingOf` lists them: in all, and by workflow. For
 * `select`: a plain object, so a poll that changed nothing keeps it.
 */
export const pendingByWorkflow = (runs: RunSummary[]) => {
  let total = 0;
  const byWorkflow: Record<string, number> = Object.create(null);
  for (const run of runs) {
    const count = pendingApprovals(run).length;
    if (count === 0) continue;
    total += count;
    byWorkflow[run.workflow] = (byWorkflow[run.workflow] ?? 0) + count;
  }
  return { total, byWorkflow };
};

/** What a workflow page's rail may show (`?runs=`), the first (all) by default. */
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

/** A workflow page's search: `?runs=`, the rail's filter. Any other value reads as all. */
export const WorkflowSearch = z.object({ runs: z.enum(RUN_FILTERS).optional().catch(undefined) });

/** How many runs the rail lists: the latest. */
export const RAIL_LIMIT = RUNS_LIMIT.default;

/** The rail's runs for a filter: the workflow's latest, with the filter's status. */
export const railQuery = (name: string, filter: RunFilter = "all") =>
  queryOptions({
    ...runsQuery({ workflow: name, limit: RAIL_LIMIT, status: FILTERS[filter].status }),
    refetchInterval: runsRefetchInterval(POLL_MS),
  });

/** True when the filter picks from the latest runs (`match`), so older runs it would keep go unseen. */
export const picksFromLatest = (filter: RunFilter) => FILTERS[filter].match !== undefined;

/** Of the runs `railQuery` read, those the filter keeps: all of them, unless it picks by `match`. */
export const railRuns = (filter: RunFilter, runs: RunSummary[]) => {
  const { match } = FILTERS[filter];
  return match ? runs.filter(match) : runs;
};

/** A run's page, under its workflow's: for `<Link>`, `navigate` and `redirect`. */
export const runLink = (run: Pick<RunSummary, "runId" | "workflow">) =>
  linkOptions({ to: "/workflows/$name/runs/$id", params: { name: run.workflow, id: run.runId } });

/**
 * Starts a run (or a scenario's sandbox run), then says so, refreshes the lists of runs and opens
 * the run's page. A failure is the caller's to show: the start form puts it on its fields.
 */
export function useStartRun() {
  const start = useServerFn(startRunFn);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: StartRunRequest) => start({ data: request }),
    onSuccess: async (started, request) => {
      toast.success(
        "scenario" in request ? `Started a sandbox run of “${request.scenario}”` : `Started ${started.workflow}`,
      );
      // The lists show the new run at once, not at their next poll.
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      await navigate(runLink(started));
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

/** A finished drift run's report, which never changes. */
export const driftReportQuery = (runId: string) =>
  queryOptions({
    queryKey: ["drift-report", runId],
    queryFn: () => getDriftReport({ data: { runId } }),
    staleTime: Number.POSITIVE_INFINITY,
  });
