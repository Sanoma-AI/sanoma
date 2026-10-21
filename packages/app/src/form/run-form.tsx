import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "#/components/ui/card.tsx";
import type { StartRunResponse } from "../api.ts";
import { CardHeading, Notice } from "../components/common.tsx";
import { runLink, useWorkflow } from "../queries.ts";
import { StartForm } from "./start-form.tsx";

/**
 * A site's form for starting a live run of the workflow named: the app's own start form, its
 * fields drawn from the workflow's input schema and the server's complaints shown on them, under
 * the workflow's title linking to its page. Once the run starts, the page stays and links to the
 * run. A name the config does not have is said in a notice.
 */
export function RunForm({ workflow }: { workflow: string }) {
  const entry = useWorkflow(workflow);
  const [started, setStarted] = useState<StartRunResponse>();
  if (!entry) {
    return <Notice variant="destructive">This company has no workflow named “{workflow}”.</Notice>;
  }
  return (
    <Card>
      <CardHeader>
        <CardHeading>
          <Link to="/workflows/$name" params={{ name: entry.name }} className="underline-offset-4 hover:underline">
            {entry.title ?? entry.name}
          </Link>
        </CardHeading>
        <CardDescription>Starts a live run of {entry.name}.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {started && (
          <Notice>
            Run started. <Link {...runLink(started)}>Open the run</Link>
          </Notice>
        )}
        <StartForm workflow={entry} onStarted={setStarted} />
      </CardContent>
    </Card>
  );
}
