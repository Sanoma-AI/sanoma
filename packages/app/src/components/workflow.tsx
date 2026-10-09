import type { Outline, OpEntry, WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { graphOf } from "../graph/run-graph.ts";
import { type GraphNode, type GraphSource, nodeAt } from "../graph/types.ts";
import { configQuery, opsById, sourceQuery } from "../queries.ts";
import { ApprovalIcon, SleepIcon } from "./approval.tsx";
import type { CodeProps } from "./code.tsx";
import { CodePanel, GraphPanel, Json, Nothing, OpName, SubsectionTitle, Tip } from "./common.tsx";

// A workflow's pieces, as the workflows page's cards and a workflow's own page show them, and
// its graph beside its source, as a workflow's page and a run's show them.

/** The Start page, with the workflow chosen. */
export function StartButton({ name }: { name: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/start" search={{ workflow: name }}>
        <PlayIcon data-icon="inline-start" />
        Start
      </Link>
    </Button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SubsectionTitle>{title}</SubsectionTitle>
      {children}
    </div>
  );
}

export const None = ({ children = "None." }: { children?: ReactNode }) => (
  <p className="text-muted-foreground">{children}</p>
);

/** What a workflow may call, the built-ins it uses and its input, one section each. */
export function WorkflowSections({ workflow }: { workflow: WorkflowEntry }) {
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const fields = fieldsOf(workflow.input);
  return (
    <>
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
                {b === "approval" && <ApprovalIcon data-icon="inline-start" />}
                {b === "sleep" && <SleepIcon data-icon="inline-start" />}
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
    </>
  );
}

function OpItem({ id, op }: { id: string; op: OpEntry | undefined }) {
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemTitle>
          <OpName id={id} op={op} />
          {op?.idempotent && (
            <Tip tip="If a call fails, it is tried again; the vendor ignores repeats.">
              <Badge variant="outline" tabIndex={0}>
                safe to retry
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

/** The height of a graph and its source side by side. */
const PANEL = "h-[360px] sm:h-[420px]";

/**
 * A workflow's graph, or a run's, beside the workflow's source. A click on a node, or in the
 * code, selects the node: the graph rings it and the code marks the lines it may stand for.
 * `onSelect` is told of each node selected, after. Where the outline could not be read, its
 * error shows in place of the code.
 */
export function GraphAndSource({
  name,
  outline,
  source,
  show,
  onSelect,
}: {
  name: string;
  outline: Outline;
  source: GraphSource;
  show?: "start" | "end";
  onSelect?: (node: GraphNode) => void;
}) {
  const [selected, setSelected] = useState<GraphNode>();
  // The graph's nodes, here too: a click in the code finds its node without the graph's chunk.
  const nodes = useMemo(() => graphOf(source).nodes, [source]);
  const select = (node: GraphNode | undefined) => {
    setSelected(node);
    if (node) onSelect?.(node);
  };
  return (
    <div className="flex flex-col gap-2">
      {"fallback" in outline && <None>Showing the function's text, not the file: {outline.fallback}</None>}
      <div className="grid gap-4 lg:grid-cols-2">
        <GraphPanel className={PANEL} source={source} show={show} selected={selected?.id} onSelect={select} />
        {"error" in outline ? (
          <Nothing title="No source to show">{outline.error}</Nothing>
        ) : (
          <SourcePanel
            name={name}
            highlight={selected && "spans" in selected ? selected.spans : undefined}
            onSelect={(offset) => select(nodeAt(nodes, offset))}
          />
        )}
      </div>
    </div>
  );
}

function SourcePanel({ name, ...props }: { name: string } & Pick<CodeProps, "highlight" | "onSelect">) {
  const { data } = useSuspenseQuery(sourceQuery(name));
  return <CodePanel className={PANEL} source={data.source} {...props} />;
}
