import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { PreviewAnswer } from "@sanoma-ai/workflows";
import type { Span } from "@sanoma-ai/workflows/describe";
import { ANONYMOUS, approverLabel } from "@sanoma-ai/workflows/shared";
import { useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardHeader } from "#/components/ui/card.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { type Group, type Kind, Mark, PermissionsTable, someoneIn } from "#/components/permissions-grid.tsx";
import type { PermissionsResponse, PermissionsRow } from "../api.ts";
import {
  CardHeading,
  CodePanel,
  CrumbHeader,
  Fact,
  Facts,
  loadCode,
  Nothing,
  PolicyProblems,
  pageTitle,
  plural,
} from "../components/common.tsx";
import { permissionsQuery } from "../queries.ts";

export const Route = createFileRoute("/permissions")({
  staticData: { crumb: "Permissions" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: ({ context: { queryClient } }) => {
    if (!import.meta.env.SSR) void loadCode();
    return queryClient.query({ ...permissionsQuery(), staleTime: "static" });
  },
  component: PermissionsPage,
});

/** A cell the policy answered with a rule behind it, and the workflow its operation is called in: what the sheet shows. */
type Chosen = { kind: Kind; row: PermissionsRow; under?: PermissionsRow; group: Group; cell: PreviewAnswer };

/**
 * What the policy answers someone in no group, in each group (the declared ones, `agents` and
 * `visitors`) and `anonymous`, across, for each workflow's start with each operation it uses under it, and each operation a
 * person may call directly, down, the input unknown. A cell with a rule behind it opens the rule
 * in a sheet, whose Show the rule marks its lines in the policy's files, shown read-only under the
 * grid. Nothing here is edited: the policy is `policies/*.cedar`, written by the agent.
 */
function PermissionsPage() {
  const { data } = useSuspenseQuery(permissionsQuery());
  // The cell shown, kept while the sheet closes so its content stays through the animation.
  const [chosen, setChosen] = useState<Chosen>();
  const [open, setOpen] = useState(false);
  // The rule whose lines the code marks, by id; `showing` while the sheet closes to show it.
  const [shown, setShown] = useState<string>();
  const showing = useRef(false);
  const choose = (cell: Chosen) => {
    setChosen(cell);
    setOpen(true);
  };
  const rule = chosen?.cell.rule;
  // The chosen cell's rule, when its file is shown: Show the rule.
  const showable = rule && data.files.some((f) => f.file === rule.file) ? rule : undefined;
  // Once the sheet has closed: before, its closing would put the page back where it was. The card
  // comes into view, then the code centres the rule's lines (`Code`'s highlight).
  const showRule = () => {
    showing.current = false;
    setShown(showable!.id);
    document.getElementById(showable!.file)?.scrollIntoView({ block: "nearest" });
  };
  return (
    <>
      <CrumbHeader>{data.policy.defined && <PolicyLine data={data} />}</CrumbHeader>
      {!data.policy.defined ? (
        <Nothing title="This config has no policy">
          Every call is allowed. Write rules in <code>policies/*.cedar</code>, beside the config.
        </Nothing>
      ) : (
        <>
          {data.policy.problems && <PolicyProblems />}
          <Card className="gap-0 py-0">
            <PermissionsTable<PermissionsRow & { ops?: PermissionsRow[] }>
              groups={data.groups}
              workflows={data.workflows}
              ops={data.ops}
              cell={(row, i, under, kind) => {
                const group = data.groups[i]!;
                const cell = row.cells[i]!;
                return (
                  <Mark
                    cell={cell}
                    what={`${row.id}${under ? ` in ${under.id}` : ""} for ${someoneIn(group)}`}
                    open={cell.rule ? () => choose({ kind, row, under, group, cell }) : undefined}
                  />
                );
              }}
            />
          </Card>
          {data.files.map(({ file, text, policies }) => (
            <PolicyCode key={file} file={file} text={text} span={policies.find((p) => p.id === shown)?.span} />
          ))}
        </>
      )}
      <Sheet
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && showing.current) showRule();
        }}
      >
        <SheetContent>
          {chosen && (
            <Rule
              {...chosen}
              show={
                showable === undefined
                  ? undefined
                  : () => {
                      showing.current = true;
                      setOpen(false);
                    }
              }
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The policy beside the title, in one muted line: Cedar, its version, and how many groups,
 * workflows and operations (each once, in a workflow or called directly) the grid has.
 */
function PolicyLine({ data }: { data: PermissionsResponse }) {
  const groups = data.groups.filter((group) => group !== null && group !== ANONYMOUS).length;
  const ops = new Set([...data.workflows.flatMap((w) => w.ops), ...data.ops].map((op) => op.id)).size;
  return (
    <p className="text-sm text-muted-foreground">
      Cedar, <code>policies/*.cedar</code>
      {data.policy.version !== undefined && (
        <>
          {" "}
          · version <code>{data.policy.version}</code>
        </>
      )}{" "}
      · {plural(groups, "group")} · {plural(data.workflows.length, "workflow")} · {plural(ops, "operation")}
    </p>
  );
}

/**
 * A policy file, read-only and plain (the app has no Cedar grammar), titled by its path, as high
 * as its lines up to the workflow Code card's height, `span` (the shown rule's) marked. Its id
 * is its path, which Show the rule scrolls to.
 */
function PolicyCode({ file, text, span }: { file: string; text: string; span: Span | undefined }) {
  return (
    <Card id={file} className="scroll-mt-4 gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-2 compact:py-1 [.border-b]:pb-2 compact:[.border-b]:pb-1">
        <CardHeading className="font-mono text-sm">{file}</CardHeading>
      </CardHeader>
      {/* Its lines at the Code view's 1.6 line height, and the view's padding, at most the
          workflow Code card's height. */}
      <div className="max-h-(--pane) text-xs" style={{ height: `calc(${text.split("\n").length * 1.6}em + 0.5rem)` }}>
        <CodePanel source={text} highlight={span && [span]} plain />
      </div>
    </Card>
  );
}

/**
 * The rule behind a cell: its title (else its id), its id and file, its reason, for a hold whom
 * it asks, and Show the rule when its file is shown (`show`).
 */
function Rule({ kind, row, under, group, cell, show }: Chosen & { show: (() => void) | undefined }) {
  const rule = cell.rule!;
  const verb =
    cell.answer === "hold"
      ? "Holds"
      : cell.answer === "deny"
        ? "Refuses"
        : "May hold or refuse, depending on the input,";
  return (
    <>
      <SheetHeader>
        <SheetTitle>{rule.title ?? rule.id}</SheetTitle>
        <SheetDescription>
          {verb} {kind === "workflow" ? `starting ${row.title ?? row.id}` : <code>{row.id}</code>}
          {under && ` in ${under.title ?? under.id}`} for {someoneIn(group)}.
        </SheetDescription>
      </SheetHeader>
      <div className="px-4">
        <Facts>
          <Fact label="Rule">
            <code>{rule.id}</code>
          </Fact>
          <Fact label="File">
            <code>{rule.file}</code>
          </Fact>
          {rule.reason !== undefined && <Fact label="Reason">{rule.reason}</Fact>}
          {cell.answer === "hold" && cell.approver && <Fact label="Asks">{approverLabel(cell.approver)}</Fact>}
        </Facts>
        {show && (
          <Button variant="outline" size="sm" className="mt-4" onClick={show}>
            Show the rule
          </Button>
        )}
      </div>
    </>
  );
}
