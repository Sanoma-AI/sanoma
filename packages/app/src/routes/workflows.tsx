import type { OpEntry, WorkflowEntry } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import {
  effectBadge,
  Fact,
  Facts,
  Json,
  Nothing,
  PageHeader,
  SectionTitle,
  SubsectionTitle,
} from "../components/common.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { configQuery } from "../queries.ts";

export const Route = createFileRoute("/workflows")({
  loader: ({ context }) => context.queryClient.ensureQueryData(configQuery()),
  head: () => ({ meta: [{ title: "Workflows · Sanoma" }] }),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data: config } = useSuspenseQuery(configQuery());
  const ops = new Map(config.ops.map((op) => [op.id, op]));
  return (
    <section className="flex flex-col gap-6">
      <PageHeader title="Workflows" />
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
      {config.workflows.length === 0 && <Nothing title="This config has no workflows" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {config.workflows.map((wf) => (
          <WorkflowCard key={wf.name} workflow={wf} ops={ops} />
        ))}
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SubsectionTitle>{title}</SubsectionTitle>
      {children}
    </section>
  );
}

const None = () => <p className="text-muted-foreground">None.</p>;

function WorkflowCard({ workflow, ops }: { workflow: WorkflowEntry; ops: Map<string, OpEntry> }) {
  const fields = fieldsOf(workflow.input);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <SectionTitle>{workflow.title ?? workflow.name}</SectionTitle>
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
        <Section title="Operations it may call">
          {workflow.ops.length === 0 ? (
            <None />
          ) : (
            <ItemGroup className="gap-2">
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
              <p className="text-muted-foreground">No fields.</p>
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
          <code>{id}</code>
          {op && <Badge className={effectBadge({ effect: op.effect })}>{op.effect}</Badge>}
          {op?.idempotent && (
            <Badge variant="outline" title="Safe to retry: the vendor dedupes repeated calls">
              idempotent
            </Badge>
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
    <ul className="flex flex-col gap-2">
      {fields.map((field) => (
        <li key={field.key} className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <code>{field.key}</code>
            <span className="text-muted-foreground">{kindName(field)}</span>
            {field.required && <Badge variant="outline">required</Badge>}
            {field.default !== undefined && (
              <span className="text-muted-foreground">default {JSON.stringify(field.default)}</span>
            )}
          </span>
          {field.description && <span className="text-muted-foreground">{field.description}</span>}
          {field.kind === "object" && (
            <div className="border-l pl-3">
              <InputFields fields={field.fields} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
