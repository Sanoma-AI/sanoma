import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { GraphAndSource, Retired, WorkflowSections } from "#/components/workflow.tsx";
import { useWorkflow } from "#/queries.ts";

/** A workflow's About: its graph beside its source, and what it may call. The layout loads all of it. */
export const Route = createFileRoute("/workflows/$name/")({
  component: AboutPage,
});

function AboutPage() {
  const { name } = Route.useParams();
  const workflow = useWorkflow(name);
  if (!workflow) return <Retired name={name} />;
  return (
    <div className="flex flex-col gap-6">
      <GraphAndSource key={name} workflow={workflow} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <WorkflowSections workflow={workflow} />
        </CardContent>
      </Card>
    </div>
  );
}
