import type { RunSummary } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { memo } from "react";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../api.ts";
import { RAIL_LIMIT, railQuery, railRuns, RUN_FILTERS, type RunFilter, runLink } from "../queries.ts";
import { Nothing, SandboxBadge, StatusDot, When } from "./common.tsx";

// The rail on a workflow's page: its panes, and its latest runs, each linking to its own pane.

const FILTER_LABEL: Record<RunFilter, string> = {
  all: "All",
  live: "Live",
  sandbox: "Sandbox",
  waiting: "Waiting",
  failed: "Failed",
};

/** A link in the rail; `aria-current` marks the pane that shows. */
const RAIL_LINK = "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted";
/** A pane's link (About, New run): its name in bold while it shows. */
const PANE_LINK = `${RAIL_LINK} aria-[current=page]:font-medium`;
/** A rail link's props while its pane shows. */
const RAIL_ACTIVE = { "aria-current": "page" } as const;

/**
 * The workflow's panes (About, New run) and its runs, newest first, filtered by `?runs=`. It
 * reads the runs itself, so a poll draws the rail again and not the pane beside it.
 */
export function RunRail({ name }: { name: string }) {
  // Only `?runs=`: another search param (About's `?scenario=`) does not draw the rail again.
  const filter = useSearch({ from: "/workflows/$name", select: (search) => search.runs }) ?? "all";
  const navigate = useNavigate();
  const { data: runs, error } = useSuspenseQuery(railQuery(name, filter));
  const shown = railRuns(filter, runs);
  // The rail's links keep the filter; All leaves the URL without `?runs=`.
  const search = { runs: filter === "all" ? undefined : filter };
  return (
    <aside
      aria-label="Runs of this workflow"
      className="flex flex-[1_1_16rem] flex-col gap-3 rounded-lg border bg-card p-2 text-card-foreground"
    >
      <nav className="flex flex-col">
        <Link
          to="/workflows/$name"
          params={{ name }}
          search={search}
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={RAIL_ACTIVE}
          className={PANE_LINK}
        >
          About
        </Link>
        <Link
          to="/workflows/$name/new"
          params={{ name }}
          search={search}
          activeOptions={{ includeSearch: false }}
          activeProps={RAIL_ACTIVE}
          className={PANE_LINK}
        >
          New run
        </Link>
      </nav>
      <div className="flex items-center justify-between gap-2 px-2">
        <span className="text-xs font-medium text-muted-foreground">Runs</span>
        <NativeSelect
          size="sm"
          aria-label="Show runs"
          value={filter}
          // Another filter replaces the page in the history rather than adding one; All leaves
          // the URL without `?runs=`.
          onChange={(e) => {
            const chosen = e.target.value as RunFilter;
            void navigate({
              to: ".",
              search: (prev) => ({ ...prev, runs: chosen === "all" ? undefined : chosen }),
              replace: true,
            });
          }}
        >
          {RUN_FILTERS.map((f) => (
            <NativeSelectOption key={f} value={f}>
              {FILTER_LABEL[f]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {error && <p className="px-2 text-xs text-destructive">Could not refresh: {error.message}</p>}
      {shown.length === 0 ? (
        <Nothing title={filter === "all" ? "No runs yet" : "No runs match"} />
      ) : (
        <ul className="flex max-h-[70vh] flex-col overflow-y-auto">
          {shown.map((run) => (
            <li key={run.runId}>
              <RunLink run={run} search={search} />
            </li>
          ))}
        </ul>
      )}
      {runs.length === RAIL_LIMIT && (
        <p className="px-2 text-xs text-muted-foreground">Showing the latest {RAIL_LIMIT}</p>
      )}
    </aside>
  );
}

/**
 * A run in the rail: its status (and what it waits on), its sandbox, who started it and when.
 * Memoised: a poll keeps an unchanged run's object, so only the runs that changed draw again.
 */
const RunLink = memo(function RunLink({ run, search }: { run: RunSummary; search: { runs: RunFilter | undefined } }) {
  const waitingOn = run.status === "waiting" ? pendingApprovals(run)[0]?.title : undefined;
  return (
    <Link
      {...runLink(run)}
      search={search}
      activeOptions={{ includeSearch: false }}
      activeProps={RAIL_ACTIVE}
      className={RAIL_LINK}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={RUN_TONE[run.status]} />
        <span className="shrink-0">{run.status}</span>
        {waitingOn !== undefined && <span className="truncate text-muted-foreground">{waitingOn}</span>}
        {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {starterName(run)} · <When at={run.createdAt} />
      </span>
    </Link>
  );
});
