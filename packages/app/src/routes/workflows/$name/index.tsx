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
import { runQuery, scenariosFor, scenariosQuery, useWorkflow, WorkflowPageSearch } from "#/queries.ts";

/**
 * A workflow's page: its header with New run, then its tabs, each a URL (`?view=`): the Graph
 * (marked with the scenario `?scenario=` names), with About, a selected node or New run (`?new`)
 * floating over it; its Runs, the one `?run=` names floating over them; its Code; and its
 * Scenarios, when it has any. The layout loads all of it but the open run, and titles the tab. A
 * retired workflow has only its Runs to show.
 */
export const Route = createFileRoute("/workflows/$name/")({
  validateSearch: WorkflowPageSearch,
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ context: { queryClient }, deps }) => {
    // A run that cannot be read is the run's card's to say.
    if (deps.run !== undefined)
      await queryClient.query({ ...runQuery(deps.run), staleTime: "static" }).catch(() => undefined);
  },
  component: WorkflowPage,
});

function WorkflowPage() {
  const { name } = Route.useParams();
  const { view, run, runs = "all", scenario: wanted } = Route.useSearch();
  const workflow = useWorkflow(name);
  const forWorkflow = useMemo(() => scenariosFor(name), [name]);
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: forWorkflow });
  const { shown } = useWorkflowRuns(name, runs);
  const scenario = scenarios.find((s) => s.name === wanted);
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
      {/* Each tab keeps the rest of the search: the runs' filter, the scenario, New run. */}
      <LinkTabs label="Views" value={view ?? "graph"}>
        <LinkTab
          value="graph"
          link={<Link from={Route.fullPath} to="." search={(prev) => ({ ...prev, view: undefined })} />}
        >
          Graph
        </LinkTab>
        <LinkTab
          value="runs"
          link={<Link from={Route.fullPath} to="." search={(prev) => ({ ...prev, view: "runs" })} />}
          count={shown.length}
        >
          Runs
        </LinkTab>
        {workflow && (
          <LinkTab
            value="code"
            link={<Link from={Route.fullPath} to="." search={(prev) => ({ ...prev, view: "code" })} />}
          >
            Code
          </LinkTab>
        )}
        {scenarios.length > 0 && (
          <LinkTab
            value="scenarios"
            link={<Link from={Route.fullPath} to="." search={(prev) => ({ ...prev, view: "scenarios" })} />}
            count={scenarios.length}
          >
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
