import type { RunSummary } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { configQuery, lastRunByWorkflow, pendingByWorkflow, recentRunsQuery, waitingRunsQuery } from "../../queries.ts";
import { StatusDot } from "../common.tsx";
import { NewWorkflowIconButton } from "../new-workflow.tsx";
import { PanelHeader, usePanelPlace } from "./panel.tsx";

// The Workflows section's panel: find a workflow, those waiting on someone, then the rest by their last run.

/** Whether the workflow's title or name holds what was typed, whatever its case. */
const matches = (wf: WorkflowEntry, query: string) =>
  query === "" || `${wf.title ?? ""} ${wf.name}`.toLocaleLowerCase("en").includes(query.toLocaleLowerCase("en"));

/**
 * Every workflow of the config: those whose runs wait on an approval first, with how many; then
 * the rest, the latest run first (a status dot each), those with no run among the latest runs
 * last. "Find a workflow" filters both by title or name, in the browser. All of them are on the
 * overview, which the foot links to.
 */
export function WorkflowsPanel() {
  const { close } = usePanelPlace();
  const [query, setQuery] = useState("");
  const { data: workflows } = useSuspenseQuery({ ...configQuery(), select: (config) => config.workflows });
  const { data: pending } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingByWorkflow });
  const { data: last } = useSuspenseQuery({ ...recentRunsQuery(), select: lastRunByWorkflow });
  const found = workflows.filter((wf) => matches(wf, query.trim()));
  const waiting = found.filter((wf) => pending.byWorkflow[wf.name]);
  const recent = found
    .filter((wf) => !pending.byWorkflow[wf.name])
    .toSorted((a, b) => (last[b.name]?.createdAt ?? 0) - (last[a.name]?.createdAt ?? 0));
  return (
    <>
      <PanelHeader title="Workflows" actions={<NewWorkflowIconButton />}>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput
            type="search"
            aria-label="Find a workflow"
            placeholder="Find a workflow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </PanelHeader>
      <SidebarContent>
        {found.length === 0 && (
          <p className="px-4 py-2 text-sm text-muted-foreground">
            {workflows.length === 0 ? "This config has no workflows" : "No workflow matches"}
          </p>
        )}
        {waiting.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel render={<h3 />}>Waiting on you</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {waiting.map((wf) => (
                  <WorkflowRow key={wf.name} workflow={wf} onClick={close}>
                    <SidebarMenuBadge className="bg-tone-waiting text-tone-waiting-foreground">
                      {pending.byWorkflow[wf.name]}
                      <span className="sr-only"> waiting</span>
                    </SidebarMenuBadge>
                  </WorkflowRow>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {recent.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel render={<h3 />}>Recent</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {recent.map((wf) => (
                  <WorkflowRow key={wf.name} workflow={wf} last={last[wf.name]} onClick={close} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/workflows" activeOptions={{ exact: true, includeSearch: false }} onClick={close} />}
              className="text-muted-foreground"
            >
              <span>
                See all {workflows.length} workflow{workflows.length === 1 ? "" : "s"}
              </span>
              <ArrowRightIcon className="ml-auto" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

/**
 * A workflow's link: a dot in its last run's status's colour (none for one waiting, whose count is
 * `children`), its title, and built-in for the built-in one.
 */
function WorkflowRow({
  workflow,
  last,
  onClick,
  children,
}: {
  workflow: WorkflowEntry;
  last?: RunSummary | undefined;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // Room for the count beside it.
        className={children === undefined ? undefined : "pr-8"}
        render={<Link to="/workflows/$name" params={{ name: workflow.name }} onClick={onClick} />}
      >
        {children === undefined && <StatusDot tone={last ? RUN_TONE[last.status] : "off"} />}
        <span className="truncate">{workflow.title ?? workflow.name}</span>
        {children === undefined && (
          <span className="sr-only">{last ? `, last run ${last.status}` : ", no recent run"}</span>
        )}
        {workflow.builtin && <span className="ml-auto shrink-0 text-xs text-muted-foreground">built-in</span>}
      </SidebarMenuButton>
      {children}
    </SidebarMenuItem>
  );
}
