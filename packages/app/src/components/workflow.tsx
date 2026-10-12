import type { LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { type ComponentProps, memo, useCallback, useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import type { ScenarioEntry } from "../api.ts";
import { type Field, fieldsOf } from "../form/schema.ts";
import { outlineGraph } from "../graph/outline-graph.ts";
import { runGraph } from "../graph/run-graph.ts";
import { annotateGraph } from "../graph/scenario-graph.ts";
import { type GraphNode, nodeAt } from "../graph/types.ts";
import { configQuery, opsById, sourceQuery, workflowFile } from "../queries.ts";
import type { CodeProps } from "./code.tsx";
import { BUILTIN_ICON, CodePanel, GraphPanel, Json, None, Nothing, Notice, OpItem, Section } from "./common.tsx";

// A workflow's pieces, as the workflows page's cards and a workflow's own page show them, and
// its graph beside its source, as a workflow's page and a run's show them.

/** Run: opens the workflow's New run pane. A Button otherwise, styled as given. */
export function RunButton({
  name,
  ...props
}: { name: string } & Omit<ComponentProps<typeof Button>, "asChild" | "children">) {
  return (
    <Button asChild {...props}>
      <Link to="/workflows/$name/new" params={{ name }}>
        <PlayIcon data-icon="inline-start" />
        Run
      </Link>
    </Button>
  );
}

/** Where a pane of a retired workflow's page would be: the config no longer has it, but its runs remain. */
export function Retired({ name }: { name: string }) {
  return (
    <Notice>
      This config has no workflow named <code>{name}</code>. Its past runs are in the rail.
    </Notice>
  );
}

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
            {workflow.builtins.map((b) => {
              const Icon = BUILTIN_ICON[b];
              return (
                <Badge key={b} variant="outline">
                  <Icon data-icon="inline-start" />
                  {b}
                </Badge>
              );
            })}
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
 * workflow's source. A workflow's graph marks what `scenario`, when given, seeds and expects. A click on a node, or in the code, selects the node: the graph rings it and
 * the code marks the lines it may stand for. `onSelect` is told of each node selected, after.
 * Without an outline (it could not be read, or the config has no such workflow) the code's place
 * says why; with no run either there is nothing to draw, and that says why in place of both.
 */
export const GraphAndSource = memo(function GraphAndSource({
  workflow: { name, outline, source },
  run,
  scenario,
  onSelect,
}: {
  /** The workflow's entry, or only its name when the config has no workflow of that name. */
  workflow: Pick<WorkflowEntry, "name"> & Partial<Pick<WorkflowEntry, "outline" | "source">>;
  run?: { ledger: LedgerRecord[]; run: RunSummary; at: number };
  scenario?: Pick<ScenarioEntry, "steps">;
  onSelect?: (node: GraphNode) => void;
}) {
  const steps = outline && "nodes" in outline ? outline.nodes : undefined;
  // The page's one graph: the panel draws it, and a click in the code finds its node in it.
  const graph = useMemo(() => {
    if (run) return runGraph(run.ledger, run.run, run.at, steps);
    const drawn = steps && outlineGraph(steps);
    return drawn && scenario ? annotateGraph(drawn, scenario) : drawn;
  }, [run, steps, scenario]);
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
  const highlight = useMemo(() => {
    const span = graph?.nodes.find((node) => node.id === selected)?.span;
    return span && [span];
  }, [graph, selected]);
  const unread =
    outline === undefined
      ? `This config has no workflow named ${name}`
      : "error" in outline
        ? outline.error
        : undefined;
  const noSource = unread !== undefined && <Nothing title="No source to show">{unread}</Nothing>;
  const file = outline && workflowFile({ outline });
  if (!graph) return noSource;
  return (
    // Split by its own width, not the screen's: a pane may give it half the page.
    <div className="@container flex flex-col gap-2">
      <div className="grid gap-4 @3xl:grid-cols-2">
        <GraphPanel
          className={PANEL}
          graph={graph}
          show={run ? "end" : "start"}
          selected={selected}
          onSelect={select}
        />
        {noSource ||
          (file !== undefined ? (
            <FileSourcePanel file={file} highlight={highlight} onSelect={selectAt} />
          ) : (
            <SourcePanel source={source} highlight={highlight} onSelect={selectAt} />
          ))}
      </div>
    </div>
  );
});

type SourceProps = Pick<CodeProps, "highlight" | "onSelect">;

/** A workflow's file, as it is now. */
function FileSourcePanel({ file, ...props }: { file: string } & SourceProps) {
  const { data } = useSuspenseQuery(sourceQuery(file));
  return <SourcePanel source={data.source} {...props} />;
}

/** The text the outline's spans index into, or why there is none. */
function SourcePanel({ source, ...props }: { source: string | null | undefined } & SourceProps) {
  return source == null ? (
    <Nothing title="No source to show" />
  ) : (
    <CodePanel className={PANEL} source={source} {...props} />
  );
}
