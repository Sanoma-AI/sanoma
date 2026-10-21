import type { WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { FlaskConicalIcon, GlobeIcon } from "lucide-react";
import { useMemo } from "react";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { StartForm } from "../form/start-form.tsx";
import { WillAsk } from "../form/will-ask.tsx";
import { configQuery, scenariosFor, scenariosQuery, vendorsOf } from "../queries.ts";
import { Disclosure, Nothing, Notice, Segment, Segmented } from "./common.tsx";

/**
 * A new run of the workflow, live or in the sandbox: its input from its schema, or a scenario's,
 * which the scenario's run takes from the scenario, and what the policy will ask (`WillAsk`). On either pane of the workflow's page, in the
 * inspector while `?new` is set; `?scenario=` picks Sandbox and the scenario.
 */
export function NewRun({ workflow }: { workflow: WorkflowEntry }) {
  const { name } = workflow;
  // Only `?scenario=`: a click on the panel's runs filter does not draw the form again.
  const wanted = useSearch({ from: "/workflows/$name", select: (search) => search.scenario });
  const navigate = useNavigate();
  const forWorkflow = useMemo(() => scenariosFor(name), [name]);
  const {
    data: { scenarios },
  } = useSuspenseQuery({ ...scenariosQuery(), select: forWorkflow });
  const sandbox = wanted !== undefined;
  const scenario = scenarios.find((s) => s.name === wanted);
  const none = scenarios.length === 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {/* Each mode is a URL on the pane that shows. A choice replaces the page in the history
            rather than adding one, and keeps `?new` and `?runs=`. */}
        <Segmented label="Mode">
          <Segment>
            <Link to="." search={(prev) => ({ ...prev, scenario: undefined })} activeOptions={{ exact: true }} replace>
              <GlobeIcon data-icon="inline-start" />
              Live vendors
            </Link>
          </Segment>
          <Segment>
            {/* Keeps the scenario chosen, so it is the current page whichever that is. */}
            <Link
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
            void navigate({ to: ".", search: (prev) => ({ ...prev, scenario: e.target.value }), replace: true })
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
              Nothing leaves Sanoma: the scenario supplies the input and the fakes answer the calls. Its approvals wait
              for people, as a live run’s do.
            </Notice>
          ) : (
            <VendorsNotice name={name} />
          )}
          <WillAsk workflow={workflow} />
          {/* Keyed: the form builds its defaults once per mount. */}
          <StartForm key={scenario?.name ?? "live"} workflow={workflow} scenario={scenario} />
          {scenario && (
            <Disclosure label="Scenario">
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{scenario.text}</pre>
            </Disclosure>
          )}
        </>
      )}
    </>
  );
}

/** What a live run calls for real: the vendors of the workflow's operations, by title. None, no notice. */
function VendorsNotice({ name }: { name: string }) {
  const select = useMemo(() => vendorsOf(name), [name]);
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select });
  if (vendors.length === 0) return null;
  return <Notice>Calls {vendors.map((v) => v.title).join(", ")} for real</Notice>;
}
