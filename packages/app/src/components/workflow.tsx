import type { LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CodeIcon, PlayIcon } from "lucide-react";
import { type ComponentProps, memo, useCallback, useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Card } from "#/components/ui/card.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "#/components/ui/resizable.tsx";
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
// its graph above its source in one card, as a workflow's page and a run's show them.

/** Run: opens the workflow's page, where its New run form is. A Button otherwise, styled as given. */
export function RunButton({
  name,
  ...props
}: { name: string } & Omit<ComponentProps<typeof Button>, "asChild" | "children">) {
  return (
    <Button asChild {...props}>
      <Link to="/workflows/$name" params={{ name }}>
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

/**
 * The graph's and the source's shares of the card's height, by panel id: on the server too, so
 * the page does not shift when it hydrates. Never stored: a stored layout would differ from the
 * server's.
 */
const LAYOUT = { graph: 60, source: 40 };

/**
 * A workflow's graph, or a run's (`run`: its ledger and summary, read at `at`), above the
 * workflow's source, in one card: a handle between them shares out its height, and Code hides or
 * shows the source. (A drag does not fit the graph to its new size again: a follow-up.) A
 * workflow's graph marks what `scenario`, when given, seeds and expects. A click on a node, or in
 * the code, selects the node: the graph rings it and the code marks the lines it may stand for.
 * `onSelect` is told of each node selected, after. Without an outline (it could not be read, or
 * the config has no such workflow) the code's place says why; with no run either there is
 * nothing to draw, and that says why in place of both.
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
  // Code hides the source by unmounting its panel, not collapsing it: no imperative call, so the
  // server renders either state as the browser does.
  const [codeOpen, setCodeOpen] = useState(true);
  if (!graph) return noSource;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-2 border-b px-(--card-spacing) py-2">
        <h2 className="font-heading text-sm font-medium">Graph</h2>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={codeOpen}
          className="ml-auto"
          onClick={() => setCodeOpen((open) => !open)}
        >
          <CodeIcon data-icon="inline-start" />
          Code
        </Button>
      </div>
      {/* Sized by its box: the group's own inline height (100%) would win over a class. */}
      <div className="h-[560px]">
        <ResizablePanelGroup id="graph-source" orientation="vertical" defaultLayout={LAYOUT}>
          <ResizablePanel id="graph" minSize="25%">
            <GraphPanel fill graph={graph} show={run ? "end" : "start"} selected={selected} onSelect={select} />
          </ResizablePanel>
          {codeOpen && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="source" minSize="20%">
                {noSource ||
                  (file !== undefined ? (
                    <FileSourcePanel file={file} highlight={highlight} onSelect={selectAt} />
                  ) : (
                    <SourcePanel source={source} highlight={highlight} onSelect={selectAt} />
                  ))}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </Card>
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
  return source == null ? <Nothing title="No source to show" /> : <CodePanel fill source={source} {...props} />;
}
