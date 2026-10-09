import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useMemo } from "react";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { loadCode, loadGraph, Nothing, Notice, PageHeader, pageTitle } from "../../components/common.tsx";
import { GraphAndSource, StartButton, WorkflowSections } from "../../components/workflow.tsx";
import { configQuery, sourceQuery } from "../../queries.ts";

export const Route = createFileRoute("/workflows/$name")({
  // The page reads the config and the source from the query client; the loader returns only its
  // name: the workflow's title.
  loader: async ({ context: { queryClient }, params }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const workflow = config.workflows.find((wf) => wf.name === params.name);
    if (!workflow) throw notFound();
    // An outline that could not be read has no source.
    if (!("error" in workflow.outline)) {
      await queryClient.query({ ...sourceQuery(params.name), staleTime: "static" });
    }
    return { crumb: workflow.title ?? workflow.name };
  },
  // A workflow that does not exist has no loader data: its name stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  component: WorkflowPage,
  notFoundComponent: () => <Notice variant="destructive">No workflow {Route.useParams().name}.</Notice>,
});

function WorkflowPage() {
  const { name } = Route.useParams();
  const { data: workflow } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => config.workflows.find((wf) => wf.name === name)!,
  });
  const { outline } = workflow;
  const source = useMemo(() => ("nodes" in outline ? { outline: outline.nodes } : undefined), [outline]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader>
        <code className="text-muted-foreground">{workflow.name}</code>
        <div className="ml-auto">
          <StartButton name={workflow.name} />
        </div>
      </PageHeader>
      {source ? (
        <GraphAndSource key={name} name={name} outline={outline} source={source} show="start" />
      ) : (
        "error" in outline && <Nothing title="No outline">{outline.error}</Nothing>
      )}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <WorkflowSections workflow={workflow} />
        </CardContent>
      </Card>
    </div>
  );
}
