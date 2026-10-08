import { isEnded } from "@sanoma/workflows/shared";
import { queryOptions } from "@tanstack/react-query";
import { RUNS_LIMIT } from "./api.ts";
import { getActor, getConfig, getRun, getRuns } from "./functions.ts";

/** How often the runs and a run's detail refresh while a page shows them. */
export const POLL_MS = 2_000;

/** The config cannot change while the app runs. */
export const configQuery = () =>
  queryOptions({ queryKey: ["config"], queryFn: () => getConfig(), staleTime: Number.POSITIVE_INFINITY });

/** Who the server says is asking. A login lasts the page's life; the header name is kept in the browser. */
export const actorQuery = () =>
  queryOptions({ queryKey: ["actor"], queryFn: () => getActor(), staleTime: Number.POSITIVE_INFINITY });

export const runsQuery = (limit: number = RUNS_LIMIT.default) =>
  queryOptions({
    queryKey: ["runs", limit],
    queryFn: () => getRuns({ data: { limit } }),
    refetchInterval: POLL_MS,
  });

/** The runs waiting on an approval: every one, up to the API's largest page. Under "runs", so a decision refreshes it. */
export const waitingRunsQuery = () =>
  queryOptions({
    queryKey: ["runs", "waiting"],
    queryFn: () => getRuns({ data: { status: "waiting", limit: RUNS_LIMIT.max } }),
    refetchInterval: 5_000,
  });

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
