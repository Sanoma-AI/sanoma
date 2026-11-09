import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { isEnded, undoDraftOf } from "sanoma/workflows/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ChangeDetail, SaveDetail } from "#/api.ts";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { phaseLabel } from "#/lib/changes.ts";
import type { DraftCard } from "#/lib/chat.ts";
import { companyOf } from "#/lib/names.ts";
import { CHANGE_TONE } from "#/lib/tone.ts";
import { plural } from "#/lib/utils.ts";
import { changeQuery, configQuery, remoteQuery, savesQuery, useOpenChange, useSaveDraft } from "#/queries.ts";
import { ButtonLink, CardHeading, Tip, ToneBadge, When } from "../kit.tsx";

// The chat's draft card (the `data-draft` part an engine writes): the draft, its checks, and its
// Save. Off the chat's own components, so a test renders it on the server.

/**
 * The draft's card: its branch, what it changes (git's summary), its checks, and its Save (`Save`).
 */
export function DraftCardView({ draft }: { draft: DraftCard }) {
  const { checks } = draft;
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
        {/* A card saved before cards carried their draft's id cannot name what to save. */}
        {draft.draft === undefined ? (
          "Ask the agent to draft this again to save it."
        ) : (
          <Save draft={draft} id={draft.draft} />
        )}
      </CardFooter>
    </Card>
  );
}

/**
 * Where the draft goes from here. Save to the company (`useSaveDraft`): without a remote it is
 * merged into the company and runs at once; with one, its change is opened as saved, and the
 * policy says whether Publish still waits. With a remote, Review opens the change for review
 * instead. Both disabled, saying why, until something is committed and the checks since the last
 * edit pass. Once saved: who saved it and when, Open the workflow, and Undo.
 */
