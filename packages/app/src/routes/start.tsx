import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Nothing, Notice, PageHeader } from "../components/common.tsx";
import { StartForm } from "../form/start-form.tsx";
import { configQuery } from "../queries.ts";

export const Route = createFileRoute("/start")({
  validateSearch: z.object({ workflow: z.string().optional() }),
  loader: ({ context }) => context.queryClient.ensureQueryData(configQuery()),
  head: () => ({ meta: [{ title: "Start a run · Sanoma" }] }),
  component: StartPage,
});

function StartPage() {
  const { workflow: wanted } = Route.useSearch();
  const navigate = useNavigate();
  const { data: config } = useSuspenseQuery(configQuery());

  if (config.workflows.length === 0) return <Nothing title="This config has no workflows" />;
  const name = wanted ?? config.workflows[0]?.name;
  const workflow = config.workflows.find((w) => w.name === name);

  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <PageHeader title="Start a run" />
      <Field>
        <FieldLabel htmlFor="workflow">Workflow</FieldLabel>
        <Select
          name="workflow"
          value={workflow ? workflow.name : ""}
          onValueChange={(value) => void navigate({ to: "/start", search: { workflow: value } })}
        >
          <SelectTrigger id="workflow" className="w-full">
            <SelectValue placeholder="Choose a workflow" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {config.workflows.map((w) => (
                <SelectItem key={w.name} value={w.name}>
                  {w.title ? `${w.title} (${w.name})` : w.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {!workflow && name && <Notice tone="bad">No workflow named “{name}”.</Notice>}
      {workflow && (
        <Card>
          <CardHeader>
            <CardTitle>{workflow.title ?? workflow.name}</CardTitle>
            <CardDescription>Its input, checked against the workflow's schema before the run starts.</CardDescription>
          </CardHeader>
          <CardContent>
            <StartForm key={workflow.name} workflow={workflow} />
          </CardContent>
        </Card>
      )}
    </section>
  );
}
