import type { RunSummary } from "@sanoma/workflows";
import { Notice, RunStatus, When } from "../components.tsx";
import { runHref, usePoll } from "../lib.ts";

export function RunsPage() {
  const { data: runs, error } = usePoll<RunSummary[]>("/api/runs?limit=50");

  return (
    <section>
      <header className="page-head">
        <h1>Runs</h1>
        <a className="button" href="#/start">
          Start a run
        </a>
      </header>
      {error && <Notice tone="bad">Could not load runs: {error}</Notice>}
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
                    onClick={() => (location.hash = runHref(run.runId))}
                    title={run.runId}
                  >
                    <td>
                      <a href={runHref(run.runId)} onClick={(e) => e.stopPropagation()}>
                        {run.workflow}
                      </a>
                    </td>
                    <td>
                      <RunStatus status={run.status} />
                    </td>
                    <td>{run.startedBy ?? <span className="muted">unknown</span>}</td>
                    <td>
                      <When at={run.createdAt} />
                    </td>
                    <td>
                      {pending > 0 ? (
                        <span className="badge tone-waiting">
                          {pending} approval{pending === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className="error-cell">{run.status === "ERROR" && run.error ? run.error : ""}</td>
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
