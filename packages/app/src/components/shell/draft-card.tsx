import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { isEnded } from "@sanoma-ai/workflows/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { phaseLabel } from "#/lib/changes.ts";
import type { DraftCard } from "#/lib/chat.ts";
import { CHANGE_TONE } from "#/lib/tone.ts";
import { plural } from "#/lib/utils.ts";
import { changeQuery, remoteQuery, useOpenChange } from "#/queries.ts";
import { ButtonLink, CardHeading, Tip, ToneBadge } from "../kit.tsx";

// The chat's draft card (the `data-draft` part an engine writes): the draft, its checks, and how
// it goes live. Off `common.tsx`, so a test renders it on the server.

/**
 * The draft's card: its branch, what it changes (git's summary), its checks, and how it goes
 * live: with a remote, sent for review as a change (`Review`); without one, merging its branch by
 * hand, the live instance running the old code until it restarts.
 */
export function DraftCardView({ draft }: { draft: DraftCard }) {
  const { checks } = draft;
  const { data: remote } = useSuspenseQuery(remoteQuery());
  return (
    <Card size="sm" role="region" aria-label="Draft">
      <CardHeader>
        <CardHeading>
          <span className="flex items-center gap-1.5">
            <GitBranchIcon aria-hidden="true" className="shrink-0" />
            <code className="truncate">{draft.branch}</code>
          </span>
        </CardHeading>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {draft.summary ? (
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre">{draft.summary}</pre>
        ) : (
          <p className="text-muted-foreground">No change committed yet.</p>
        )}
        {checks === undefined ? (
          <p className="text-muted-foreground">Not checked since the last edit.</p>
        ) : checks.ok ? (
          <p className="flex items-center gap-1.5">
            <CheckIcon aria-hidden="true" /> Checks pass
            {checks.warnings.length > 0 && `, with ${plural(checks.warnings.length, "warning")}`}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-destructive">
              <XIcon aria-hidden="true" /> Checks fail: {plural(checks.problems.length, "problem")}
            </p>
            <ul className="list-disc pl-5 font-mono text-xs break-words">
              {checks.problems.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t text-xs text-muted-foreground">
        {/* A card saved before cards carried their draft's id keeps its old words. */}
        {remote && draft.draft !== undefined ? (
          <Review draft={draft} />
        ) : (
          "Merge the branch to apply it. The live instance keeps running the old code until it restarts."
        )}
      </CardFooter>
    </Card>
  );
}

/**
 * Where the draft goes from here, on a repository with a remote: its change's phase and Open the
 * review once it has one, and Send for review while it has none open and none published (disabled,
 * saying why, until something is committed and the checks since the last edit pass).
 */
function Review({ draft }: { draft: DraftCard }) {
  const { data: change, error } = useQuery(changeQuery(draft.draft));
  const send = useOpenChange();
  if (error && !isNotFound(error)) return <>Could not read its change: {error.message}</>;
  if (!change && !error) return null;
  const why =
    draft.files.length === 0
      ? "Nothing is committed on the draft yet."
      : draft.checks === undefined
        ? "Run the checks first: ask the agent to check the draft."
        : draft.checks.ok
          ? undefined
          : "The checks fail: fix what they find first.";
  const button = (
    <Button
      size="xs"
      disabled={why !== undefined || send.isPending}
      focusableWhenDisabled
      className="data-disabled:opacity-50"
      onClick={() => send.mutate(draft.draft)}
    >
      Send for review
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {change && (
        <>
          <ToneBadge dot tone={CHANGE_TONE[change.state.phase]}>
            {phaseLabel(change.state)}
          </ToneBadge>
          <ButtonLink variant="outline" size="xs">
            <Link to="/changes/$id" params={{ id: draft.draft }}>
              Open the review
            </Link>
          </ButtonLink>
        </>
      )}
      {(!change || (isEnded(change.status) && change.state.phase !== "merged")) &&
        (why === undefined ? button : <Tip tip={why}>{button}</Tip>)}
    </div>
  );
}
