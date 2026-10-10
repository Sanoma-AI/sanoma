import { Card, CardContent } from "#/components/ui/card.tsx";
import type { ScenarioEntry, ScenariosResponse } from "../api.ts";
import { Notice, Section } from "./common.tsx";

// A workflow's scenarios, as the New run pane shows them, and why a feature file could not be
// read, on every page that lists scenarios.

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
