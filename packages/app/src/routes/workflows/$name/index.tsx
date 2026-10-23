import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { ButtonLink, CrumbHeader, LinkTab, LinkTabs } from "#/components/common.tsx";
import { ScenarioErrors, Scenarios } from "#/components/scenario.tsx";
import { useWorkflowRuns, WorkflowRuns } from "#/components/workflow-runs.tsx";
import { WorkflowView } from "#/components/workflow-view.tsx";
import { Retired } from "#/components/workflow.tsx";
import {
  type RunFilter,
  runQuery,
  scenariosFor,
  scenariosQuery,
  useWorkflow,
  type WORKFLOW_VIEWS,
  WorkflowPageSearch,
  workflowRunsQuery,
} from "#/queries.ts";

/**
 * A workflow's page: its header with New run, then its tabs, each a URL (`?view=`): the Graph
 * (marked with the scenario `?scenario=` names), with About, a selected node or New run (`?new`)
 * floating over it; its Runs, the one `?run=` names floating over them; its Code; and its
 * Scenarios, when it has any. The layout loads the workflow, its source and scenarios, and titles
 * the tab; this loads its runs (the Runs tab and its count) and the open run. A retired workflow
 * has only its Runs to show.
 */
export const Route = createFileRoute("/workflows/$name/")({
  validateSearch: WorkflowPageSearch,
  loaderDeps: ({ search }) => ({ runs: search.runs, run: search.view === "runs" ? search.run : undefined }),
  loader: async ({ context: { queryClient }, params, deps }) => {
    // A run that cannot be read is the run's card's to say. Awaited on the server, so the page
    // comes with it; in the browser the card shows at once and fills as it comes.
    const open =
      deps.run === undefined
        ? undefined
        : queryClient.query({ ...runQuery(deps.run), staleTime: "static" }).catch(() => undefined);
    await Promise.all([
      queryClient.query({ ...workflowRunsQuery(params.name, deps.runs), staleTime: "static" }),
      import.meta.env.SSR && open,
    ]);
  },
  component: WorkflowPage,
});

function WorkflowPage() {
  const { name } = Route.useParams();
  const { view: asked, run, runs = "all", scenario: wanted } = Route.useSearch();
  const workflow = useWorkflow(name);
  const forWorkflow = useMemo(() => scenariosFor(name), [name]);
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: forWorkflow });
  const scenario = scenarios.find((s) => s.name === wanted);
  // A view whose tab is not there (no scenarios, no code for a retired workflow) is the Graph.
  const view = (asked === "scenarios" && scenarios.length === 0) || (asked === "code" && !workflow) ? undefined : asked;
  return (
    <>
      <CrumbHeader
        action={
          workflow && (
            <ButtonLink size="sm">
              <Link
                from={Route.fullPath}
                to="."
                search={(prev) => ({ ...prev, view: undefined, run: undefined, new: true })}
              >
                <PlayIcon aria-hidden="true" data-icon="inline-start" />
                New run
              </Link>
            </ButtonLink>
          )
        }
      >
        {workflow && <code className="text-muted-foreground">{name}</code>}
        {workflow?.builtin && <Badge variant="secondary">built-in</Badge>}
      </CrumbHeader>
      <ScenarioErrors errors={errors} />
      <LinkTabs label="Views" value={view ?? "graph"}>
        <LinkTab value="graph" link={viewLink(undefined)}>
          Graph
        </LinkTab>
        <RunsTab name={name} filter={runs} />
        {workflow && (
          <LinkTab value="code" link={viewLink("code")}>
            Code
          </LinkTab>
        )}
        {scenarios.length > 0 && (
          <LinkTab value="scenarios" link={viewLink("scenarios")} count={scenarios.length}>
            Scenarios
          </LinkTab>
        )}
      </LinkTabs>
      {view === "runs" ? (
        <WorkflowRuns name={name} filter={runs} open={run} />
      ) : view === "scenarios" ? (
        <Scenarios scenarios={scenarios} open={scenario} />
      ) : workflow ? (
        // Kept mounted from the Graph to the Code and back, so the node selected stays.
        <WorkflowView key={name} name={name} workflow={workflow} scenario={scenario} view={view ?? "graph"} />
      ) : (
        <Retired name={name} />
      )}
    </>
  );
}

/**
 * A tab's link: its view, keeping the rest of the search (the runs' filter, the scenario, New
 * run) but the run open on Runs, which no other tab shows.
 */
function viewLink(view: (typeof WORKFLOW_VIEWS)[number] | undefined) {
  return (
    <Link
      from={Route.fullPath}
      to="."
      search={(prev) => ({ ...prev, view, run: view === "runs" ? prev.run : undefined })}
    />
  );
}

/**
 * The Runs tab, with how many runs its filter keeps: on its own, so the runs' poll draws the tab
 * again and not the graph beside it.
 */
function RunsTab({ name, filter }: { name: string; filter: RunFilter }) {
  const { shown } = useWorkflowRuns(name, filter);
  return (
    <LinkTab value="runs" link={viewLink("runs")} count={shown.length}>
      Runs
    </LinkTab>
  );
}
