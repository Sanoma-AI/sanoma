import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FlaskConicalIcon, GlobeIcon } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Disclosure, Nothing, Notice, pageTitle, Segment, Segmented } from "#/components/common.tsx";
import { ScenarioErrors } from "#/components/scenario.tsx";
import { GraphAndSource, Retired } from "#/components/workflow.tsx";
import { StartForm } from "#/form/start-form.tsx";
import { configQuery, scenariosFor, scenariosQuery, useWorkflow, vendorsOf, workflowNamed } from "#/queries.ts";

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
  // The tab names the workflow too, as the layout's crumb does: its title, else its name. The
  // root route has loaded the config.
  loader: async ({ context: { queryClient }, params }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    return { workflow: workflowNamed(params.name)(config)?.title ?? params.name };
  },
  head: ({ match, loaderData, params }) =>
    pageTitle(`${match.staticData.crumb} · ${loaderData?.workflow ?? params.name}`),
  component: NewRunPage,
});

function NewRunPage() {
  const { name } = Route.useParams();
  const { scenario: wanted } = Route.useSearch();
  const navigate = Route.useNavigate();
  const workflow = useWorkflow(name);
  const forWorkflow = useMemo(() => scenariosFor(name), [name]);
  const {
    data: { scenarios, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select: forWorkflow });
  if (!workflow) return <Retired name={name} />;
  const sandbox = wanted !== undefined;
  const scenario = scenarios.find((s) => s.name === wanted);
  const none = scenarios.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <ScenarioErrors errors={errors} />
      <div className="grid gap-6 lg:grid-cols-2">
        <GraphAndSource key={name} workflow={workflow} scenario={scenario} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {/* Each mode is a URL. A choice replaces the page in the history rather than adding
                  one, and keeps `?runs=`. */}
              <Segmented label="Mode">
                <Segment>
                  <Link
                    from={Route.fullPath}
                    to="."
                    search={(prev) => ({ ...prev, scenario: undefined })}
                    activeOptions={{ exact: true }}
                    replace
                  >
                    <GlobeIcon data-icon="inline-start" />
                    Live vendors
                  </Link>
                </Segment>
                <Segment>
                  {/* Keeps the scenario chosen, so it is the current page whichever that is. */}
                  <Link
                    from={Route.fullPath}
                    to="."
                    search={(prev) => ({ ...prev, scenario: prev.scenario ?? scenarios[0]?.name })}
                    disabled={none}
                    replace
                  >
                    <FlaskConicalIcon data-icon="inline-start" />
                    Sandbox
                  </Link>
                </Segment>
              </Segmented>
              {none && <p className="text-sm text-muted-foreground">No scenarios for this workflow yet</p>}
            </div>
            {sandbox && !none && (
              <NativeSelect
                aria-label="Scenario"
                className="w-full"
                value={scenario?.name ?? ""}
                onChange={(e) =>
                  void navigate({ search: (prev) => ({ ...prev, scenario: e.target.value }), replace: true })
                }
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
            {sandbox && !scenario ? (
              <Nothing title={`No scenario named “${wanted}”`}>
                {!none && "Choose one of this workflow’s scenarios above."}
              </Nothing>
            ) : (
              <>
                {scenario ? (
                  <Notice>
                    Nothing leaves Sanoma: the scenario supplies the input and the fakes answer the calls. Its approvals
                    wait for people, as a live run’s do.
                  </Notice>
                ) : (
                  <VendorsNotice name={name} />
                )}
                <StartForm key={scenario?.name ?? "live"} workflow={workflow} scenario={scenario} />
                {scenario && (
                  <Disclosure label="Scenario">
                    <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                      {scenario.text}
                    </pre>
                  </Disclosure>
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
function VendorsNotice({ name }: { name: string }) {
  const select = useMemo(() => vendorsOf(name), [name]);
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select });
  if (vendors.length === 0) return null;
  return <Notice>Calls {vendors.map((v) => v.title).join(", ")} for real</Notice>;
}
