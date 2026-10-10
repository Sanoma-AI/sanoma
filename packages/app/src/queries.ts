import type { RunSummary } from "@sanoma/workflows";
import type { ConfigDescription, WorkflowEntry } from "@sanoma/workflows/describe";
import { isEnded } from "@sanoma/workflows/shared";
import { queryOptions } from "@tanstack/react-query";
import { pendingApprovals, RUNS_LIMIT, type RunsQuery, type ScenariosResponse } from "./api.ts";
import { getActor, getConfig, getDriftReport, getRun, getRuns, getScenarios, getSource } from "./functions.ts";

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
    // One collation, so the server and the browser sort alike.
    .toSorted((a, b) => a.vendor.title.localeCompare(b.vendor.title, "en"));

export type ConnectorEntry = ReturnType<typeof connectorsOf>[number];

/** The config's connector for this vendor id, if it has one: for `select`, or called with the config. */
export const connectorNamed = (id: string) => (config: ConfigDescription) =>
  connectorsOf(config).find((connector) => connector.id === id);

/** The config's workflow of this name, if it has one: for `select`, or called with the config. */
export const workflowNamed = (name: string) => (config: ConfigDescription) =>
  config.workflows.find((wf) => wf.name === name);

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
