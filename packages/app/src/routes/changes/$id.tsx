import { CHANGE_WORKFLOW } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChangeDecision } from "#/components/change-decision.tsx";
import { PullRequestLink } from "#/components/change-glance.tsx";
import {
  CrumbHeader,
  FloatHost,
  Notice,
  pageTitle,
  plural,
  Region,
  Section,
  ToneBadge,
  When,
} from "#/components/common.tsx";
import { PermissionsDiff } from "#/components/permissions-diff.tsx";
import { filesOf, groupFiles, isSettled, phaseLabel, ruleOf } from "#/lib/changes.ts";
import { diffGrids } from "#/lib/grid-diff.ts";
import { CHANGE_TONE } from "#/lib/tone.ts";
import { type ChangeDetail, runName, starterName } from "#/api.ts";
import { changeQuery, configQuery, permissionsQuery, runLink, workflowTitles } from "#/queries.ts";

export const Route = createFileRoute("/changes/$id")({
  // The change, and main's Permissions grid, which its branch's is diffed against.
  loader: async ({ context: { queryClient }, params }) => {
    const [change] = await Promise.all([
      queryClient.query({ ...changeQuery(params.id), staleTime: "static" }),
      queryClient.query({ ...permissionsQuery(), staleTime: "static" }),
    ]);
    return { crumb: change.state.title };
  },
  // The review beside its floating decision takes the width there is.
  staticData: { wide: true },
  head: ({ loaderData }) => pageTitle(loaderData?.crumb),
  component: ChangePage,
  // getChange throws the router's not-found for a draft with no change.
  notFoundComponent: () => <Notice variant="destructive">No change {Route.useParams().id}.</Notice>,
});

/**
 * A change's review, in the ops manager's words: under Changes, its title, where it is, and a
 * line for the developer (its branch, its pull request, who opened it when, its run); then one
 * card: why it cannot publish, the runs it would strand, what changed by kind and who may do
 * what, with the decision (`ChangeDecision`) floating over its right.
 */
function ChangePage() {
  const { id } = Route.useParams();
  const { data: change, error } = useSuspenseQuery(changeQuery(id));
  const { state } = change;
  return (
    <>
      <CrumbHeader>
        <ToneBadge dot tone={CHANGE_TONE[state.phase]}>
          {phaseLabel(state)}
        </ToneBadge>
        <span className="text-muted-foreground">
          {state.branch && (
            <>
              <code>{state.branch}</code> ·{" "}
            </>
          )}
          {state.pullRequest && (
            <>
              <PullRequestLink pullRequest={state.pullRequest} /> ·{" "}
            </>
          )}
          opened by {starterName(change)} · <When at={change.createdAt} /> ·{" "}
          <Link {...runLink({ runId: change.runId, workflow: CHANGE_WORKFLOW })}>{runName(change.runId)}</Link>
        </span>
      </CrumbHeader>
      {error && <Notice variant="destructive">Could not refresh: {error.message}</Notice>}
      <FloatHost float={<ChangeDecision change={change} />}>
        <div className="flex flex-col gap-(--gap-region) p-4">
          <Refusal change={change} />
          <Stranded change={change} />
          <WhatChanged change={change} />
          <WhoMayDoWhat change={change} />
        </div>
      </FloatHost>
    </>
  );
}

/** Why the change cannot publish now, until it is merged or closed: the policy's deny (its rule and reason), else what blocks it. */
function Refusal({ change: { state } }: { change: ChangeDetail }) {
  const { decision } = state;
  if (isSettled(state)) return null;
  if (decision?.answer === "deny") {
    const rule = ruleOf(decision);
    return (
      <Notice variant="destructive">
        {rule ? `${rule}: ` : ""}
        {decision.reason ?? "the policy refuses this change"}
      </Notice>
    );
  }
  if (state.phase === "blocked" && state.blocked) {
    return <Notice variant="destructive">This change cannot publish now: {state.blocked}</Notice>;
  }
  return null;
}

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * Until the change is merged or closed, the waiting runs of the workflows it edits, as its last
 * plan found them, which publishing cannot move: "2 runs of Offboarding are waiting, and this
 * change edits Offboarding", each run linked.
 */
function Stranded({ change }: { change: ChangeDetail }) {
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  const stranded = change.state.facts?.stranded ?? [];
  if (stranded.length === 0 || isSettled(change.state)) return null;
  const names = AND.format(change.edits.map((name) => titles[name] ?? name));
  const one = stranded.length === 1;
  return (
    <Notice>
      {plural(stranded.length, "run")} of{" "}
      {names ? `${names}, which this change edits,` : "the workflows this change edits"} {one ? "is" : "are"} waiting:
      publishing cannot move {one ? "it" : "them"} to the new version.{" "}
      {stranded.map((runId, i) => (
        <span key={runId}>
          {i > 0 && ", "}
          <Link to="/runs/$id" params={{ id: runId }}>
            {runName(runId)}
          </Link>
        </span>
      ))}
    </Notice>
  );
}

/** The files the change edits, a section per kind (`groupFiles`), each file's path. */
function WhatChanged({ change: { state } }: { change: ChangeDetail }) {
  const groups = groupFiles(filesOf(state.facts));
  return (
    <Region title="What changed">
      {!state.facts ? (
        <p className="text-sm text-muted-foreground">Sanoma has not read the change yet.</p>
      ) : (
        groups.map(({ key, title, files }) => (
          <Section key={key} title={title}>
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li key={file}>
                  <code className="text-xs">{file}</code>
                </li>
              ))}
            </ul>
          </Section>
        ))
      )}
    </Region>
  );
}

/**
 * The Permissions grid, main's against the branch's (`PermissionsDiff`), when the change alters
 * it; when it changes the rules and its grid could not be read (its policies do not hold), why.
 */
function WhoMayDoWhat({ change: { state } }: { change: ChangeDetail }) {
  const { data: main } = useSuspenseQuery(permissionsQuery());
  const branch = state.check?.grid;
  if (branch && diffGrids(main, branch).changed) {
    return (
      <Region title="Who may do what">
        <PermissionsDiff before={main} after={branch} />
      </Region>
    );
  }
  if (!branch && state.facts?.rules) {
    return (
      <Region title="Who may do what">
        <Notice variant="destructive">
          The branch's Permissions grid could not be computed
          {state.check?.problems.length ? `: ${state.check.problems.join("; ")}` : ""}.
        </Notice>
      </Region>
    );
  }
  return null;
}
