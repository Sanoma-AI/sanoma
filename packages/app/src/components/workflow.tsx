import type { LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { OpEntry, WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { outlineGraph } from "../graph/outline-graph.ts";
import { runGraph } from "../graph/run-graph.ts";
import { type GraphNode, nodeAt } from "../graph/types.ts";
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
 * A workflow's graph, or a run's (`run`: its ledger and summary, read at `at`), beside the
 * workflow's source. A click on a node, or in the code, selects the node: the graph rings it and
 * the code marks the lines it may stand for. `onSelect` is told of each node selected, after.
 * Without an outline (it could not be read, or the config has no such workflow) the code's place
 * says why; with no run either there is nothing to draw, and that says why in place of both.
 */
export const GraphAndSource = memo(function GraphAndSource({
  workflow: { name, outline },
  run,
  onSelect,
}: {
  /** The workflow's entry, or only its name when the config has no workflow of that name. */
  workflow: Pick<WorkflowEntry, "name"> & Partial<Pick<WorkflowEntry, "outline">>;
  run?: { ledger: LedgerRecord[]; run: RunSummary; at: number };
  onSelect?: (node: GraphNode) => void;
}) {
  const steps = outline && "nodes" in outline ? outline.nodes : undefined;
  // The page's one graph: the panel draws it, and a click in the code finds its node in it.
  const graph = useMemo(
    () => (run ? runGraph(run.ledger, run.run, run.at, steps) : steps && outlineGraph(steps)),
    [run, steps],
  );
  // By id, so a poll's new graph cannot leave an old node selected.
  const [selected, setSelected] = useState<string>();
  const select = useCallback(
    (node: GraphNode | undefined) => {
      setSelected(node?.id);
      if (node) onSelect?.(node);
    },
    [onSelect],
  );
  const selectAt = useCallback((offset: number) => select(graph && nodeAt(graph.nodes, offset)), [graph, select]);
  const highlight = useMemo(() => graph?.nodes.find((node) => node.id === selected)?.spans, [graph, selected]);
  const unread =
    outline === undefined
      ? `This config has no workflow named ${name}`
      : "error" in outline
        ? outline.error
        : undefined;
  const noSource = unread !== undefined && <Nothing title="No source to show">{unread}</Nothing>;
  if (!graph) return noSource;
  return (
    <div className="flex flex-col gap-2">
      {outline && "fallback" in outline && <None>Showing the function's text, not the file: {outline.fallback}</None>}
      <div className="grid gap-4 lg:grid-cols-2">
        <GraphPanel
          className={PANEL}
          graph={graph}
          show={run ? "end" : "start"}
          selected={selected}
          onSelect={select}
        />
        {noSource || <SourcePanel name={name} highlight={highlight} onSelect={selectAt} />}
      </div>
    </div>
  );
});

function SourcePanel({ name, ...props }: { name: string } & Pick<CodeProps, "highlight" | "onSelect">) {
  const { data } = useSuspenseQuery(sourceQuery(name));
  return data.source === null ? (
    <Nothing title="No source to show" />
  ) : (
    <CodePanel className={PANEL} source={data.source} {...props} />
  );
}
