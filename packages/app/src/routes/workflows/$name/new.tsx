import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FlaskConicalIcon, GlobeIcon } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Disclosure, Nothing, Notice, pageTitle } from "#/components/common.tsx";
import { ScenarioCard, ScenarioErrors } from "#/components/scenario.tsx";
import { GraphAndSource, Retired } from "#/components/workflow.tsx";
import { StartForm } from "#/form/start-form.tsx";
import { configQuery, opsById, scenariosFor, scenariosQuery, useWorkflow } from "#/queries.ts";

/**
 * A new run of the workflow, live or in the sandbox: its input from its schema, or a scenario's,
 * which the scenario's run takes from the scenario. The layout loads all of it. A retired
 * workflow has none to start.
 */
export const Route = createFileRoute("/workflows/$name/new")({
  // `?scenario=` is Sandbox mode and the scenario it runs; without it, Live. In the URL, so the
  // server renders the mode the link asks for.
  validateSearch: z.object({ scenario: z.string().optional().catch(undefined) }),
  staticData: { crumb: "New run" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: NewRunPage,
});

function NewRunPage() {
  const { name } = Route.useParams();
  const { scenario: wanted } = Route.useSearch();
  const navigate = Route.useNavigate();
  const workflow = useWorkflow(name);
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: scenariosFor(name) });
  if (!workflow) return <Retired name={name} />;
  const sandbox = wanted !== undefined;
  const scenario = sandbox ? scenarios.find((s) => s.name === wanted) : undefined;
  // Each choice replaces the page in the history rather than adding one; `?runs=` stays.
  const choose = (chosen: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, scenario: chosen }), replace: true });

  return (
    <div className="flex flex-col gap-6">
      <ScenarioErrors errors={errors} />
      <div className="grid gap-6 lg:grid-cols-2">
        <GraphAndSource key={name} workflow={workflow} scenario={scenario} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <ButtonGroup aria-label="Mode">
                <Button
                  type="button"
                  size="sm"
                  variant={sandbox ? "outline" : "secondary"}
                  aria-pressed={!sandbox}
                  onClick={() => choose(undefined)}
                >
                  <GlobeIcon data-icon="inline-start" />
                  Live vendors
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={sandbox ? "secondary" : "outline"}
                  aria-pressed={sandbox}
                  disabled={scenarios.length === 0}
                  onClick={() => choose(scenarios[0]?.name)}
                >
                  <FlaskConicalIcon data-icon="inline-start" />
                  Sandbox
                </Button>
              </ButtonGroup>
              {scenarios.length === 0 && (
                <p className="text-sm text-muted-foreground">No scenarios for this workflow yet</p>
              )}
            </div>
            {!sandbox ? (
              <>
                <VendorsNotice workflow={workflow} />
                <StartForm key="live" workflow={workflow} />
              </>
            ) : (
              <>
                {scenarios.length > 0 && (
                  <NativeSelect
                    aria-label="Scenario"
                    className="w-full"
                    value={scenario?.name ?? ""}
                    onChange={(e) => choose(e.target.value)}
                  >
                    {!scenario && (
                      <NativeSelectOption value="" disabled>
                        Choose a scenario
                      </NativeSelectOption>
                    )}
                    {scenarios.map((s) => (
                      <NativeSelectOption key={s.name} value={s.name}>
                        {s.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
                {scenario ? (
                  <>
                    <Notice>Nothing leaves Sanoma: the scenario supplies the input and answers the approvals</Notice>
                    <StartForm key={scenario.name} workflow={workflow} scenario={scenario} />
                    <Disclosure label="Scenario">
                      <ScenarioCard scenario={scenario} />
                    </Disclosure>
                  </>
                ) : (
                  <Nothing title={`No scenario named “${wanted}”`}>
                    {scenarios.length > 0 ? "Choose one of this workflow’s scenarios above." : undefined}
                  </Nothing>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** What a live run calls for real: the vendors of the workflow's operations, by title. None, no notice. */
function VendorsNotice({ workflow }: { workflow: WorkflowEntry }) {
  const { data: config } = useSuspenseQuery(configQuery());
  const titles = useMemo(() => {
    const ops = opsById(config);
    const vendors = workflow.ops.flatMap((id) => ops.get(id)?.vendor ?? []);
    return [...new Set(vendors.map((v) => config.vendors[v]?.title ?? v))].toSorted();
  }, [config, workflow.ops]);
  if (titles.length === 0) return null;
  return <Notice>Calls {titles.join(", ")} for real</Notice>;
}
