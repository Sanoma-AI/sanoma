import type { RunSummary } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, WorkflowIcon } from "lucide-react";
import { memo } from "react";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../../api.ts";
import {
  configQuery,
  picksFromLatest,
  RAIL_LIMIT,
  railQuery,
  railRuns,
  RUN_FILTERS,
  type RunFilter,
  runLink,
  workflowNamed,
} from "../../queries.ts";
import { Notice, StatusDot, When } from "../common.tsx";
import { PanelHeader, usePanelPlace } from "./panel.tsx";

// The panel inside a workflow: back to the workflows, the workflow's own pane, and its latest runs.

const FILTER_LABEL: Record<RunFilter, string> = {
  all: "All",
  live: "Live",
  sandbox: "Sandbox",
  waiting: "Waiting",
  failed: "Failed",
};

/** The panel's links keep the filter and drop the rest (`?new`, `?scenario=`); All leaves the URL without `?runs=`. */
const runsSearch = (filter: RunFilter) => ({ runs: filter === "all" ? undefined : filter });

/** A section's or the page's link, lit while it is the page open (Link sets `aria-current` too). */
const ACTIVE = { "data-active": true } as const;

/**
 * One workflow's panel, on its page (either pane): ← Workflows, its name, its Workflow pane, then
 * its runs, newest first, filtered by `?runs=`, and All runs, the Workflows page's All runs of it.
 * It reads the runs itself, so a poll draws the panel again and not the page beside it.
 */
export function WorkflowPanel({ name }: { name: string }) {
  const { close } = usePanelPlace();
  const { data: workflow } = useSuspenseQuery({ ...configQuery(), select: workflowNamed(name) });
  // Only `?runs=`, which the workflow's page validates.
  const filter = useSearch({ strict: false, select: (search) => search.runs }) ?? "all";
  const navigate = useNavigate();
  const { data: runs, error } = useSuspenseQuery(railQuery(name, filter));
  const shown = railRuns(filter, runs);
  const search = runsSearch(filter);
  // Live and sandbox are picked from the latest runs: what they show is only of those.
  const fromLatest = picksFromLatest(filter);
  return (
    <>
      <PanelHeader
        title={
          <Link
            to="/workflows"
            activeOptions={{ exact: true, includeSearch: false }}
            onClick={close}
            className="-ml-1 flex flex-1 items-center gap-1 rounded-md px-1 py-1 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-hidden"
          >
            <ArrowLeftIcon className="size-4" />
            Workflows
          </Link>
        }
      >
        <div className="flex flex-col gap-0.5 px-1">
          <h2 className="truncate text-base font-semibold">{workflow?.title ?? name}</h2>
          {workflow && <code className="truncate text-xs text-muted-foreground">{name}</code>}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Active with any `?scenario=` or `?runs=`, not on a run's pane. It leaves `?scenario=`
                behind: reading it would draw the panel again on each scenario chosen. */}
            <SidebarMenuButton
              render={
                <Link
                  to="/workflows/$name"
                  params={{ name }}
                  search={search}
                  activeOptions={{ exact: true, includeSearch: false }}
                  activeProps={ACTIVE}
                  onClick={close}
                />
              }
            >
              <WorkflowIcon />
              <span>Workflow</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </PanelHeader>
      <SidebarContent>
        <SidebarGroup>
          <div className="flex items-center gap-2 pr-1">
            <SidebarGroupLabel render={<h3 />} className="flex-1">
              Runs
            </SidebarGroupLabel>
            <NativeSelect
              size="sm"
              aria-label="Show runs"
              value={filter}
              // Another filter replaces the page in the history rather than adding one.
              onChange={(e) => {
                const chosen = e.target.value as RunFilter;
                void navigate({ to: ".", search: (prev) => ({ ...prev, ...runsSearch(chosen) }), replace: true });
              }}
            >
              {RUN_FILTERS.map((f) => (
                <NativeSelectOption key={f} value={f}>
                  {FILTER_LABEL[f]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <SidebarGroupContent className="flex flex-col gap-2">
            {error && <Notice variant="destructive">Could not refresh the runs: {error.message}</Notice>}
            {runs.length === RAIL_LIMIT && (
              <p className="px-2 text-xs text-muted-foreground">
                {fromLatest ? "From" : "Showing"} the latest {RAIL_LIMIT}
              </p>
            )}
            {shown.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">
                {filter === "all"
                  ? "No runs yet"
                  : fromLatest
                    ? `No ${filter} runs among the latest ${RAIL_LIMIT}`
                    : "No runs match"}
              </p>
            ) : (
              <SidebarMenu aria-label="Runs" className="gap-0.5">
                {shown.map((run) => (
                  <RunRow key={run.runId} run={run} filter={filter} onClick={close} />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/workflows" search={{ view: "runs", workflow: name }} onClick={close} />}
              className="text-muted-foreground"
            >
              <span>All runs</span>
              <ArrowRightIcon className="ml-auto" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

/**
 * A run in the panel: its status (and what it waits on), then its sandbox, and who started it and
 * when, marked while it is the run open. Memoised: a poll keeps an unchanged run's object, so only
 * the runs that changed draw again.
 */
const RunRow = memo(function RunRow({
  run,
  filter,
  onClick,
}: {
  run: RunSummary;
  filter: RunFilter;
  onClick: () => void;
}) {
  const waitingOn = run.status === "waiting" ? pendingApprovals(run)[0]?.title : undefined;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-auto flex-col items-stretch gap-0.5 py-1.5"
        render={
          <Link
            {...runLink(run)}
            search={runsSearch(filter)}
            activeOptions={{ includeSearch: false }}
            activeProps={ACTIVE}
            onClick={onClick}
          />
        }
      >
        {/* A long approval title or scenario is cut, so the panel keeps its width. */}
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot tone={RUN_TONE[run.status]} />
          <span className="shrink-0">{run.status}</span>
          {waitingOn !== undefined && <span className="truncate text-muted-foreground">{waitingOn}</span>}
        </span>
        {run.sandbox !== undefined && (
          <span className="truncate pl-4.5 text-xs text-muted-foreground">sandbox · {run.sandbox}</span>
        )}
        <span className="truncate pl-4.5 text-xs text-muted-foreground">
          {starterName(run)} · <When at={run.createdAt} />
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
