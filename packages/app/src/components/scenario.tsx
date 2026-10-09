import type { Check } from "@sanoma/workflows/scenario";
import { errorMessage } from "@sanoma/workflows/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckIcon, CircleDashedIcon, FlaskConicalIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "#/components/ui/item.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { errorBodyOf, type ScenarioEntry } from "../api.ts";
import { startRunFn } from "../functions.ts";
import { RUNS_KEY } from "../queries.ts";
import { Section } from "./common.tsx";

// A workflow's scenarios, as its page offers them, and a sandbox run's checks, as its page shows them.

/** One of the workflow's scenarios to try, or none: the page keeps the choice in its URL. */
export function ScenarioPicker({
  scenarios,
  value,
  onChange,
}: {
  scenarios: ScenarioEntry[];
  /** The chosen scenario's name, when it is one of `scenarios`. */
  value: string | undefined;
  onChange: (name: string) => void;
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label="Scenario"
      value={value ?? ""}
      disabled={scenarios.length === 0}
      onChange={(e) => onChange(e.target.value)}
    >
      {value === undefined && (
        <NativeSelectOption value="" disabled>
          {scenarios.length ? "Choose a scenario" : "No scenarios"}
        </NativeSelectOption>
      )}
      {scenarios.map((s) => (
        <NativeSelectOption key={s.name} value={s.name}>
          {s.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/**
 * Starts a sandbox run of the scenario, then opens it, as the start form does a run. Its
 * approvals wait for people, as a live run's do.
 */
export function TestButton({ scenario }: { scenario: string | undefined }) {
  const start = useServerFn(startRunFn);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (name: string) => start({ data: { scenario: name } }),
    onSuccess: async ({ runId }, name) => {
      toast.success(`Started a sandbox run of “${name}”`);
      // The lists show the new run at once, not at their next poll.
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      await navigate({ to: "/runs/$id", params: { id: runId } });
    },
    onError: (err) => {
      // Not the server's answer (the network, a bug): keep the raw value for whoever debugs it.
      if (!errorBodyOf(err)) console.error("sanoma app: starting the sandbox run failed:", err);
      toast.error(errorMessage(err).trim() || "Could not start the sandbox run, and no reason was given");
    },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={scenario === undefined || mutation.isPending}
      onClick={() => scenario !== undefined && mutation.mutate(scenario)}
    >
      {mutation.isPending ? <Spinner data-icon="inline-start" /> : <FlaskConicalIcon data-icon="inline-start" />}
      Test
    </Button>
  );
}

/** A scenario as its feature file says it, and which file that is. */
export function ScenarioCard({ scenario }: { scenario: ScenarioEntry }) {
  return (
    <Card>
      <CardContent>
        <Section title={scenario.name}>
          <p className="text-muted-foreground">
            From <code>{scenario.file}</code>
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{scenario.text}</pre>
        </Section>
      </CardContent>
    </Card>
  );
}

/**
 * A sandbox run's checks: each expectation of its scenario, met or not. Until the run ends, one
 * not met yet is shown as still to come rather than failed.
 */
export function Checks({ checks, ended }: { checks: Check[]; ended: boolean }) {
  return (
    <ItemGroup aria-label="Checks">
      {checks.map((c, i) => (
        <Item key={i} role="listitem" variant="outline" size="xs">
          <ItemMedia variant="icon">
            {c.ok ? (
              <CheckIcon aria-label="met" className="text-tone-ok-foreground" />
            ) : ended ? (
              <XIcon aria-label="not met" className="text-destructive" />
            ) : (
              <CircleDashedIcon aria-label="not yet" className="text-muted-foreground" />
            )}
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{c.step}</ItemTitle>
            {c.detail && <ItemDescription>{c.detail}</ItemDescription>}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}