function Save({ draft, id }: { draft: DraftCard; id: string }) {
  const { data: remote } = useSuspenseQuery(remoteQuery());
  const { data: config } = useSuspenseQuery(configQuery());
  const saves = useQuery(savesQuery(id));
  const change = useQuery({ ...changeQuery(id), enabled: remote });
  const save = useSaveDraft();
  const review = useOpenChange();
  const error = saves.error ?? change.error;
  if (error) return <>Could not read how it was saved: {error.message}</>;
  // Still reading them; the change is null when the draft has none.
  if (saves.data === undefined || (remote && change.data === undefined)) return null;
  const company = companyOf(config.appName).name;
  // This card's save: the one of the commit it shows, or (a card from before cards carried it) the latest.
  const latest = saves.data.find((s) => draft.head === undefined || s.input.head === draft.head);
  const saved = savedOf(latest, change.data ?? undefined);
  if (saved) return <Saved chat={id} saved={saved} company={company} />;
  if (latest && !isEnded(latest.status)) return <>Saving…</>;
  const open = change.data;
  const why =
    draft.files.length === 0
      ? "Nothing is committed on the draft yet."
      : draft.checks === undefined
        ? "Run the checks first: ask the agent to check the draft."
        : draft.checks.ok
          ? undefined
          : "The checks fail: fix what they find first.";
  const busy = save.isPending || review.isPending;
  const action = (label: string, variant: "default" | "outline", onClick: () => void) => {
    const button = (
      <Button
        size="xs"
        variant={variant}
        disabled={why !== undefined || busy}
        focusableWhenDisabled
        className="data-disabled:opacity-50"
        onClick={onClick}
      >
        {label}
      </Button>
    );
    return why === undefined ? button : <Tip tip={why}>{button}</Tip>;
  };
  return (
    <div className="flex flex-col gap-2">
      {latest?.status === "failed" && <p className="text-destructive">Could not save it: {latest.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {open && <ChangeLink id={id} change={open} />}
        {(!open || isEnded(open.status)) && (
          <>
            {action(`Save to ${company}`, "default", () =>
              save.mutate({ id, ...(draft.head !== undefined && { head: draft.head }) }),
            )}
            {remote && action("Review", "outline", () => review.mutate(id))}
          </>
        )}
      </div>
      {!remote && <p>Saving puts it to work on this computer. You can undo it.</p>}
    </div>
  );
}

/** What a draft was saved as: who saved it, when, the commit on main, and the workflows it saved. */
interface SavedAs {
  by: string;
  at: number;
  sha: string;
  edits: string[];
  /** Whether the worker started again on it: false when this instance does not reload, and it waits for a restart. */
  running: boolean;
}

/**
 * What `save` (without a remote) or `change` (with one, once published) saved the draft as;
 * undefined while it is not saved.
 */
function savedOf(save: SaveDetail | undefined, change: ChangeDetail | undefined): SavedAs | undefined {
  if (save?.output && "revision" in save.output) {
    const { revision, running } = save.output;
    return {
      by: save.startedBy?.id ?? "someone",
      at: save.updatedAt ?? save.createdAt,
      sha: revision,
      edits: save.edits,
      running,
    };
  }
  const sha = change?.state.merged?.sha;
  if (!change || sha === undefined) return undefined;
  const publish = change.approvals.findLast((a) => a.status === "approved");
  return {
    by: publish?.decidedBy ?? change.startedBy?.id ?? "someone",
    at: publish?.decidedAt ?? change.updatedAt ?? change.createdAt,
    sha,
    edits: change.edits,
    running: true,
  };
}

/** The chat `chat`'s saved draft: who saved it and when, Open the workflow it saved, and Undo. */
function Saved({ chat, saved, company }: { chat: string; saved: SavedAs; company: string }) {
  const [workflow] = saved.edits;
  return (
    <div className="flex flex-col gap-2">
      <ToneBadge dot tone="ok">
        Saved
      </ToneBadge>
      <p>
        Saved by {saved.by}, <When at={saved.at} />. It's part of {company}
        {saved.running ? "." : ", and runs once Sanoma starts again."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {workflow !== undefined && (
          <ButtonLink variant="outline" size="xs">
            {/* A whole page load: the app may have started again on what was saved. */}
            <a href={`/workflows/${encodeURIComponent(workflow)}`}>Open the workflow</a>
          </ButtonLink>
        )}
        <Undo chat={chat} sha={saved.sha} />
      </div>
    </div>
  );
}

/**
 * Undo of what the chat `chat` saved as `sha`: a draft of its own reverting it (`undoDraftOf`),
 * saved the same way; then where that undo is: under way, failed, done, or with a remote, its change.
 */
function Undo({ chat, sha }: { chat: string; sha: string }) {
  const id = undoDraftOf(sha);
  const { data: remote } = useSuspenseQuery(remoteQuery());
  const { data: saves } = useQuery(savesQuery(id));
  const { data: change } = useQuery({ ...changeQuery(id), enabled: remote });
  const save = useSaveDraft();
  const [latest] = saves ?? [];
  if (change) return <ChangeLink id={id} change={change} />;
  if (latest?.output && "revision" in latest.output) {
    return (
      <span>
        Undone by {latest.startedBy?.id ?? "someone"}, <When at={latest.updatedAt ?? latest.createdAt} />.
      </span>
    );
  }
  if (latest && !isEnded(latest.status)) return <>Undoing…</>;
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        disabled={saves === undefined || save.isPending}
        onClick={() => save.mutate({ id: chat, undo: sha })}
      >
        Undo
      </Button>
      {latest?.status === "failed" && <span className="text-destructive">Could not undo it: {latest.error}</span>}
    </>
  );
}

/** A draft's change: its phase, and Open the review. */
function ChangeLink({ id, change }: { id: string; change: ChangeDetail }) {
  return (
    <>
      <ToneBadge dot tone={CHANGE_TONE[change.state.phase]}>
        {phaseLabel(change.state)}
      </ToneBadge>
      <ButtonLink variant="outline" size="xs">
        <Link to="/changes/$id" params={{ id }}>
          Open the review
        </Link>
      </ButtonLink>
    </>
  );
}
