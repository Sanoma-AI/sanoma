import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Notice, plural, RunStatusBadge, When } from "../../components/common.tsx";
import { runsQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(runsQuery()),
  head: () => ({ meta: [{ title: "Runs · Sanoma" }] }),
  component: RunsPage,
});

function RunsPage() {
  const { data: runs, error } = useQuery(runsQuery());
  const navigate = useNavigate();

  return (
    <section>
      <header className="page-head">
        <h1>Runs</h1>
        <Link className="button" to="/start">
          Start a run
        </Link>
      </header>
      {error && <Notice tone="bad">Could not load runs: {error.message}</Notice>}
      {runs && runs.length === 0 && <Notice>No runs yet. Start one, or have a worker start one.</Notice>}
      {runs && runs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Status</th>
                <th>Started by</th>
                <th>When</th>
                <th>Waiting on</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const pending = run.approvals.filter((a) => a.status === "pending").length;
                return (
                  <tr
                    key={run.runId}
                    className="clickable"
                    onClick={() => void navigate({ to: "/runs/$id", params: { id: run.runId } })}
                    title={run.runId}
                  >
                    <td>
                      <Link to="/runs/$id" params={{ id: run.runId }} onClick={(e) => e.stopPropagation()}>
                        {run.workflow}
                      </Link>
                    </td>
                    <td>
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td>{run.startedBy?.id ?? <span className="muted">unknown</span>}</td>
                    <td>
                      <When at={run.createdAt} />
                    </td>
                    <td>
                      {pending > 0 ? (
                        <span className="badge tone-waiting">{plural(pending, "approval")}</span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className="error-cell">{run.status === "failed" && run.error ? run.error : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
