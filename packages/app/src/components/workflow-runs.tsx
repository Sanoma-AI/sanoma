import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, Link, useNavigate } from "@tanstack/react-router";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { useMemo } from "react";
import { CardAction, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { cn } from "#/lib/utils.ts";
import { RUN_TONE } from "#/lib/tone.ts";
import { pendingApprovals, type RunDetail, runName, starterName } from "../api.ts";
import {
  picksFromLatest,
  RUN_FILTERS,
  type RunFilter,
  runLink,
  runQuery,
  WORKFLOW_RUNS_LIMIT,
  workflowRuns,
  workflowRunsQuery,
} from "../queries.ts";
import {
  ButtonLink,
  CardHeading,
  Fact,
  Facts,
  FLOAT,
  FloatHost,
  FloatingCard,
  Json,
  None,
  Nothing,
  Notice,
  SandboxBadge,
  Section,
  ToneBadge,
  When,
} from "./common.tsx";
import { LedgerTrace } from "./ledger.tsx";
import { RunsTable } from "./runs-table.tsx";

// A workflow's Runs tab: its runs, filtered (`?runs=`), and the one open (`?run=`) over them.

const RUN_FILTER_LABEL: Record<RunFilter, string> = {
  all: "All",
  live: "Live",
  sandbox: "Sandbox",
  waiting: "Waiting",
  failed: "Failed",
};

/**
 * A workflow's latest runs for a filter (`?runs=`, which its layout validates and its page's
 * loader reads), newest first: `shown`, those the filter keeps; `fromLatest` when it picks from
 * the latest (live and sandbox), so what it shows is only of those; `capped` when the read hit
 * its limit; `empty`, what to say when it keeps none; and `error`, why a refresh failed.
 */
export function useWorkflowRuns(name: string, filter: RunFilter) {
  const { data: runs, error } = useSuspenseQuery(workflowRunsQuery(name, filter));
  const fromLatest = picksFromLatest(filter);
  return {
    shown: workflowRuns(filter, runs),
    fromLatest,
    capped: runs.length === WORKFLOW_RUNS_LIMIT,
    error,
    empty:
      filter === "all"
        ? "No runs yet"
        : fromLatest
          ? `No ${filter} runs among the latest ${WORKFLOW_RUNS_LIMIT}`
          : "No runs match",
  };
}

/**
 * The Runs tab: one card, the filter over the table of runs, each row opening its run (`?run=`,
 * the rest of the search kept) over the card's right.
 */
export function WorkflowRuns({ name, filter, open }: { name: string; filter: RunFilter; open: string | undefined }) {
  const { shown, fromLatest, capped, error, empty } = useWorkflowRuns(name, filter);
  return (
    <>
      {error && <Notice variant="destructive">Could not refresh the runs: {error.message}</Notice>}
      <FloatHost float={open && <OpenRun key={open} id={open} />}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <RunsFilterSelect filter={filter} />
          {capped && (
            <span className="text-xs text-muted-foreground">
              {fromLatest ? "From" : "Showing"} the latest {WORKFLOW_RUNS_LIMIT}
            </span>
          )}
        </div>
        {shown.length === 0 ? (
          <Nothing className="border-0 border-t" title={empty} />
        ) : (
          <RunsTable
            runs={shown}
            className="border-t"
            link={(run) => ({ to: ".", search: (prev) => ({ ...prev, run: run.runId }) })}
            selected={open}
          />
        )}
      </FloatHost>
    </>
  );
}

/** The filter as a select: another filter replaces the page in the history rather than adding one. */
function RunsFilterSelect({ filter }: { filter: RunFilter }) {
  const navigate = useNavigate();
  return (
    <NativeSelect
      size="sm"
      aria-label="Show runs"
      value={filter}
      onChange={(e) => {
        const chosen = e.target.value as RunFilter;
        // All leaves the URL without `?runs=`; the run open closes, as it may not be listed.
        void navigate({
          to: ".",
          search: (prev) => ({ ...prev, runs: chosen === "all" ? undefined : chosen, run: undefined }),
          replace: true,
        });
      }}
    >
      {RUN_FILTERS.map((f) => (
        <NativeSelectOption key={f} value={f}>
          {RUN_FILTER_LABEL[f]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/**
 * The run open over the Runs tab: its status, who started it and when, its input and its ledger
 * as a short trace, and Open run, its page. Its body scrolls inside the card's height.
 */
function OpenRun({ id }: { id: string }) {
  // A run that is not there stays not there: said at once, not after retries.
  const { data, error } = useQuery({ ...runQuery(id), retry: (count, err) => !isNotFound(err) && count < 3 });
  const run = data?.run;
  return (
    <FloatingCard role="region" aria-label={runName(id)} className={cn(FLOAT, "order-first gap-0 py-0")}>
      <CardHeader className="border-b py-3">
        <CardHeading>{runName(id)}</CardHeading>
        <CardAction>
          <ButtonLink variant="ghost" size="icon-sm">
            <Link to="." search={(prev) => ({ ...prev, run: undefined })}>
              <XIcon aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Link>
          </ButtonLink>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-(--card-spacing) overflow-y-auto py-(--card-spacing)">
        {data ? (
          <RunBody {...data} />
        ) : error ? (
          <Notice variant="destructive">Could not read the run: {error.message}</Notice>
        ) : (
          <Skeleton role="status" aria-label="Loading the run" className="h-24" />
        )}
      </CardContent>
      {run && (
        <CardFooter className="border-t py-3">
          <ButtonLink size="sm">
            <Link {...runLink(run)}>Open run</Link>
          </ButtonLink>
        </CardFooter>
      )}
    </FloatingCard>
  );
}

function RunBody({ run, ledger, ledgerError, approvals }: RunDetail) {
  const waiting = pendingApprovals(run)[0];
  const input = ledger.find((record) => record.type === "run.started")?.input;
  const titles = useMemo(() => new Map(approvals.map((a) => [a.id, a.title])), [approvals]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge dot tone={RUN_TONE[run.status]}>
          {run.status}
        </ToneBadge>
        {run.sandbox !== undefined && <SandboxBadge name={run.sandbox} />}
        {waiting && (
          <span className="text-muted-foreground">
            on {approverLabel(waiting.approver)} for “{waiting.title}”
          </span>
        )}
      </div>
      {run.error && <p className="text-destructive">{run.error}</p>}
      <Facts>
        <Fact label="Started by">{starterName(run)}</Fact>
        <Fact label="Started">
          <When at={run.createdAt} />
        </Fact>
      </Facts>
      <Section title="Input">
        <Input value={input} />
      </Section>
      <Section title="Ledger">
        {ledgerError ? (
          <Notice variant="destructive">Could not read the ledger: {ledgerError}</Notice>
        ) : ledger.length === 0 ? (
          <None>Nothing recorded yet.</None>
        ) : (
          <LedgerTrace ledger={ledger} titles={titles} />
        )}
      </Section>
    </>
  );
}

/** A run's input: an object's fields as facts, a text as it is, anything else as JSON. */
function Input({ value }: { value: unknown }) {
  if (value === undefined) return <None />;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return <Json value={value} />;
  const fields = Object.entries(value);
  if (fields.length === 0) return <None>No fields.</None>;
  return (
    <Facts>
      {fields.map(([key, field]) => (
        <Fact key={key} label={key}>
          {typeof field === "string" ? field : <code className="text-xs">{JSON.stringify(field)}</code>}
        </Fact>
      ))}
    </Facts>
  );
}
