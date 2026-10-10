import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { Nothing } from "#/components/common.tsx";
import { ScenarioCard, ScenarioErrors, TestControl } from "#/components/scenario.tsx";
import { GraphAndSource, Retired, WorkflowSections } from "#/components/workflow.tsx";
import { scenariosFor, scenariosQuery, useWorkflow } from "#/queries.ts";

/** A workflow's About: its graph beside its source, its scenarios, and what it may call. The layout loads all of it. */
export const Route = createFileRoute("/workflows/$name/")({
  // `?scenario=` names the scenario shown, marked on the graph, and tried by Test.
  validateSearch: z.object({ scenario: z.string().optional().catch(undefined) }),
  component: AboutPage,
});

function AboutPage() {
  const { name } = Route.useParams();
  const { scenario: wanted } = Route.useSearch();
  const navigate = Route.useNavigate();
  const workflow = useWorkflow(name);
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: scenariosFor(name) });
  if (!workflow) return <Retired name={name} />;
  const scenario = scenarios.find((s) => s.name === wanted);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <TestControl
          scenarios={scenarios}
          value={scenario?.name}
          // Choosing another scenario replaces the page in the history rather than adding one.
          onChange={(chosen) => void navigate({ search: (prev) => ({ ...prev, scenario: chosen }), replace: true })}
        />
      </div>
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
