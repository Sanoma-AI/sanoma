import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLoaderData } from "@tanstack/react-router";
import { BUILT_IN_WORKFLOWS } from "sanoma/workflows/shared";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader } from "#/components/ui/card.tsx";
import { ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { usePending } from "#/lib/inbox.ts";
import { SETUP_STEPS, type SetupStep, starterName } from "../api.ts";
import { approvalKey, configQuery, recentRunsQuery, setupProgressQuery, workflowTitles } from "../queries.ts";
import { ButtonLink, CardHeading, LinkItem, Nothing, PageHeader, Region, When } from "./common.tsx";
import { RunsTable } from "./runs-table.tsx";
import { useChatPrompt } from "./shell/chat-prompt.ts";
import { HOME_SETUP_COOKIE, rememberPref } from "./shell/prefs.ts";

// Home, the app's landing page: setting the company up, what waits on you, and what ran lately.

/** How many of the company's own runs Home lists. */
const RECENT = 10;

/** Each setup step's title, and what it is for, said while it is not done. */
const STEP_WORDS: Record<SetupStep, { title: string; about: string }> = {
  start: { title: "Start the company", about: "Its files, its people and its database, on this computer." },
  agent: { title: "Connect your agent", about: "The agent drafts the company's changes with you, in the chat." },
  try: { title: "Try the sample workflow", about: "Run a workflow of the company's own and see what it did." },
  teammate: { title: "Add a teammate", about: "Declare someone else, so they can sign in and decide." },
  online: { title: "Put it online", about: "Go live, so it runs without this computer." },
};

/** Home: the company's name, the setup card until it is done or hidden, what waits on you, and the latest runs. */
export function Home() {
  const { data: name } = useSuspenseQuery({ ...configQuery(), select: (config) => config.name });
  return (
    <>
      <PageHeader title={name} />
      <SetupCard />
      <WaitingOnYou />
      <RecentRuns />
    </>
  );
}

/**
 * Setting the company up, five steps ticked from facts (`setupProgress`, its last the company
 * online), each not done with what does it: n of 5, and Hide, which its cookie keeps. Gone once
 * all five are done, or hidden.
 */
function SetupCard() {
  const { data: progress } = useQuery(setupProgressQuery());
  const hiddenBefore = useLoaderData({ from: "__root__", select: (data) => data?.setupHidden ?? false });
  const [hidden, setHidden] = useState(hiddenBefore);
  const firstOwn = useSuspenseQuery({
    ...configQuery(),
    select: (config) => config.workflows.find((wf) => !wf.builtin)?.name,
  }).data;
  const chat = useChatPrompt();
  if (!progress || hidden) return null;
  const done = SETUP_STEPS.filter((step) => progress[step]).length;
  if (done === SETUP_STEPS.length) return null;
  const action: Record<SetupStep, ReactNode> = {
    start: null,
    agent: (
      <Button variant="outline" size="sm" onClick={() => chat.chooseAgent()}>
        Connect
      </Button>
    ),
    try: (
      <ButtonLink variant="outline" size="sm">
        {firstOwn ? (
          <Link to="/workflows/$name" params={{ name: firstOwn }} search={{ new: true }}>
            Try it
          </Link>
        ) : (
          <Link to="/workflows">Try it</Link>
        )}
      </ButtonLink>
    ),
    teammate: (
      <ButtonLink variant="outline" size="sm">
        <Link to="/people">Add</Link>
      </ButtonLink>
    ),
    online: (
      <ButtonLink variant="outline" size="sm">
        <Link to="/hosting">Go live</Link>
      </ButtonLink>
    ),
  };
  return (
    <Card role="region" aria-labelledby="setup-title">
      <CardHeader>
        <CardHeading>
          <span id="setup-title">Set up your company</span>
        </CardHeading>
        <CardDescription>
          {done} of {SETUP_STEPS.length} done
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              rememberPref(HOME_SETUP_COOKIE, "hidden");
              setHidden(true);
            }}
          >
            Hide
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3">
          {SETUP_STEPS.map((step) => (
            <li key={step} className="flex items-start gap-3">
              {progress[step] ? (
                <CheckCircleIcon
                  aria-label="Done"
                  weight="fill"
                  className="mt-0.5 size-4 shrink-0 text-tone-ok-foreground"
                />
              ) : (
                <CircleIcon aria-label="To do" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={progress[step] ? "text-muted-foreground" : "font-medium"}>
                  {STEP_WORDS[step].title}
                </span>
                {!progress[step] && <span className="text-muted-foreground">{STEP_WORDS[step].about}</span>}
              </span>
              {!progress[step] && action[step]}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/** The approvals you may decide, each opening in the Inbox; nothing while none waits on you. */
function WaitingOnYou() {
  const { mine } = usePending();
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  if (mine.length === 0) return null;
  return (
    <Region title="Waiting on you">
      <ItemGroup>
        {mine.map((entry) => (
          <LinkItem key={approvalKey(entry)} variant="outline" size="sm">
            <Link to="/inbox" search={{ show: "mine", approval: approvalKey(entry) }}>
              <ItemContent>
                <ItemTitle>{entry.approval.title}</ItemTitle>
                <ItemDescription>
                  {titles[entry.run.workflow] ?? entry.run.workflow} · from {starterName(entry.run)} ·{" "}
                  <When at={entry.approval.requestedAt} />
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <CaretRightIcon aria-hidden="true" />
              </ItemActions>
            </Link>
          </LinkItem>
        ))}
      </ItemGroup>
    </Region>
  );
}

/** The company's own latest runs (the built-ins', chat turns and checks among them, left out), and all of them a link away. */
function RecentRuns() {
  const { data: runs } = useSuspenseQuery({
    ...recentRunsQuery(),
    select: (all) => all.filter((run) => !BUILT_IN_WORKFLOWS.has(run.workflow)).slice(0, RECENT),
  });
  return (
    <Region title="Recent runs">
      <Card className="gap-0 py-0">
        {runs.length === 0 ? (
          <Nothing className="border-0" title="No runs yet">
            A workflow's runs show here once it runs.
          </Nothing>
        ) : (
          <RunsTable runs={runs} />
        )}
        <div className="border-t px-4 py-2">
          <Link
            to="/workflows"
            search={{ view: "runs" }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            All runs
          </Link>
        </div>
      </Card>
    </Region>
  );
}
