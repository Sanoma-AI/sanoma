import { errorMessage } from "@sanoma/workflows/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDownIcon, FlaskConicalIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { Card, CardContent } from "#/components/ui/card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { errorBodyOf, type ScenarioEntry, type ScenariosResponse } from "../api.ts";
import { startRunFn } from "../functions.ts";
import { RUNS_KEY } from "../queries.ts";
import { Notice, Section } from "./common.tsx";

// A workflow's scenarios, as its page offers them: to choose and Test, and to read; and why a
// feature file could not be read, on every page that lists scenarios.

/**
 * Test, split in two. The menu chooses one of the workflow's scenarios (the page keeps the choice
 * in its URL, so its graph and the scenario's card show it before anything runs); the button
 * starts a sandbox run of the chosen one, then opens it, as the start form does a run, or opens
 * the menu when none is chosen (which says so when the workflow has no scenarios). A sandbox
 * run's approvals wait for people, as a live run's do.
 */
export function TestControl({
  scenarios,
  value,
  onChange,
}: {
  scenarios: ScenarioEntry[];
  /** The chosen scenario's name, when it is one of `scenarios`. */
  value: string | undefined;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ButtonGroup aria-label="Test a scenario">
        <Button
          size="sm"
          variant="outline"
          disabled={mutation.isPending}
          // With none chosen, Test opens the menu, and says so.
          aria-haspopup={value === undefined ? "menu" : undefined}
          aria-expanded={value === undefined ? open : undefined}
          onClick={() => (value === undefined ? setOpen(true) : mutation.mutate(value))}
        >
          {mutation.isPending ? <Spinner data-icon="inline-start" /> : <FlaskConicalIcon data-icon="inline-start" />}
          {value === undefined ? "Test" : `Test “${value}”`}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="outline" aria-label="Scenario">
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
      </ButtonGroup>
      <DropdownMenuContent align="end" className="w-auto max-w-80">
        {/* With none, the menu says so: Test, and the arrow, still open it. */}
        {scenarios.length === 0 ? (
          <DropdownMenuLabel>No scenarios for this workflow</DropdownMenuLabel>
        ) : (
          <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
            {scenarios.map((s) => (
              <DropdownMenuRadioItem key={s.name} value={s.name}>
                {s.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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

/** Why each feature file that could not be read could not, from `scenariosQuery`'s `errors`. */
export function ScenarioErrors({ errors }: Pick<ScenariosResponse, "errors">) {
  return errors.map((e) => (
    <Notice key={`${e.file}:${e.message}`} variant="destructive">
      {/* A step no rule matches lists the known steps, one a line. */}
      <span className="whitespace-pre-wrap">Could not read a scenario: {e.message}</span>
    </Notice>
  ));
}
