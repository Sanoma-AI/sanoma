import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { loadCode, loadGraph, Nothing, Notice, PageHeader, pageTitle } from "../../components/common.tsx";
import { ScenarioCard, ScenarioErrors, TestControl } from "../../components/scenario.tsx";
import { GraphAndSource, StartButton, WorkflowSections } from "../../components/workflow.tsx";
import { configQuery, scenariosFor, scenariosQuery, sourceQuery, workflowFile, workflowNamed } from "../../queries.ts";

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
    const file = workflowFile(workflow);
    await Promise.all([
      file !== undefined && queryClient.query({ ...sourceQuery(file), staleTime: "static" }),
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
            <TestControl
              scenarios={scenarios}
              value={scenario?.name}
              // Choosing another scenario replaces the page in the history rather than adding one.
              onChange={(chosen) => void navigate({ search: { scenario: chosen }, replace: true })}
            />
            <StartButton name={workflow.name} />
          </div>
        }
      >
        <code className="text-muted-foreground">{workflow.name}</code>
        {workflow.builtin && <Badge variant="secondary">built-in</Badge>}
      </PageHeader>
      <ScenarioErrors errors={errors} />
      <GraphAndSource key={name} workflow={workflow} scenario={scenario} />
      {wanted !== undefined &&
        (scenario ? (
          <ScenarioCard scenario={scenario} />
        ) : (
          <Nothing title={`No scenario named “${wanted}”`}>
            This workflow’s scenarios are in the menu beside Test, above.
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
