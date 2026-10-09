import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "#/components/ui/field.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Nothing, Notice, PageHeader, pageTitle } from "../components/common.tsx";
import { StartForm } from "../form/start-form.tsx";
import { configQuery, workflowNamed } from "../queries.ts";

export const Route = createFileRoute("/start")({
  validateSearch: z.object({ workflow: z.string().optional() }),
  staticData: { crumb: "Start a run" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: StartPage,
});

function StartPage() {
  const { workflow: wanted } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: config } = useSuspenseQuery(configQuery());

  const workflow = wanted === undefined ? config.workflows[0] : workflowNamed(wanted)(config);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader />
      {config.workflows.length === 0 ? (
        <Nothing title="This config has no workflows" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Input</CardTitle>
            <CardDescription>
              The workflow and its input, checked against its schema before the run starts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workflow">Workflow</FieldLabel>
                <NativeSelect
                  id="workflow"
                  name="workflow"
                  className="w-full"
                  value={workflow ? workflow.name : ""}
                  // Choosing another workflow replaces the page in the history rather than adding one.
                  onChange={(e) => void navigate({ search: { workflow: e.target.value }, replace: true })}
                >
                  {!workflow && (
                    <NativeSelectOption value="" disabled>
                      Choose a workflow
                    </NativeSelectOption>
                  )}
                  {config.workflows.map((w) => (
                    <NativeSelectOption key={w.name} value={w.name}>
                      {w.title ? `${w.title} (${w.name})` : w.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {!workflow && wanted && <Notice variant="destructive">No workflow named “{wanted}”.</Notice>}
              {workflow && (
                <>
                  <FieldSeparator />
                  <StartForm key={workflow.name} workflow={workflow} />
                </>
              )}
            </FieldGroup>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
