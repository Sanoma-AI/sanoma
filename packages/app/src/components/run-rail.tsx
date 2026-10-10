import type { RunSummary } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../api.ts";
import { runsQuery } from "../queries.ts";
import { Nothing, SandboxBadge, StatusDot, When } from "./common.tsx";

// The rail on a workflow's page: its panes, and its latest runs, each linking to its own pane.

/** How many runs the rail lists: the latest. */
const RAIL_LIMIT = 50;

/** The rail's runs: the workflow's latest, polled while its page shows. The layout loads it first. */
export const railQuery = (name: string) => runsQuery({ workflow: name, limit: RAIL_LIMIT });

/** What `?runs=` may show, the first (all) by default. */
export const RUN_FILTERS = ["all", "live", "sandbox", "waiting", "failed"] as const;
type RunFilter = (typeof RUN_FILTERS)[number];

const FILTER_LABEL: Record<RunFilter, string> = {
  all: "All",
  live: "Live",
  sandbox: "Sandbox",
  waiting: "Waiting",
  failed: "Failed",
};

const MATCHES: Record<RunFilter, (run: RunSummary) => boolean> = {
  all: () => true,
  live: (run) => run.sandbox === undefined,
  sandbox: (run) => run.sandbox !== undefined,
  waiting: (run) => run.status === "waiting",
  failed: (run) => run.status === "failed",
};

/** A link in the rail; `aria-current` marks the pane that shows. */
const RAIL_LINK = "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted";

/**
 * The workflow's panes (About, New run) and its runs, newest first, filtered by `?runs=`. It
 * reads the runs itself, so a poll draws the rail again and not the pane beside it.
 */
export function RunRail({ name }: { name: string }) {
  const { runs: filter = "all" } = useSearch({ from: "/workflows/$name" });
  const navigate = useNavigate();
  const { data: runs, error } = useSuspenseQuery(railQuery(name));
  const shown = runs.filter(MATCHES[filter]);
  return (
    <aside
      aria-label="Runs of this workflow"
      className="flex flex-[1_1_16rem] flex-col gap-3 rounded-lg border bg-card p-2 text-card-foreground"
    >
      <nav className="flex flex-col">
        <Link
          to="/workflows/$name"
          params={{ name }}
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ "aria-current": "page", className: "font-medium" }}
          className={RAIL_LINK}
        >
          About
        </Link>
        <Link
          to="/workflows/$name/new"
          params={{ name }}
          activeOptions={{ includeSearch: false }}
          activeProps={{ "aria-current": "page", className: "font-medium" }}
          className={RAIL_LINK}
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
        <Nothing title={runs.length === 0 ? "No runs yet" : "No runs match"} />
      ) : (
        <ul className="flex max-h-[70vh] flex-col overflow-y-auto">
          {shown.map((run) => (
            <li key={run.runId}>
              <RunLink name={name} run={run} />
            </li>
          ))}
        </ul>
      )}
      {runs.length === RAIL_LIMIT && <p className="px-2 text-xs text-muted-foreground">Showing the latest 50</p>}
    </aside>
  );
}

/** A run in the rail: its status (and what it waits on), its sandbox, who started it and when. */
function RunLink({ name, run }: { name: string; run: RunSummary }) {
  const waitingOn = run.status === "waiting" ? pendingApprovals(run)[0]?.title : undefined;
  return (
    <Link
      to="/workflows/$name/runs/$id"
      params={{ name, id: run.runId }}
      activeOptions={{ includeSearch: false }}
      activeProps={{ "aria-current": "page" }}
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
}
