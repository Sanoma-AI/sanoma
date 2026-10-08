import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { Nothing, Notice, PageHeader, plural, toneBadge, When } from "../../components/common.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../../api.ts";
import { runsQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(runsQuery()),
  head: () => ({ meta: [{ title: "Runs · Sanoma" }] }),
  component: RunsPage,
});

function RunsPage() {
  const { data: runs, error } = useSuspenseQuery(runsQuery());
  const navigate = useNavigate();
  const start = (
    <Button asChild>
      <Link to="/start">
        <PlayIcon data-icon="inline-start" />
        Start a run
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Runs">{runs.length > 0 && <div className="ml-auto">{start}</div>}</PageHeader>
      {error && <Notice variant="destructive">Could not refresh runs: {error.message}</Notice>}
      {runs.length === 0 && (
        <Nothing title="No runs yet" action={start}>
          Start one, or have a worker start one.
        </Nothing>
      )}
      {runs.length > 0 && (
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
                  <TableRow
                    key={run.runId}
                    className="cursor-pointer"
                    onClick={() => void navigate({ to: "/runs/$id", params: { id: run.runId } })}
                  >
                    <TableCell className="font-medium">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link to="/runs/$id" params={{ id: run.runId }} onClick={(e) => e.stopPropagation()}>
                            {run.workflow}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>
                          <code>{run.runId}</code>
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Badge className={toneBadge({ tone: RUN_TONE[run.status] })}>{run.status}</Badge>
                    </TableCell>
                    <TableCell>{starterName(run)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <When at={run.createdAt} />
                    </TableCell>
                    <TableCell>
                      {pending > 0 ? (
                        <Badge className={toneBadge({ tone: "waiting" })}>{plural(pending, "approval")}</Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {run.status === "failed" && run.error && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block max-w-xs truncate text-destructive">{run.error}</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm">{run.error}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
