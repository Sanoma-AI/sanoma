import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { Fact, Facts, GraphPanel, loadGraph, Nothing, PageHeader, Section } from "../../components/common.tsx";
import { RunButton, WorkflowSections } from "../../components/workflow.tsx";
import { outlineGraph } from "../../graph/outline-graph.ts";
import { configQuery } from "../../queries.ts";

export const Route = createFileRoute("/workflows/")({
  // The root route loads the config.
  loader: () => {
    if (!import.meta.env.SSR) void loadGraph();
  },
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data: config } = useSuspenseQuery(configQuery());
  return (
    <div className="flex flex-col gap-6">
      <PageHeader />
      <Card size="sm">
        <CardContent>
          <Facts>
            <Fact label="App">{config.appName}</Fact>
            <Fact label="Version">
              <code>{config.version}</code>
            </Fact>
            <Fact label="Policy">
              {config.policy.defined ? (
                <>
                  a policy checks every operation call
                  {config.policy.version ? (
                    <>
                      {" "}
                      (version <code>{config.policy.version}</code>)
                    </>
                  ) : (
                    " (no version named)"
                  )}
                </>
              ) : (
                "allowAll: every operation call is allowed"
              )}
            </Fact>
          </Facts>
        </CardContent>
      </Card>
      {config.workflows.length === 0 && <Nothing title="This config has no workflows" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {config.workflows.map((wf) => (
          <WorkflowCard key={wf.name} workflow={wf} />
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowEntry }) {
  const { outline } = workflow;
  const graph = useMemo(() => ("nodes" in outline ? outlineGraph(outline.nodes) : undefined), [outline]);
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          <Link to="/workflows/$name" params={{ name: workflow.name }} className="hover:underline">
            {workflow.title ?? workflow.name}
          </Link>
        </CardTitle>
        <CardDescription className="flex items-center gap-2">
          <code>{workflow.name}</code>
          {workflow.builtin && <Badge variant="secondary">built-in</Badge>}
        </CardDescription>
        <CardAction>
          <RunButton name={workflow.name} variant="outline" size="sm" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Section title="Outline">
          <p className="text-muted-foreground">
            {"error" in outline
              ? outline.error
              : "Read from the body of run; the functions it calls are not shown, even those defined in it"}
          </p>
          {graph && <GraphPanel graph={graph} show="start" />}
        </Section>
        <Separator />
        <WorkflowSections workflow={workflow} />
      </CardContent>
    </Card>
  );
}
