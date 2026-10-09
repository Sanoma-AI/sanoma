import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { loadCode, loadGraph, Notice, PageHeader, pageTitle } from "../../components/common.tsx";
import { GraphAndSource, StartButton, WorkflowSections } from "../../components/workflow.tsx";
import { configQuery, sourceQuery, workflowNamed } from "../../queries.ts";

export const Route = createFileRoute("/workflows/$name")({
  // The page reads the config and the source from the query client; the loader returns only its
  // name: the workflow's title.
  loader: async ({ context: { queryClient }, params }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const workflow = workflowNamed(params.name)(config);
    if (!workflow) throw notFound();
    await queryClient.query({ ...sourceQuery(params.name), staleTime: "static" });
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
    select: (config) => workflowNamed(name)(config)!,
  });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader action={<StartButton name={workflow.name} />}>
        <code className="text-muted-foreground">{workflow.name}</code>
      </PageHeader>
      <GraphAndSource key={name} workflow={workflow} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <WorkflowSections workflow={workflow} />
        </CardContent>
      </Card>
    </div>
  );
}
