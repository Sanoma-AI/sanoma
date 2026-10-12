import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import { loadCode, loadGraph, Notice, PageHeader, pageTitle } from "#/components/common.tsx";
import { RunRail } from "#/components/run-rail.tsx";
import { RunButton } from "#/components/workflow.tsx";
import {
  configQuery,
  railQuery,
  scenariosQuery,
  sourceQuery,
  useWorkflow,
  workflowFile,
  workflowNamed,
  WorkflowSearch,
} from "#/queries.ts";

/**
 * One workflow's page: its header, the rail of its runs, and the pane the URL picks (About, New
 * run, or one run). The panes read what this loader puts in the query client.
 */
export const Route = createFileRoute("/workflows/$name")({
  // `?runs=` filters the rail. The rail's own links carry it; a middleware retaining it would
  // put it on the sidebar's links to other workflows too.
  validateSearch: WorkflowSearch,
  loaderDeps: ({ search }) => ({ runs: search.runs }),
  loader: async ({ context: { queryClient }, params, deps }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    // The rail and the scenarios do not need the config: they load beside it.
    const [workflow] = await Promise.all([
      loadWorkflow(queryClient, params.name),
      queryClient.query({ ...railQuery(params.name, deps.runs), staleTime: "static" }),
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
    ]);
    return { crumb: workflow?.title ?? params.name };
  },
  // A workflow that does not exist has no loader data: its name stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  component: WorkflowLayout,
  notFoundComponent: () => <Notice variant="destructive">No workflow {Route.useParams().name}.</Notice>,
});

/**
 * The config's workflow of this name, with its file's source loaded. None for a retired workflow,
 * one the config no longer has: its page stays while it has runs to show; without, not-found.
 */
async function loadWorkflow(queryClient: QueryClient, name: string) {
  const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
  const workflow = workflowNamed(name)(config);
  if (!workflow) {
    const runs = await queryClient.query({ ...railQuery(name), staleTime: "static" });
    if (runs.length === 0) throw notFound();
    return undefined;
  }
  const file = workflowFile(workflow);
  if (file !== undefined) await queryClient.query({ ...sourceQuery(file), staleTime: "static" });
  return workflow;
}

function WorkflowLayout() {
  const { name } = Route.useParams();
  const workflow = useWorkflow(name);
  // Titled by the workflow: the last crumb, PageHeader's default, is the run on a run's page.
  // A retired workflow has only its name, and no Run.
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={workflow?.title ?? name} action={workflow && <RunButton name={name} />}>
        {workflow && <code className="text-muted-foreground">{name}</code>}
        {workflow?.builtin && <Badge variant="secondary">built-in</Badge>}
      </PageHeader>
      {/* The rail beside the pane, or above it once the pane would be narrower than 560px. */}
      <div className="flex flex-wrap items-start gap-6">
        <RunRail name={name} />
        <div className="min-w-0 flex-[999_1_560px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
