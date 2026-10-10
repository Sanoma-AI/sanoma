import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, Outlet, retainSearchParams } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { loadCode, loadGraph, Notice, pageTitle } from "#/components/common.tsx";
import { RunRail } from "#/components/run-rail.tsx";
import {
  configQuery,
  railQuery,
  scenariosQuery,
  sourceQuery,
  workflowFile,
  workflowNamed,
  WorkflowSearch,
} from "#/queries.ts";

/**
 * One workflow's page: its header, the rail of its runs, and the pane the URL picks (About, New
 * run, or one run). The panes read what this loader puts in the query client.
 */
export const Route = createFileRoute("/workflows/$name")({
  // `?runs=` filters the rail; every link under this page keeps it.
  validateSearch: WorkflowSearch,
  search: { middlewares: [retainSearchParams(["runs"])] },
  loaderDeps: ({ search }) => ({ runs: search.runs }),
  loader: async ({ context: { queryClient }, params, deps }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const workflow = workflowNamed(params.name)(config);
    if (!workflow) throw notFound();
    const file = workflowFile(workflow);
    await Promise.all([
      file !== undefined && queryClient.query({ ...sourceQuery(file), staleTime: "static" }),
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
      queryClient.query({ ...railQuery(params.name, deps.runs), staleTime: "static" }),
    ]);
    return { crumb: workflow.title ?? workflow.name };
  },
  // A workflow that does not exist has no loader data: its name stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  component: WorkflowLayout,
  notFoundComponent: () => <Notice variant="destructive">No workflow {Route.useParams().name}.</Notice>,
});

function WorkflowLayout() {
  const { name } = Route.useParams();
  const { data: workflow } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => workflowNamed(name)(config)!,
  });
  // Not PageHeader: it names the last crumb, which on a run's page is the run.
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{workflow.title ?? workflow.name}</h1>
        <code className="text-muted-foreground">{workflow.name}</code>
        {workflow.builtin && <Badge variant="secondary">built-in</Badge>}
        <Button asChild className="ml-auto">
          <Link to="/workflows/$name/new" params={{ name }}>
            <PlayIcon data-icon="inline-start" />
            Run
          </Link>
        </Button>
      </header>
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
