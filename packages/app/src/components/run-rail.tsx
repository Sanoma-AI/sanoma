import type { RunSummary } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLoaderData, useNavigate, useSearch } from "@tanstack/react-router";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, WorkflowIcon } from "lucide-react";
import { memo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../api.ts";
import { picksFromLatest, RAIL_LIMIT, railQuery, railRuns, RUN_FILTERS, type RunFilter, runLink } from "../queries.ts";
import { Nothing, SandboxBadge, StatusDot, Tip, When } from "./common.tsx";

// The rail on a workflow's page: the workflow's own pane, and its latest runs, each linking to its own pane.

/** The cookie the rail's fold is kept in: `collapsed` or `open` (and, never set, open). */
export const RAIL_COOKIE = "sanoma_rail";

/** A year, in seconds. */
const RAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const FILTER_LABEL: Record<RunFilter, string> = {
  all: "All",
  live: "Live",
  sandbox: "Sandbox",
  waiting: "Waiting",
  failed: "Failed",
};

/** A link in the rail; `aria-current`, which Link sets on an active link, marks the pane that shows. */
const RAIL_LINK =
  "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted compact:flex-row compact:items-center compact:gap-2 compact:py-1";

/** The rail's links keep the filter and drop the rest (`?new`, `?scenario=`); All leaves the URL without `?runs=`. */
const railSearch = (filter: RunFilter) => ({ runs: filter === "all" ? undefined : filter });

/**
 * The workflow's own pane and its runs, newest first, filtered by `?runs=`, ending in a link to
 * all of the workflow's runs on the Workflows page. It reads the runs itself, so a poll draws the
 * rail again and not the pane beside it. It folds to a narrow column of status dots, and stays as
 * it was left: the root's loader reads its cookie, on the server as in the browser (as it does the
 * density's), and the rail takes it once, as it mounts, so both render the same.
 */
export function RunRail({ name }: { name: string }) {
  const defaultCollapsed = useLoaderData({ from: "__root__", select: (data) => data.railCollapsed });
  const [collapsed, setState] = useState(defaultCollapsed);
  const setCollapsed = (value: boolean) => {
    setState(value);
    document.cookie = `${RAIL_COOKIE}=${value ? "collapsed" : "open"}; path=/; max-age=${RAIL_COOKIE_MAX_AGE}`;
  };
  // Only `?runs=`.
  const filter = useSearch({ from: "/workflows/$name", select: (search) => search.runs }) ?? "all";
  const navigate = useNavigate();
  const { data: runs, error } = useSuspenseQuery(railQuery(name, filter));
  const shown = railRuns(filter, runs);
  const search = railSearch(filter);
  // Live and sandbox are picked from the latest runs: what they show is only of those.
  const fromLatest = picksFromLatest(filter);
  // One name in both states; `aria-expanded` says which, and the tooltip what a click does.
  const toggle = (
    <Tip tip={collapsed ? "Unfold the rail" : "Fold the rail"}>
      <Button variant="ghost" size="icon-sm" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
        <span className="sr-only">Runs rail</span>
      </Button>
    </Tip>
  );
  // Active with any `?scenario=` or `?runs=`, not on a run's pane. It leaves `?scenario=` behind:
  // reading it would draw the rail again on each scenario chosen.
  const workflowLink = {
    to: "/workflows/$name",
    params: { name },
    search,
    activeOptions: { exact: true, includeSearch: false },
  } as const;
  const allRuns = { to: "/workflows", search: { view: "runs", workflow: name } } as const;

  if (collapsed) {
    return (
      <aside
        aria-label="Runs of this workflow"
        data-collapsed=""
        className="flex flex-none flex-col items-center gap-2 rounded-lg border bg-card p-1.5 text-card-foreground"
      >
        {toggle}
        <Tip tip="Workflow">
          <Link {...workflowLink} className={`${RAIL_ICON} aria-[current=page]:text-foreground`}>
            <WorkflowIcon className="size-4" />
            <span className="sr-only">Workflow</span>
          </Link>
        </Tip>
        {shown.length > 0 && (
          <ul aria-label="Runs" className="flex max-h-[70vh] flex-col items-center overflow-y-auto">
            {shown.map((run) => (
              <li key={run.runId}>
                <RunDot run={run} filter={filter} />
              </li>
            ))}
          </ul>
        )}
      </aside>
    );
  }
  return (
    <aside
      aria-label="Runs of this workflow"
      className="flex flex-[1_1_16rem] flex-col gap-3 rounded-lg border bg-card p-2 text-card-foreground"
    >
      <nav className="flex items-center gap-1">
        <Link {...workflowLink} className={`${RAIL_LINK} flex-1 aria-[current=page]:font-medium`}>
          Workflow
        </Link>
        {toggle}
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
        <Nothing
          title={
            filter === "all"
              ? "No runs yet"
              : fromLatest
                ? `No ${filter} runs among the latest ${RAIL_LIMIT}`
                : "No runs match"
          }
        />
      ) : (
        <ul className="flex max-h-[70vh] flex-col overflow-y-auto">
          {shown.map((run) => (
            <li key={run.runId}>
              <RunLink run={run} filter={filter} />
            </li>
          ))}
        </ul>
      )}
      {runs.length === RAIL_LIMIT && (
        <p className="px-2 text-xs text-muted-foreground">
          {fromLatest ? "From" : "Showing"} the latest {RAIL_LIMIT}
        </p>
      )}
      <Link {...allRuns} className="px-2 text-xs text-muted-foreground hover:text-foreground hover:underline">
        All runs of this workflow →
      </Link>
    </aside>
  );
}

/** An icon link in the folded rail. */
const RAIL_ICON =
  "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted aria-[current=page]:bg-muted";

/** A run in the folded rail: its status's dot, with what the open rail says of it as its tooltip. */
const RunDot = memo(function RunDot({ run, filter }: { run: RunSummary; filter: RunFilter }) {
  const waitingOn = run.status === "waiting" ? pendingApprovals(run)[0]?.title : undefined;
  return (
    <Tip
      tip={
        <>
          {run.status}
          {waitingOn !== undefined && ` on “${waitingOn}”`}
          {run.sandbox !== undefined && ` · sandbox · ${run.sandbox}`} · {starterName(run)} ·{" "}
          <When at={run.createdAt} />
        </>
      }
    >
      <Link
        {...runLink(run)}
        search={railSearch(filter)}
        activeOptions={{ includeSearch: false }}
        className={RAIL_ICON}
      >
        <StatusDot tone={RUN_TONE[run.status]} />
        <span className="sr-only">
          {run.status} run by {starterName(run)}
        </span>
      </Link>
    </Tip>
  );
});

/**
 * A run in the rail: its status (and what it waits on), its sandbox, who started it and when.
 * Memoised: a poll keeps an unchanged run's object, so only the runs that changed draw again.
 */
const RunLink = memo(function RunLink({ run, filter }: { run: RunSummary; filter: RunFilter }) {
  const waitingOn = run.status === "waiting" ? pendingApprovals(run)[0]?.title : undefined;
  return (
    <Link {...runLink(run)} search={railSearch(filter)} activeOptions={{ includeSearch: false }} className={RAIL_LINK}>
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={RUN_TONE[run.status]} />
        <span className="shrink-0">{run.status}</span>
        {waitingOn !== undefined && <span className="truncate text-muted-foreground">{waitingOn}</span>}
        {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {/* Compact keeps one line: status · when. */}
        <span className="compact:hidden">{starterName(run)} · </span>
        <When at={run.createdAt} />
      </span>
    </Link>
  );
});
