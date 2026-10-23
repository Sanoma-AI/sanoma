import { Link, type NavigateOptions } from "@tanstack/react-router";
import { FlaskIcon } from "@phosphor-icons/react/dist/csr/Flask";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { cn } from "#/lib/utils.ts";
import type { ScenarioEntry, ScenariosResponse } from "../api.ts";
import {
  ButtonLink,
  CardHeading,
  FLOAT,
  FLOAT_CARD,
  FLOAT_ROOM,
  FloatingCard,
  Nothing,
  Notice,
  plural,
} from "./common.tsx";
import { LinkRow } from "./runs-table.tsx";

// A workflow's scenarios, as its page's Scenarios tab lists them, and why a feature file could
// not be read, on every page that lists scenarios.

/** Why each feature file that could not be read could not, from `scenariosQuery`'s `errors`. */
export function ScenarioErrors({ errors }: Pick<ScenariosResponse, "errors">) {
  return errors.map((e) => (
    <Notice key={`${e.file}:${e.message}`} variant="destructive">
      {/* A step no rule matches lists the known steps, one a line. */}
      <span className="whitespace-pre-wrap">Could not read a scenario: {e.message}</span>
    </Notice>
  ));
}

/**
 * The Scenarios tab: one card, a row per scenario of the workflow, each opening it (`?scenario=`,
 * which also marks the graph and is New run's Sandbox mode) over the card's right.
 */
export function Scenarios({ scenarios, open }: { scenarios: ScenarioEntry[]; open: ScenarioEntry | undefined }) {
  return (
    <Card className={cn(FLOAT_CARD, "min-h-(--pane-tall) gap-0 py-0")}>
      <div className={cn("flex flex-1 flex-col", open && FLOAT_ROOM)}>
        {scenarios.length === 0 ? (
          <Nothing className="border-0" title="No scenarios for this workflow yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scenario</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Steps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scenarios.map((s) => {
                const opens: NavigateOptions = { to: ".", search: (prev) => ({ ...prev, scenario: s.name }) };
                return (
                  <LinkRow key={s.name} link={opens} selected={s.name === open?.name}>
                    <TableCell className="font-medium">
                      <Link {...opens} onClick={(e) => e.stopPropagation()}>
                        {s.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <code>{s.file}</code>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{s.steps.length}</TableCell>
                  </LinkRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {open && <OpenScenario scenario={open} />}
    </Card>
  );
}

/**
 * The scenario open over the Scenarios tab: its file and text, a sandbox run of it (New run in
 * Sandbox mode, on the Graph), and the Graph marked with it.
 */
function OpenScenario({ scenario }: { scenario: ScenarioEntry }) {
  return (
    <FloatingCard role="region" aria-label={scenario.name} className={cn(FLOAT, "order-first gap-0 py-0")}>
      <CardHeader className="border-b py-3">
        <CardHeading>{scenario.name}</CardHeading>
        <CardDescription>
          <code>{scenario.file}</code> · {plural(scenario.steps.length, "step")}
        </CardDescription>
        <CardAction>
          <ButtonLink variant="ghost" size="icon-sm">
            <Link to="." search={(prev) => ({ ...prev, scenario: undefined })}>
              <XIcon aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Link>
          </ButtonLink>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto py-(--card-spacing)">
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{scenario.text}</pre>
      </CardContent>
      <CardFooter className="flex-wrap gap-2 border-t py-3">
        <ButtonLink size="sm">
          <Link to="." search={(prev) => ({ ...prev, view: undefined, new: true })}>
            <FlaskIcon aria-hidden="true" data-icon="inline-start" />
            Sandbox run
          </Link>
        </ButtonLink>
        <ButtonLink variant="outline" size="sm">
          <Link to="." search={(prev) => ({ ...prev, view: undefined })}>
            Show on the graph
          </Link>
        </ButtonLink>
      </CardFooter>
    </FloatingCard>
  );
}
