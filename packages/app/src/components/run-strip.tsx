import type { RunSummary } from "@sanoma/workflows";
import { useQuery } from "@tanstack/react-query";
import { ClientOnly, Link } from "@tanstack/react-router";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { utcText } from "#/lib/time.ts";
import { RUN_TONE, TONE_FILL } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import { runLink, runsQuery, runsRefetchInterval } from "../queries.ts";

/** How many of a workflow's runs its strip shows: the latest. */
const STRIP_LIMIT = 12;

/**
 * A workflow's latest runs, oldest to newest, as small squares in their status's colour, each
 * linking to its run. In the browser only, so the server does not wait on one read per workflow;
 * a skeleton holds its place until then.
 */
export function RunStrip({ workflow }: { workflow: string }) {
  return (
    <ClientOnly fallback={<StripSkeleton />}>
      <Strip workflow={workflow} />
    </ClientOnly>
  );
}

function StripSkeleton() {
  return <Skeleton role="status" aria-label="Loading the runs" className="h-3 w-47" />;
}

function Strip({ workflow }: { workflow: string }) {
  // A glance: every 5 s while a run can still change, as the sidebar polls, not the rail's 2 s.
  const { data: runs, error } = useQuery({
    ...runsQuery({ workflow, limit: STRIP_LIMIT }),
    refetchInterval: runsRefetchInterval(5_000),
  });
  if (!runs) {
    return error ? (
      <p className="text-sm text-destructive">Could not read the runs: {error.message}</p>
    ) : (
      <StripSkeleton />
    );
  }
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No runs yet</p>;
  return (
    <ol aria-label={`Last ${STRIP_LIMIT} runs`} className="flex flex-wrap gap-1">
      {runs.toReversed().map((run) => (
        <li key={run.runId} className="flex">
          <RunSquare run={run} />
        </li>
      ))}
    </ol>
  );
}

function RunSquare({ run }: { run: RunSummary }) {
  const label = [
    run.status,
    run.workflow,
    utcText(run.createdAt),
    run.sandbox !== undefined && `sandbox · ${run.sandbox}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Link
      {...runLink(run)}
      title={label}
      aria-label={label}
      className={cn(
        "size-3 rounded-[3px] outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
        TONE_FILL[RUN_TONE[run.status]],
        // A sandbox run is a rehearsal: shown fainter than a live one.
        run.sandbox !== undefined && "opacity-60",
      )}
    />
  );
}
