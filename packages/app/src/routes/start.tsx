import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "#/components/ui/field.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Nothing, Notice, PageHeader } from "../components/common.tsx";
import { StartForm } from "../form/start-form.tsx";
import { configQuery } from "../queries.ts";

export const Route = createFileRoute("/start")({
  validateSearch: z.object({ workflow: z.string().optional() }),
  head: () => ({ meta: [{ title: "Start a run · Sanoma" }] }),
  component: StartPage,
});

function StartPage() {
  const { workflow: wanted } = Route.useSearch();
  const navigate = useNavigate();
  const { data: config } = useSuspenseQuery(configQuery());

  const name = wanted ?? config.workflows[0]?.name;
  const workflow = config.workflows.find((w) => w.name === name);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader title="Start a run" />
      {config.workflows.length === 0 ? (
        <Nothing title="This config has no workflows" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{workflow?.title ?? workflow?.name ?? "Choose a workflow"}</CardTitle>
            <CardDescription>Its input, checked against the workflow's schema before the run starts.</CardDescription>
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
                  onChange={(e) => void navigate({ to: "/start", search: { workflow: e.target.value } })}
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
              {!workflow && name && <Notice variant="destructive">No workflow named “{name}”.</Notice>}
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
