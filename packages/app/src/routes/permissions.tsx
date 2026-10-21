import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { PreviewAnswer } from "@sanoma-ai/workflows";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { Fragment, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { PREVIEW_TONE } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import type { PermissionsResponse, PermissionsRow } from "../api.ts";
import { Fact, Facts, Nothing, PageHeader, pageTitle, ToneBadge } from "../components/common.tsx";
import { PolicyFacts } from "../components/panels/permissions-panel.tsx";
import { permissionsQuery } from "../queries.ts";

export const Route = createFileRoute("/permissions")({
  staticData: { crumb: "Permissions", section: "permissions" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: ({ context: { queryClient } }) => queryClient.query({ ...permissionsQuery(), staleTime: "static" }),
  component: PermissionsPage,
});

/** A column: a group's name, or `null` for someone in no group. */
type Group = PermissionsResponse["groups"][number];
/** What a row is about: a workflow's start, or an operation, called in a workflow or directly. */
type Kind = "workflow" | "op";
/** A cell the policy answered with a rule behind it, and the workflow its operation is called in: what the sheet shows. */
type Chosen = { kind: Kind; row: PermissionsRow; under?: PermissionsRow; group: Group; cell: PreviewAnswer };

/** Whom a column is about, in words. */
const someoneIn = (group: Group) => `someone in ${group ?? "no group"}`;

/**
 * What the policy answers someone in no group and in each group (the declared ones and `agents`),
 * across, for each workflow's start with each operation it uses under it, and each operation a
 * person may call directly, down, the input unknown. A cell with a rule behind it opens the rule in a sheet. Nothing here is edited:
 * the policy is `policies/*.cedar`, written by the agent.
 */
function PermissionsPage() {
  const { data } = useSuspenseQuery(permissionsQuery());
  // The cell shown, kept while the sheet closes so its content stays through the animation.
  const [chosen, setChosen] = useState<Chosen>();
  const [open, setOpen] = useState(false);
  const choose = (cell: Chosen) => {
    setChosen(cell);
    setOpen(true);
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
              <Rows kind="workflow" rows={data.workflows} groups={data.groups} choose={choose} />
              <Rows kind="op" rows={data.ops} groups={data.groups} choose={choose} />
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

/** A part of the grid under its heading: each row, and under a workflow's the operations it uses, indented. */
function Rows({
  kind,
  rows,
  groups,
  choose,
}: {
  kind: Kind;
  rows: (PermissionsRow & { ops?: PermissionsRow[] })[];
  groups: Group[];
  choose: (cell: Chosen) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <TableBody>
      <TableRow className="bg-muted/50 hover:bg-muted/50">
        <TableHead colSpan={groups.length + 1} scope="colgroup">
          {kind === "workflow" ? "Starting a workflow, and the operations it calls" : "Calling an operation directly"}
        </TableHead>
      </TableRow>
      {rows.map((row) => (
        <Fragment key={row.id}>
          <Line kind={kind} row={row} groups={groups} choose={choose} />
          {row.ops?.map((op, i) => (
            // By position: a workflow may list an operation twice, as the run form asks it twice.
            <Line key={i} kind="op" row={op} under={row} groups={groups} choose={choose} />
          ))}
        </Fragment>
      ))}
    </TableBody>
  );
}

/** A row: its name (a workflow linking to its page, an operation in a workflow indented under it), then its cell for each group. */
function Line({
  kind,
  row,
  under,
  groups,
  choose,
}: {
  kind: Kind;
  row: PermissionsRow;
  under?: PermissionsRow;
  groups: Group[];
  choose: (cell: Chosen) => void;
}) {
  return (
    <TableRow>
      <TableHead scope="row" className={cn("font-normal", under && "pl-8")}>
        {kind === "workflow" ? (
          <Link to="/workflows/$name" params={{ name: row.id }} className="hover:underline">
            {row.title ?? row.id}
          </Link>
        ) : (
          <code>{row.id}</code>
        )}
      </TableHead>
      {groups.map((group, i) => {
        const cell = row.cells[i]!;
        return (
          <TableCell key={group ?? ""}>
            <Mark
              cell={cell}
              what={`${row.id}${under ? ` in ${under.id}` : ""} for ${someoneIn(group)}`}
              open={cell.rule ? () => choose({ kind, row, under, group, cell }) : undefined}
            />
          </TableCell>
        );
      })}
    </TableRow>
  );
}

/** A cell: `allow` muted, else a badge in its tone (a hold naming whom it asks), a button when it opens a rule. */
function Mark({ cell, what, open }: { cell: PreviewAnswer; what: string; open: (() => void) | undefined }) {
  if (cell.answer === "allow") return <span className="text-muted-foreground">allow</span>;
  const label = cell.answer === "hold" && cell.approver ? `hold · ${approverLabel(cell.approver)}` : cell.answer;
  const button = open && {
    render: <button type="button" />,
    onClick: open,
    "aria-label": `${label}: the rule for ${what}`,
  };
  return (
    <ToneBadge tone={PREVIEW_TONE[cell.answer]} {...button}>
      {label}
    </ToneBadge>
  );
}

/** The rule behind a cell: its title (else its id), its id and file, its reason, and for a hold whom it asks. */
function Rule({ kind, row, under, group, cell }: Chosen) {
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
      </div>
    </>
  );
}
