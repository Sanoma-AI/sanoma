import type { RunSummary } from "@sanoma/workflows";
import type { ConfigDescription } from "@sanoma/workflows/describe";
import { isEnded } from "@sanoma/workflows/shared";
import { queryOptions } from "@tanstack/react-query";
import { pendingApprovals, RUNS_LIMIT } from "./api.ts";
import { getActor, getConfig, getRun, getRuns, getSource } from "./functions.ts";

/** How often the runs and a run's detail refresh while a page shows them. */
export const POLL_MS = 2_000;

/** The config cannot change while the app runs. The root route loads it for every page. */
export const configQuery = () =>
  queryOptions({ queryKey: ["config"], queryFn: () => getConfig(), staleTime: Number.POSITIVE_INFINITY });

/** A workflow's source, which cannot change while the app runs either. Not in the config: a page that shows it asks. */
export const sourceQuery = (name: string) =>
  queryOptions({
    queryKey: ["source", name],
    queryFn: () => getSource({ data: { name } }),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** The config's operations by id, for `select`: built once per config, not on every render. */
export const opsById = (config: ConfigDescription) => new Map(config.ops.map((op) => [op.id, op]));

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

export const runsQuery = (limit: number = RUNS_LIMIT.default) =>
  queryOptions({
    queryKey: [...RUNS_KEY, limit],
    queryFn: () => getRuns({ data: { limit } }),
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
