import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import { starterName } from "#/api.ts";
import { ApprovalCard } from "#/components/approval.tsx";
import {
  Fact,
  Facts,
  loadCode,
  loadGraph,
  Nothing,
  Notice,
  pageTitle,
  SandboxBadge,
  SectionTitle,
  ToneBadge,
  When,
} from "#/components/common.tsx";
import { CheckRow, LedgerRow, show } from "#/components/ledger.tsx";
import { GraphAndSource } from "#/components/workflow.tsx";
import type { GraphNode } from "#/graph/types.ts";
import { useReducedMotion } from "#/lib/motion.ts";
import { RUN_TONE } from "#/lib/tone.ts";
import { configQuery, runQuery, sourceQuery, workflowFile, workflowNamed } from "#/queries.ts";

export const Route = createFileRoute("/workflows/$name/runs/$id")({
  // The page reads the run from the query client; the loader returns only its name: its id.
  loader: async ({ context: { queryClient }, params }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    const [{ run }, config] = await Promise.all([
      queryClient.query({ ...runQuery(params.id), staleTime: "static" }),
      queryClient.query({ ...configQuery(), staleTime: "static" }),
    ]);
    // A run under another workflow's page, from an edited URL: its own workflow's.
    if (run.workflow !== params.name) {
      throw redirect({ to: "/workflows/$name/runs/$id", params: { name: run.workflow, id: params.id } });
    }
    // The workflow's file, beside the graph.
    const workflow = workflowNamed(run.workflow)(config);
    const file = workflow && workflowFile(workflow);
    if (file !== undefined) await queryClient.query({ ...sourceQuery(file), staleTime: "static" });
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
  const { run, ledger, ledgerError, approvals, checks, checksError } = data;
  // Only its name when the config has no workflow of that name: the graph says so.
  const { data: workflow } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => workflowNamed(run.workflow)(config) ?? { name: run.workflow },
  });
  // The graph reads the clock only for whether the run's last record, a sleep, is over: the
  // sleep's end once it has come, else any time before it. So a poll that changed nothing keeps
  // the same reading, and the graph is not built again.
  const last = ledger.at(-1);
  const at = last?.type === "sleep.started" && last.until <= dataUpdatedAt ? last.until : 0;
  const reading = useMemo(() => ({ ledger, run, at }), [ledger, run, at]);
  const titles = useMemo(() => new Map(approvals.map((a) => [a.id, a.title])), [approvals]);
  const reducedMotion = useReducedMotion();
  const select = useCallback(
    (node: GraphNode) => {
      const recordId = "state" in node ? node.state?.recordId : undefined;
      if (recordId) show(recordId, reducedMotion);
    },
    [reducedMotion],
  );
  return (
    <div className="flex flex-col gap-6">
      {/* The layout's <h1> is the workflow: the run's own heading is its status. */}
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={RUN_TONE[run.status]}>{run.status}</ToneBadge>
        {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
      </div>
      {error && <Notice variant="destructive">Could not refresh: {error.message}</Notice>}
      <Card size="sm">
        <CardContent>
          <Facts>
            <Fact label="Started by">{starterName(run)}</Fact>
            <Fact label="Started">
              <When at={run.createdAt} />
            </Fact>
            <Fact label="Run id">
              <code className="break-all">{run.runId}</code>
            </Fact>
            {run.error && (
              <Fact label="Error">
                <span className="text-destructive">{run.error}</span>
              </Fact>
            )}
          </Facts>
        </CardContent>
      </Card>

      {(checks || checksError) && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Checks</SectionTitle>
          {checksError && (
            <Notice variant="destructive">
              {/* A step no rule matches lists the known steps, one a line. */}
              <span className="whitespace-pre-wrap">Could not check the run against its scenario: {checksError}</span>
            </Notice>
          )}
          {checks && (
            <ItemGroup aria-label="Checks">
              {checks.map((c, i) => (
                <CheckRow key={i} check={c} />
              ))}
            </ItemGroup>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <SectionTitle>Graph</SectionTitle>
        <GraphAndSource key={run.runId} workflow={workflow} run={reading} onSelect={select} />
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-3">
          <SectionTitle>Ledger</SectionTitle>
          {ledgerError && <Notice variant="destructive">Could not read the ledger: {ledgerError}</Notice>}
          {ledger.length === 0 && !ledgerError && <Nothing title="Nothing recorded yet" />}
          {ledger.length > 0 && (
            <ItemGroup aria-label="Ledger">
              {ledger.map((record) => (
                <LedgerRow key={record.id} record={record} titles={titles} />
              ))}
            </ItemGroup>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle>Approvals</SectionTitle>
          {approvals.length === 0 && <Nothing title="None asked for" />}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} run={run} approval={approval} />
          ))}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        <Link
          to="/workflows/$name/new"
          params={{ name: run.workflow }}
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          New run
        </Link>
      </p>
    </div>
  );
}
