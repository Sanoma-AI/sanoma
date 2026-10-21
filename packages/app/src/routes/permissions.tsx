import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { PreviewAnswer } from "@sanoma-ai/workflows";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import type { Tone } from "#/lib/tone.ts";
import type { PermissionsResponse, PreviewResult } from "../api.ts";
import { Fact, Facts, Notice, Nothing, PageHeader, pageTitle, ToneBadge } from "../components/common.tsx";
import { PolicyFacts } from "../components/panels/permissions-panel.tsx";
import { asked } from "../lib/preview.ts";
import { permissionsQuery } from "../queries.ts";

export const Route = createFileRoute("/permissions")({
  staticData: { crumb: "Permissions", section: "permissions" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: ({ context: { queryClient } }) => queryClient.query({ ...permissionsQuery(), staleTime: "static" }),
  component: PermissionsPage,
});

type Row = PermissionsResponse["rows"][number];
/** A column: a group's name, or `null` for someone in no group. */
type Group = PermissionsResponse["groups"][number];
/** A cell the policy answered with a rule behind it: what the sheet shows. */
type Chosen = { row: Row; group: Group; cell: PreviewAnswer };

/** Whom a column is about, in words. */
const someoneIn = (group: Group) => `someone in ${group ?? "no group"}`;

/** Each answer's tone: a hold waits on someone, a deny refuses, the input decides `depends`. */
const TONE: Record<Exclude<PreviewResult["answer"], "allow">, Tone> = {
  hold: "waiting",
  deny: "bad",
  depends: "active",
  custom: "idle",
};

/**
 * What the policy answers someone in no group and in each group (the declared ones and `agents`),
 * across, for each workflow's
 * start and each operation a person may call directly (down), the input unknown. A cell with a
 * rule behind it opens the rule in a sheet. Nothing here is edited: the policy is
 * `policies/*.cedar`, written by the agent.
 */
function PermissionsPage() {
  const { data } = useSuspenseQuery(permissionsQuery());
  // The cell shown, kept while the sheet closes so its content stays through the animation.
  const [chosen, setChosen] = useState<Chosen>();
  const [open, setOpen] = useState(false);
  const workflows = data.rows.filter((row) => row.kind === "workflow");
  const ops = data.rows.filter((row) => row.kind === "op");
  const choose = (row: Row, group: Group, cell: PreviewResult) => {
    if (cell.answer === "custom" || !cell.rule) return undefined;
    return () => {
      setChosen({ row, group, cell });
      setOpen(true);
    };
  };
  return (
    <>
      <PageHeader />
      {!data.policy.defined ? (
        <Nothing title="This config has no policy">
          Every call is allowed. Write rules in <code>policies/*.cedar</code>, beside the config.
        </Nothing>
      ) : (
        <>
          <Facts>
            <PolicyFacts policy={data.policy} />
          </Facts>
          {data.policy.kind === "function" && (
            <Notice>
              A policy written as a function cannot be asked ahead: it decides each call as it is made. Rules in{" "}
              <code>policies/*.cedar</code> fill this grid.
            </Notice>
          )}
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="sr-only">Workflow or operation</span>
                  </TableHead>
                  {data.groups.map((group) => (
                    <TableHead key={group ?? ""} scope="col">
                      {group ?? "No group"}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <Rows title="Starting a workflow" rows={workflows} groups={data.groups} choose={choose} />
              <Rows title="Calling an operation directly" rows={ops} groups={data.groups} choose={choose} />
            </Table>
          </div>
        </>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>{chosen && <Rule {...chosen} />}</SheetContent>
      </Sheet>
    </>
  );
}

/** A part of the grid under its heading: each row's name, then its cell for each group. */
function Rows({
  title,
  rows,
  groups,
  choose,
}: {
  title: string;
  rows: Row[];
  groups: Group[];
  choose: (row: Row, group: Group, cell: PreviewResult) => (() => void) | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <TableBody>
      <TableRow className="bg-muted/50 hover:bg-muted/50">
        <TableHead colSpan={groups.length + 1} scope="colgroup">
          {title}
        </TableHead>
      </TableRow>
      {rows.map((row) => (
        <TableRow key={`${row.kind}:${row.id}`}>
          <TableHead scope="row" className="font-normal">
            {row.kind === "workflow" ? (
              <Link to="/workflows/$name" params={{ name: row.id }} className="hover:underline">
                {row.title ?? row.id}
              </Link>
            ) : (
              <code>{row.id}</code>
            )}
          </TableHead>
          {groups.map((group, i) => (
            <TableCell key={group ?? ""}>
              <Mark
                cell={row.cells[i]!}
                open={choose(row, group, row.cells[i]!)}
                what={`${row.id} for ${someoneIn(group)}`}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

/** A cell: `allow` muted, else a badge in its tone (a hold naming whom it asks), a button when it opens a rule. */
function Mark({ cell, open, what }: { cell: PreviewResult; open: (() => void) | undefined; what: string }) {
  if (cell.answer === "allow") return <span className="text-muted-foreground">allow</span>;
  const label = cell.answer === "hold" && cell.approver ? `hold · ${asked(cell.approver)}` : cell.answer;
  const tone = TONE[cell.answer];
  if (!open) return <ToneBadge tone={tone}>{label}</ToneBadge>;
  return (
    <ToneBadge
      tone={tone}
      render={<button type="button" />}
      onClick={open}
      aria-label={`${label}: the rule for ${what}`}
    >
      {label}
    </ToneBadge>
  );
}

/** The rule behind a cell: its id, its file, its title or reason, and for a hold whom it asks. */
function Rule({ row, group, cell }: Chosen) {
  const rule = cell.rule!;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{rule.title ?? rule.id}</SheetTitle>
        <SheetDescription>
          {cell.answer === "hold"
            ? "Holds"
            : cell.answer === "deny"
              ? "Refuses"
              : "May hold or refuse, depending on the input,"}{" "}
          {row.kind === "workflow" ? `starting ${row.title ?? row.id}` : <code>{row.id}</code>} for {someoneIn(group)}.
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
          {rule.title !== undefined && <Fact label="Title">{rule.title}</Fact>}
          {rule.reason !== undefined && <Fact label="Reason">{rule.reason}</Fact>}
          {cell.answer === "hold" && cell.approver && <Fact label="Asks">{approverLabel(cell.approver)}</Fact>}
        </Facts>
      </div>
    </>
  );
}
