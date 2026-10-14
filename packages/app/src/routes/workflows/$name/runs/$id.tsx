import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo } from "react";
import { loadCode, loadGraph, Notice, pageTitle, SandboxBadge, ToneBadge } from "#/components/common.tsx";
import { WorkflowView } from "#/components/workflow-view.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { runLink, runQuery, useWorkflow } from "#/queries.ts";

export const Route = createFileRoute("/workflows/$name/runs/$id")({
  // Before any loader, so the layout never loads the wrong workflow's page: a run under another
  // workflow's page, from an edited URL, goes to its own workflow's.
  beforeLoad: async ({ context: { queryClient }, params }) => {
    const { run } = await queryClient.query({ ...runQuery(params.id), staleTime: "static" });
    if (run.workflow !== params.name) throw redirect(runLink(run));
  },
  // The page reads the run from the query client, read above; the layout loads the workflow's
  // source. The loader returns only the run's name: its id.
  loader: ({ params }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    return { crumb: params.id };
  },
  head: ({ params }) => pageTitle(params.id),
  component: RunPage,
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice variant="destructive">No run {Route.useParams().id}.</Notice>,
});

function RunPage() {
  const { id } = Route.useParams();
  const { data, error, dataUpdatedAt } = useSuspenseQuery(runQuery(id));
  const { run, ledger } = data;
  // None when the workflow is retired (the config no longer has it): the view draws the run alone.
  const workflow = useWorkflow(run.workflow);
  // The graph reads the clock only for whether the run's last record, a sleep, is over: the
  // sleep's end once it has come, else any time before it. So a poll that changed nothing keeps
  // the same reading, and the graph is not built again.
  const last = ledger.at(-1);
  const at = last?.type === "sleep.started" && last.until <= dataUpdatedAt ? last.until : 0;
  const reading = useMemo(() => ({ ...data, at }), [data, at]);
  return (
    <WorkflowView key={run.runId} name={run.workflow} workflow={workflow} run={reading}>
      {/* The layout's <h1> is the workflow: the run's own heading is its status. */}
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={RUN_TONE[run.status]}>{run.status}</ToneBadge>
        {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
      </div>
      {error && <Notice variant="destructive">Could not refresh: {error.message}</Notice>}
    </WorkflowView>
  );
}
