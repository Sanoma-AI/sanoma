import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Nothing, Notice, PageHeader, plural, RunStatusBadge, When } from "../../components/common.tsx";
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
    <section className="flex flex-col gap-4">
      <PageHeader title="Runs">{runs.length > 0 && <div className="ml-auto">{start}</div>}</PageHeader>
      {error && <Notice tone="bad">Could not refresh runs: {error.message}</Notice>}
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
                const pending = run.approvals.filter((a) => a.status === "pending").length;
                return (
                  <TableRow
                    key={run.runId}
                    className="cursor-pointer"
                    onClick={() => void navigate({ to: "/runs/$id", params: { id: run.runId } })}
                    title={run.runId}
                  >
                    <TableCell className="font-medium">
                      <Link
                        to="/runs/$id"
                        params={{ id: run.runId }}
                        onClick={(e) => e.stopPropagation()}
                        className="underline-offset-4 hover:underline"
                      >
                        {run.workflow}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>{run.startedBy?.id ?? <span className="text-muted-foreground">unknown</span>}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <When at={run.createdAt} />
                    </TableCell>
                    <TableCell>
                      {pending > 0 ? (
                        <Badge variant="waiting">{plural(pending, "approval")}</Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-md min-w-64 whitespace-normal text-destructive">
                      {run.status === "failed" && run.error ? run.error : ""}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
