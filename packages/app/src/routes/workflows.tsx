import type { OpEntry, WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import {
  Fact,
  Facts,
  GraphPanel,
  Json,
  loadGraph,
  Nothing,
  OpName,
  PageHeader,
  pageTitle,
  SubsectionTitle,
  Tip,
} from "../components/common.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { configQuery, opsById } from "../queries.ts";

export const Route = createFileRoute("/workflows")({
  // The root route loads the config.
  loader: () => {
    if (!import.meta.env.SSR) void loadGraph();
  },
  staticData: { crumb: "Workflows" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data: config } = useSuspenseQuery(configQuery());
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
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
          <WorkflowCard key={wf.name} workflow={wf} ops={ops} />
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SubsectionTitle>{title}</SubsectionTitle>
      {children}
    </div>
  );
}

const None = ({ children = "None." }: { children?: ReactNode }) => <p className="text-muted-foreground">{children}</p>;

function WorkflowCard({ workflow, ops }: { workflow: WorkflowEntry; ops: Map<string, OpEntry> }) {
  const fields = fieldsOf(workflow.input);
  const { outline } = workflow;
  const source = useMemo(() => ("nodes" in outline ? { outline: outline.nodes } : undefined), [outline]);
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {workflow.title ?? workflow.name}
        </CardTitle>
        <CardDescription>
          <code>{workflow.name}</code>
        </CardDescription>
        <CardAction>
          <Button asChild variant="outline" size="sm">
            <Link to="/start" search={{ workflow: workflow.name }}>
              <PlayIcon data-icon="inline-start" />
              Start
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Section title="Outline">
          <p className="text-muted-foreground">
            {"error" in outline
              ? outline.error
              : "Read from the body of run; the functions it calls are not shown, even those defined in it"}
          </p>
          {source && <GraphPanel source={source} show="start" />}
        </Section>
        <Separator />
        <Section title="Operations it may call">
          {workflow.ops.length === 0 ? (
            <None />
          ) : (
            <ItemGroup>
              {workflow.ops.map((id) => (
                <OpItem key={id} id={id} op={ops.get(id)} />
              ))}
            </ItemGroup>
          )}
        </Section>
        <Separator />
        <Section title="Built-ins">
          {workflow.builtins.length ? (
            <div className="flex flex-wrap gap-1.5">
              {workflow.builtins.map((b) => (
                <Badge key={b} variant="outline">
                  {b}
                </Badge>
              ))}
            </div>
          ) : (
            <None />
          )}
        </Section>
        <Separator />
        <Section title="Input">
          {fields ? (
            fields.length === 0 ? (
              <None>No fields.</None>
            ) : (
              <InputFields fields={fields} />
            )
          ) : (
            <Json value={workflow.input} />
          )}
        </Section>
      </CardContent>
    </Card>
  );
}

function OpItem({ id, op }: { id: string; op: OpEntry | undefined }) {
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemTitle>
          <OpName id={id} effect={op?.effect} />
          {op?.idempotent && (
            <Tip tip="Safe to retry: the vendor dedupes repeated calls">
              <Badge variant="outline" tabIndex={0}>
                idempotent
              </Badge>
            </Tip>
          )}
        </ItemTitle>
        {op?.description && <ItemDescription>{op.description}</ItemDescription>}
      </ItemContent>
    </Item>
  );
}

const kindName = (f: Field): string =>
  f.kind === "array" ? `list of ${kindName(f.item)}` : f.kind === "json" ? "JSON" : f.kind;

function InputFields({ fields }: { fields: Field[] }) {
  return (
    <ItemGroup>
      {fields.map((field) => (
        <Item key={field.key} role="listitem" variant="outline" size="xs">
          <ItemContent>
            <ItemTitle>
              <code>{field.key}</code>
              <span className="font-normal text-muted-foreground">{kindName(field)}</span>
              {field.required && <Badge variant="outline">required</Badge>}
            </ItemTitle>
            {(field.description || field.default !== undefined) && (
              <ItemDescription>
                {[field.description, field.default !== undefined && `default ${JSON.stringify(field.default)}`]
                  .filter(Boolean)
                  .join(" · ")}
              </ItemDescription>
            )}
            {field.kind === "object" && <InputFields fields={field.fields} />}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}
