import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Notice } from "../components/common.tsx";
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

  if (config.workflows.length === 0) return <Notice>This config has no workflows.</Notice>;
  const name = wanted ?? config.workflows[0]?.name;
  const workflow = config.workflows.find((w) => w.name === name);

  return (
    <section>
      <header className="page-head">
        <h1>Start a run</h1>
      </header>
      <label className="field">
        <span className="label">Workflow</span>
        <select
          value={workflow ? workflow.name : ""}
          onChange={(e) => void navigate({ to: "/start", search: { workflow: e.target.value } })}
        >
          {!workflow && <option value="">Choose a workflow</option>}
          {config.workflows.map((w) => (
            <option key={w.name} value={w.name}>
              {w.title ? `${w.title} (${w.name})` : w.name}
            </option>
          ))}
        </select>
      </label>
      {!workflow && name && <Notice tone="bad">No workflow named “{name}”.</Notice>}
      {workflow && <StartForm key={workflow.name} workflow={workflow} />}
    </section>
  );
}
