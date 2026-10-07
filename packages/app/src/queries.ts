import { queryOptions } from "@tanstack/react-query";
import { getConfig, getRun, getRuns } from "./functions.ts";

/** How often the runs and a run's detail refresh while a page shows them. */
export const POLL_MS = 2_000;

/** The config cannot change while the app runs. */
export const configQuery = () =>
  queryOptions({ queryKey: ["config"], queryFn: () => getConfig(), staleTime: Number.POSITIVE_INFINITY });

export const runsQuery = (limit = 50) =>
  queryOptions({
    queryKey: ["runs", limit],
    queryFn: () => getRuns({ data: { limit } }),
    refetchInterval: POLL_MS,
  });

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ["run", id],
    queryFn: () => getRun({ data: { id } }),
    // A missing run is not polled, and a finished one has nothing left to change.
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return !run || run.status === "finished" || run.status === "failed" || run.status === "cancelled"
        ? false
        : POLL_MS;
    },
  });
