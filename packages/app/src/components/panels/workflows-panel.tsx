import type { RunSummary } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { countByWorkflow, usePending } from "#/lib/inbox.ts";
import { RUN_TONE } from "#/lib/tone.ts";
import { configQuery, lastRunsQuery, OVERVIEW } from "../../queries.ts";
import { StatusDot, toneBadge } from "../common.tsx";
import { NewWorkflowIconButton } from "../new-workflow.tsx";
import { PanelEmpty, PanelFooterLink, PanelHeader } from "./panel.tsx";

// The Workflows section's panel: find a workflow, those waiting on you, then the rest by their last run.

/** Whether the workflow's title or name holds what was typed, whatever its case. */
const matches = (wf: WorkflowEntry, query: string) =>
  query === "" || `${wf.title ?? ""} ${wf.name}`.toLocaleLowerCase("en").includes(query.toLocaleLowerCase("en"));

/**
 * Every workflow of the config: first those whose runs wait on an approval you may decide, with
 * how many; then the rest, the latest run first (a status dot each), those never run last. "Find
 * a workflow" filters both by title or name, in the browser. All of them are on the overview,
 * which the foot links to.
 */
export function WorkflowsPanel() {
  const [query, setQuery] = useState("");
  const { data: workflows } = useSuspenseQuery({ ...configQuery(), select: (config) => config.workflows });
  const { mine } = usePending();
  const yours = countByWorkflow(mine);
  const { data: last } = useSuspenseQuery(lastRunsQuery());
  const found = workflows.filter((wf) => matches(wf, query.trim()));
  const waiting = found.filter((wf) => yours[wf.name]);
  const recent = found
    .filter((wf) => !yours[wf.name])
    .toSorted((a, b) => (last[b.name]?.createdAt ?? 0) - (last[a.name]?.createdAt ?? 0));
  return (
    <>
      <PanelHeader section="workflows" title="Workflows" actions={<NewWorkflowIconButton />}>
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
          <SidebarGroup>
            <PanelEmpty>{workflows.length === 0 ? "This config has no workflows" : "No workflow matches"}</PanelEmpty>
          </SidebarGroup>
        )}
        {waiting.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel render={<h3 />}>Waiting on you</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {waiting.map((wf) => (
                  <WorkflowRow key={wf.name} workflow={wf} waiting={yours[wf.name]} />
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
                  <WorkflowRow key={wf.name} workflow={wf} last={last[wf.name]} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <PanelFooterLink link={<Link {...OVERVIEW} />}>
        See all {workflows.length} workflow{workflows.length === 1 ? "" : "s"}
      </PanelFooterLink>
    </>
  );
}

/**
 * A workflow's link: its title, built-in for the built-in one, and either how many approvals
 * wait on you (`waiting`) or a dot in its last run's status's colour.
 */
function WorkflowRow({
  workflow,
  last,
  waiting,
}: {
  workflow: WorkflowEntry;
  last?: RunSummary | undefined;
  waiting?: number | undefined;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // Room for the count beside it.
        className={waiting ? "pr-8" : undefined}
        render={<Link to="/workflows/$name" params={{ name: workflow.name }} />}
      >
        {!waiting && <StatusDot tone={last ? RUN_TONE[last.status] : "off"} />}
        <span className="truncate">{workflow.title ?? workflow.name}</span>
        {!waiting && <span className="sr-only">{last ? `, last run ${last.status}` : ", never run"}</span>}
        {workflow.builtin && <span className="ml-auto shrink-0 text-xs text-muted-foreground">built-in</span>}
      </SidebarMenuButton>
      {!!waiting && (
        <SidebarMenuBadge className={toneBadge({ tone: "waiting" })}>
          {waiting}
          <span className="sr-only"> waiting on you</span>
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}
