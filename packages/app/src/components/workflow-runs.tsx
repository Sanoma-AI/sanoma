import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import {
  picksFromLatest,
  RUN_FILTERS,
  type RunFilter,
  WORKFLOW_RUNS_LIMIT,
  workflowRuns,
  workflowRunsQuery,
} from "../queries.ts";

// A workflow's runs, as the old sidebar's panel listed them beside its page: the filter
// (`?runs=`), the runs it keeps, and what to say when it keeps none. Not mounted yet: the
// workflow page's Runs view is to list them.

/** Each filter's name. */
export const RUN_FILTER_LABEL: Record<RunFilter, string> = {
  all: "All",
  live: "Live",
  sandbox: "Sandbox",
  waiting: "Waiting",
  failed: "Failed",
};

/** The search a run's link keeps: the filter, dropping the rest (`?new`, `?scenario=`); All leaves the URL without `?runs=`. */
export const runsSearch = (filter: RunFilter) => ({ runs: filter === "all" ? undefined : filter });

/**
 * A workflow's latest runs for a filter (`?runs=`, which its page validates and its loader reads),
 * newest first: `runs` as read, `shown` those the filter keeps, `fromLatest` when it picks from
 * the latest (live and sandbox), so what it shows is only of those, `capped` when the read hit
 * its limit, and `empty`, what to say when it keeps none. A failed refresh is the page's to say
 * (`RunsError`).
 */
export function useWorkflowRuns(name: string, filter: RunFilter) {
  const { data: runs } = useSuspenseQuery(workflowRunsQuery(name, filter));
  const fromLatest = picksFromLatest(filter);
  return {
    runs,
    shown: workflowRuns(filter, runs),
    fromLatest,
    capped: runs.length === WORKFLOW_RUNS_LIMIT,
    empty:
      filter === "all"
        ? "No runs yet"
        : fromLatest
          ? `No ${filter} runs among the latest ${WORKFLOW_RUNS_LIMIT}`
          : "No runs match",
  };
}

/** The filter as a select: another filter replaces the page in the history rather than adding one. */
export function RunsFilterSelect({ filter }: { filter: RunFilter }) {
  const navigate = useNavigate();
  return (
    <NativeSelect
      size="sm"
      aria-label="Show runs"
      value={filter}
      onChange={(e) => {
        const chosen = e.target.value as RunFilter;
        void navigate({ to: ".", search: (prev) => ({ ...prev, ...runsSearch(chosen) }), replace: true });
      }}
    >
      {RUN_FILTERS.map((f) => (
        <NativeSelectOption key={f} value={f}>
          {RUN_FILTER_LABEL[f]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
