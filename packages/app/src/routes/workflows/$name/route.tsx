import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { loadCode, loadGraph, Notice, pageTitle } from "#/components/common.tsx";
import {
  configQuery,
  workflowRunsQuery,
  scenariosQuery,
  sourceQuery,
  workflowFile,
  workflowNamed,
  WorkflowSearch,
} from "#/queries.ts";

/**
 * Layout for a workflow's page and its runs' pages, with no component: loads the workflow, its
 * source, its scenarios and its runs (for the Runs tab and its count), which the pages read from
 * the query client, and names the workflow's crumb.
 */
export const Route = createFileRoute("/workflows/$name")({
  // The graph takes the page's full width, the inspector floating over its right.
  staticData: { wide: true },
  // On both pages: `?runs=` filters the Runs tab, `?new` opens New run in the inspector, and
  // `?scenario=` is the scenario open (New run's Sandbox mode). The tabs keep them; a middleware
  // retaining them would put them on the links to other workflows too.
  validateSearch: WorkflowSearch,
  loaderDeps: ({ search }) => ({ runs: search.runs }),
  loader: async ({ context: { queryClient }, params, deps }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    // The runs and the scenarios do not need the config: they load beside it.
    const [workflow] = await Promise.all([
      loadWorkflow(queryClient, params.name),
      queryClient.query({ ...workflowRunsQuery(params.name, deps.runs), staleTime: "static" }),
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
    ]);
    return { crumb: workflow?.title ?? params.name };
  },
  // A workflow that does not exist has no loader data: its name stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
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
    const runs = await queryClient.query({ ...workflowRunsQuery(name), staleTime: "static" });
    if (runs.length === 0) throw notFound();
    return undefined;
  }
  const file = workflowFile(workflow);
  if (file !== undefined) await queryClient.query({ ...sourceQuery(file), staleTime: "static" });
  return workflow;
}
