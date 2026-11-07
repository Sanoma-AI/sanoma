import type { RunSummary } from "@sanoma-ai/workflows";
import { Link, type NavigateOptions, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, runName, starterName } from "../api.ts";
import { runLink } from "../queries.ts";
import { plural, SandboxBadge, Tip, ToneBadge, When } from "./common.tsx";

/**
 * A table row that opens `link` wherever it is clicked. Its first cell holds the same link, for
 * the keyboard and a new tab, which stops its click from reaching the row.
 */
export function LinkRow({
  link,
  selected,
  children,
}: {
  link: NavigateOptions;
  /** Marks the row as the one open. */
  selected?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <TableRow
      className="cursor-pointer"
      data-state={selected ? "selected" : undefined}
      onClick={() => void navigate(link)}
    >
      {children}
    </TableRow>
  );
}

/**
 * Runs as a table, newest first. Bare: the page's card holds it. Of every workflow, each row
 * opens its run's page, the first column naming its workflow; or, with `link`, one workflow's,
 * each row opening `link(run)` (the run over the page), the first column naming the run, the one
 * `selected` marked.
 */
export function RunsTable({
  runs,
  className,
  link,
  selected,
}: {
  runs: RunSummary[];
  className?: string;
  link?: (run: RunSummary) => NavigateOptions;
  /** The run open, by id. */
  selected?: string | undefined;
}) {
  return (
    <Table className={className}>
      <TableHeader>
        <TableRow>
          <TableHead>{link ? "Run" : "Workflow"}</TableHead>
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
          const opens = link ? link(run) : runLink(run);
          return (
            <LinkRow key={run.runId} link={opens} selected={run.runId === selected}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <Tip tip={<code>{run.runId}</code>}>
                    <Link {...opens} onClick={(e) => e.stopPropagation()}>
                      {link ? runName(run.runId) : run.workflow}
                    </Link>
                  </Tip>
                  {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
                </div>
              </TableCell>
              <TableCell>
                <ToneBadge dot tone={RUN_TONE[run.status]}>
                  {run.status}
                </ToneBadge>
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
            </LinkRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
