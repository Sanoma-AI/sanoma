import { CHANGE_WORKFLOW, changeIdOf } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { useMemo } from "react";
import {
  ButtonLink,
  CrumbHeader,
  loadCode,
  loadGraph,
  Notice,
  pageTitle,
  SandboxBadge,
  ToneBadge,
  When,
} from "#/components/common.tsx";
import { WorkflowView } from "#/components/workflow-view.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { runName, starterName } from "#/api.ts";
import { runLink, runQuery, useWorkflow } from "#/queries.ts";

export const Route = createFileRoute("/workflows/$name/runs/$id")({
  // Before any loader, so the layout never loads the wrong workflow's page: a run under another
  // workflow's page, from an edited URL, goes to its own workflow's.
  beforeLoad: async ({ context: { queryClient }, params }) => {
    const { run } = await queryClient.query({ ...runQuery(params.id), staleTime: "static" });
    if (run.workflow !== params.name) throw redirect(runLink(run));
  },
  // The page reads the run from the query client, read above; the layout loads the workflow's
  // source. The loader returns only the run's name: "Run" and its id's start.
  loader: ({ params }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    return { crumb: runName(params.id) };
  },
  head: ({ params }) => pageTitle(runName(params.id)),
  component: RunPage,
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice variant="destructive">No run {Route.useParams().id}.</Notice>,
});

/**
 * One run of the workflow: under the workflow's crumbs, its name, status and who started it when,
 * New run (on the workflow's page; a change's run has Review, its page, instead: only sending a
 * draft for review starts one), then its `WorkflowView`: the banner of a waiting or failed
 * run, the graph with the run's facts and approvals floating over it, then Ledger and Code.
 */
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
  const change = run.workflow === CHANGE_WORKFLOW ? changeIdOf(run.runId) : undefined;
  return (
    <>
      <CrumbHeader
        action={
          change !== undefined ? (
            <ButtonLink size="sm">
              <Link to="/changes/$id" params={{ id: change }}>
                Review
              </Link>
            </ButtonLink>
          ) : (
            workflow && (
              <ButtonLink size="sm">
                <Link to="/workflows/$name" params={{ name: run.workflow }} search={{ new: true }}>
                  <PlayIcon aria-hidden="true" data-icon="inline-start" />
                  New run
                </Link>
              </ButtonLink>
            )
          )
        }
      >
        <ToneBadge id="run-status" dot tone={RUN_TONE[run.status]}>
          {run.status}
        </ToneBadge>
        {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
        <span className="text-muted-foreground">
          {starterName(run)} · <When at={run.createdAt} />
        </span>
      </CrumbHeader>
      {error && <Notice variant="destructive">Could not refresh: {error.message}</Notice>}
      <WorkflowView key={run.runId} name={run.workflow} workflow={workflow} run={reading} />
    </>
  );
}
