import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { loadCode, loadGraph, Nothing, Notice, PageHeader, pageTitle } from "../../components/common.tsx";
import { ScenarioCard, ScenarioPicker, TestButton } from "../../components/scenario.tsx";
import { GraphAndSource, StartButton, WorkflowSections } from "../../components/workflow.tsx";
import { configQuery, scenariosFor, scenariosQuery, sourceQuery, workflowNamed } from "../../queries.ts";

export const Route = createFileRoute("/workflows/$name")({
  // `?scenario=` names the scenario shown, marked on the graph, and tried by Test.
  validateSearch: z.object({ scenario: z.string().optional().catch(undefined) }),
  // The page reads the config, the source and the scenarios from the query client; the loader
  // returns only its name: the workflow's title.
  loader: async ({ context: { queryClient }, params }) => {
    if (!import.meta.env.SSR) {
      void loadGraph();
      void loadCode();
    }
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const workflow = workflowNamed(params.name)(config);
    if (!workflow) throw notFound();
    await Promise.all([
      queryClient.query({ ...sourceQuery(params.name), staleTime: "static" }),
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
    ]);
    return { crumb: workflow.title ?? workflow.name };
  },
  // A workflow that does not exist has no loader data: its name stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  component: WorkflowPage,
  notFoundComponent: () => <Notice variant="destructive">No workflow {Route.useParams().name}.</Notice>,
});

function WorkflowPage() {
  const { name } = Route.useParams();
  const { scenario: wanted } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: workflow } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => workflowNamed(name)(config)!,
  });
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: scenariosFor(name) });
  const scenario = scenarios.find((s) => s.name === wanted);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ScenarioPicker
              scenarios={scenarios}
              value={scenario?.name}
              // Choosing another scenario replaces the page in the history rather than adding one.
              onChange={(chosen) => void navigate({ search: { scenario: chosen }, replace: true })}
            />
            <TestButton scenario={scenario?.name} />
            <StartButton name={workflow.name} />
          </div>
        }
      >
        <code className="text-muted-foreground">{workflow.name}</code>
      </PageHeader>
      {errors.map((e) => (
        <Notice key={e.message} variant="destructive">
          Could not read a scenario: {e.message}
        </Notice>
      ))}
      <GraphAndSource key={name} workflow={workflow} scenario={scenario} />
      {wanted !== undefined &&
        (scenario ? (
          <ScenarioCard scenario={scenario} />
        ) : (
          <Nothing title={`No scenario named “${wanted}”`}>
            This workflow’s scenarios are in the list above, beside Test.
          </Nothing>
        ))}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <WorkflowSections workflow={workflow} />
        </CardContent>
      </Card>
    </div>
  );
}
