import type { ChangeView } from "@sanoma-ai/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { Card } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { filesOf, phaseLabel } from "#/lib/changes.ts";
import { CHANGE_TONE } from "#/lib/tone.ts";
import { CrumbHeader, LinkTab, LinkTabs, Nothing, Notice, ToneBadge, When } from "../../components/common.tsx";
import { LinkRow } from "../../components/runs-table.tsx";
import { changesQuery } from "../../queries.ts";

/** Which changes the page lists (`?show=`): the open ones (by default), or those done. */
const ChangesSearch = z.object({ show: z.enum(["open", "done"]).optional().catch(undefined) });

export const Route = createFileRoute("/changes/")({
  validateSearch: ChangesSearch,
  loaderDeps: ({ search: { show } }) => ({ open: show !== "done" }),
  loader: async ({ context: { queryClient }, deps }) => {
    await queryClient.query({ ...changesQuery(deps), staleTime: "static" });
  },
  component: ChangesPage,
});

/**
 * The changes, with how many, the tabs Open and Done (`?show=`), then one card with a table of
 * them, newest first, a row opening the change's review.
 */
function ChangesPage() {
  const show = Route.useSearch().show ?? "open";
  const { data: changes, error } = useSuspenseQuery(changesQuery({ open: show === "open" }));
  return (
    <>
      <CrumbHeader count={changes.length} />
      {error && <Notice variant="destructive">Could not refresh the changes: {error.message}</Notice>}
      <LinkTabs label="Show" value={show}>
        <LinkTab value="open" link={<Link to="/changes" search={{ show: "open" }} />}>
          Open
        </LinkTab>
        <LinkTab value="done" link={<Link to="/changes" search={{ show: "done" }} />}>
          Done
        </LinkTab>
      </LinkTabs>
      <Card className="gap-0 py-0">
        {changes.length === 0 ? (
          <Nothing className="border-0" title={show === "open" ? "No change is open" : "No change is done yet"}>
            A change opens when you send a draft for review.
          </Nothing>
        ) : (
          <ChangesTable changes={changes} />
        )}
      </Card>
    </>
  );
}

/** The changes as a table: each one's title, where it is, how many files it edits, its pull request and when it last moved. */
function ChangesTable({ changes }: { changes: ChangeView[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Change</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Files</TableHead>
          <TableHead>Pull request</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {changes.map(({ runId, state, createdAt, updatedAt }) => {
          const link = { to: "/changes/$id", params: { id: state.id } } as const;
          return (
            <LinkRow key={runId} link={link}>
              <TableCell className="font-medium">
                <Link {...link} onClick={(e) => e.stopPropagation()}>
                  {state.title}
                </Link>
              </TableCell>
              <TableCell>
                <ToneBadge dot tone={CHANGE_TONE[state.phase]}>
                  {phaseLabel(state)}
                </ToneBadge>
              </TableCell>
              <TableCell className="tabular-nums">{state.facts ? filesOf(state.facts).length : "-"}</TableCell>
              <TableCell>
                {state.pullRequest ? (
                  <a href={state.pullRequest.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    #{state.pullRequest.number} <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                <When at={updatedAt ?? createdAt} />
              </TableCell>
            </LinkRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
