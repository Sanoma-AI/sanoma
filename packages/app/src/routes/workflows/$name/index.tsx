import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { ScenarioErrors } from "#/components/scenario.tsx";
import { WorkflowView } from "#/components/workflow-view.tsx";
import { Retired } from "#/components/workflow.tsx";
import { scenariosFor, scenariosQuery, useWorkflow } from "#/queries.ts";

/**
 * A workflow's own pane: its graph (marked with the scenario `?scenario=` names), About in the
 * inspector, or New run with `?new`, and its source. The layout loads all of it and titles the
 * tab. A retired workflow has none of it.
 */
export const Route = createFileRoute("/workflows/$name/")({
  component: WorkflowPane,
});

function WorkflowPane() {
  const { name } = Route.useParams();
  // Only `?scenario=`: a click on the rail's filter does not draw the pane again.
  const wanted = Route.useSearch({ select: (search) => search.scenario });
  const workflow = useWorkflow(name);
  const forWorkflow = useMemo(() => scenariosFor(name), [name]);
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: forWorkflow });
  if (!workflow) return <Retired name={name} />;
  const scenario = scenarios.find((s) => s.name === wanted);
  return (
    <WorkflowView key={name} name={name} workflow={workflow} scenario={scenario}>
      <ScenarioErrors errors={errors} />
    </WorkflowView>
  );
}
