import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, Outlet } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { ButtonLink, loadCode, loadGraph, Notice, PageHeader, pageTitle } from "#/components/common.tsx";
import { RunRail } from "#/components/run-rail.tsx";
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
 * One workflow's page: its header, the rail of its runs, and the pane the URL picks (the
 * workflow's own, or one run's), each a WorkflowView. The panes read what this loader puts in the
 * query client.
 */
export const Route = createFileRoute("/workflows/$name")({
  // The rail, the graph and the inspector side by side: the graph gets what the screen has left.
  staticData: { wide: true },
  // On either pane: `?runs=` filters the rail, `?new` opens New run in the inspector, and
  // `?scenario=` is its Sandbox mode. The rail's own links carry `?runs=` (and drop the others);
  // a middleware retaining it would put it on the sidebar's links to other workflows too.
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
  // Titled by the workflow (on a run's pane the last crumb, PageHeader's default, is the run), or
  // only its name when it is retired. New run opens in the inspector of the pane that shows: none
  // for a retired workflow, which has nothing to start.
  return (
    <>
      <PageHeader
        title={workflow?.title ?? name}
        action={
          workflow && (
            <ButtonLink size="sm">
              <Link to="." search={(prev) => ({ ...prev, new: true })}>
                <PlayIcon data-icon="inline-start" />
                New run
              </Link>
            </ButtonLink>
          )
        }
      >
        {workflow && <code className="text-muted-foreground">{name}</code>}
        {workflow?.builtin && <Badge variant="secondary">built-in</Badge>}
      </PageHeader>
      {/* The rail beside the pane, or above it once the pane would be narrower than 560px. Folded, the
          rail is a narrow column. */}
      <div className="flex flex-wrap items-start gap-(--gap-region)">
        <RunRail name={name} />
        <div className="min-w-0 flex-[999_1_560px]">
          <Outlet />
        </div>
      </div>
    </>
  );
}
