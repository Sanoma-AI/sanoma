import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { Nothing, Notice, PageHeader, plural, Tip, ToneBadge, When } from "../../components/common.tsx";
import { StartButton } from "../../components/workflow.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, starterName } from "../../api.ts";
import { runsQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/")({
  loader: async ({ context }) => {
    await context.queryClient.query({ ...runsQuery(), staleTime: "static" });
  },
  component: RunsPage,
});

function RunsPage() {
  const { data: runs, error } = useSuspenseQuery(runsQuery());
  const navigate = useNavigate();
  const start = (
    <StartButton variant="default" size="default">
      Start a run
    </StartButton>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader action={runs.length > 0 && start} />
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
                      <Tip tip={<code>{run.runId}</code>}>
                        <Link to="/runs/$id" params={{ id: run.runId }} onClick={(e) => e.stopPropagation()}>
                          {run.workflow}
                        </Link>
                      </Tip>
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
      )}
    </div>
  );
}
