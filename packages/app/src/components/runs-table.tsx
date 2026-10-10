import type { RunSummary } from "@sanoma/workflows";
import { Link, useNavigate } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../api.ts";
import { runLink } from "../queries.ts";
import { plural, SandboxBadge, Tip, ToneBadge, When } from "./common.tsx";

/** Runs of every workflow as a table, newest first: a row opens its run, under its workflow's page. */
export function RunsTable({ runs }: { runs: RunSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workflow</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Started by</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Waiting on</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const pending = pendingApprovals(run).length;
            return (
              // The whole row opens the run; its link is there for the keyboard and a new tab.
              <TableRow key={run.runId} className="cursor-pointer" onClick={() => void navigate(runLink(run))}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <Tip tip={<code>{run.runId}</code>}>
                      <Link {...runLink(run)} onClick={(e) => e.stopPropagation()}>
                        {run.workflow}
                      </Link>
                    </Tip>
                    {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
                  </div>
                </TableCell>
                <TableCell>
                  <ToneBadge tone={RUN_TONE[run.status]}>{run.status}</ToneBadge>
                </TableCell>
                <TableCell>{starterName(run)}</TableCell>
                <TableCell className="text-muted-foreground">
                  <When at={run.createdAt} />
                </TableCell>
                <TableCell>
                  {pending > 0 ? (
                    <ToneBadge tone="waiting">{plural(pending, "approval")}</ToneBadge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {run.status === "failed" && run.error && (
                    <span className="block max-w-xs truncate text-destructive" title={run.error}>
                      {run.error}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
