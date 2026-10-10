import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { pageTitle } from "#/components/common.tsx";
import { Retired } from "#/components/workflow.tsx";
import { StartForm } from "#/form/start-form.tsx";
import { useWorkflow } from "#/queries.ts";

/** A new run of the workflow: its input, from its schema. A retired workflow has none to start. */
export const Route = createFileRoute("/workflows/$name/new")({
  staticData: { crumb: "New run" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: NewRunPage,
});

function NewRunPage() {
  const { name } = Route.useParams();
  const workflow = useWorkflow(name);
  if (!workflow) return <Retired name={name} />;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The input, checked against the workflow's schema before the run starts.
      </p>
      <Card>
        <CardContent>
          <StartForm key={workflow.name} workflow={workflow} />
        </CardContent>
      </Card>
    </div>
  );
}
