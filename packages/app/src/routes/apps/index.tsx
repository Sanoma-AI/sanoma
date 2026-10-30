import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import type { AppEntry, ConfigDescription } from "@sanoma-ai/workflows/describe";
import type { AvailableApp } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, Suspense } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { takeAppPrompt } from "#/lib/apps.ts";
import { plural } from "#/lib/utils.ts";
import { useActor } from "../../actor.ts";
import { ChatButton } from "../../components/chat-button.tsx";
import {
  AppBehind,
  CrumbHeader,
  ExternalLink,
  ItemHeading,
  Nothing,
  Notice,
  Region,
  TierBadge,
} from "../../components/common.tsx";
import { availableAppsQuery, configQuery } from "../../queries.ts";

// `/apps`, in the bar's Setup group: where the company's apps are made and taken. An app is a
// folder of `apps/`, made here (no source) or merged from a source repository (`app.ts`'s
// `source`); what it holds is used everywhere else, its sites from the bar, and listed on its own
// page (`$name.tsx`), where a taken one is updated.
export const Route = createFileRoute("/apps/")({ component: AppsPage });

/** An app of the repo, with how much it holds: for the page's rows. */
type RepoApp = AppEntry & { holds: string };

/** The config's apps, each with what it declares in a line: its workflows, collections and sites. */
const selectApps = (config: ConfigDescription): RepoApp[] =>
  config.apps.map((app) => {
    const count = (list: readonly { app?: string }[]) => list.filter((entry) => entry.app === app.name).length;
    const holds = [
      plural(count(config.workflows), "workflow"),
      plural(count(config.collections), "collection"),
      plural(count(config.sites), "site"),
    ].join(" · ");
    return { ...app, holds };
  });

/** A repository's URL as one to compare: no `.git`, no trailing slash, in lower case. */
const sameRepo = (url: string) =>
  url
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

/**
 * The company's apps, then those on GitHub: its own (no source), those taken from a source, each
 * with its source and how far behind it is, each linking to its page (where Update is), and the
 * available ones, each with its README, a solution's demo holding it and Add. New app and Add open
 * the chat with what to ask the agent.
 */
function AppsPage() {
  const { data: apps } = useSuspenseQuery({ ...configQuery(), select: selectApps });
  const yours = apps.filter((app) => app.source === undefined);
  const taken = apps.filter((app) => app.source !== undefined);
  return (
    <>
      <CrumbHeader
        count={apps.length}
        action={
          <ChatButton prompt="Make an app that ">
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            New app
          </ChatButton>
        }
      />
      <Region title="Yours">
        {yours.length === 0 ? (
          <Nothing title="No app of your own yet">
            New app asks the agent to make one: a folder of <code>apps/</code> with its collections, workflows and
            sites.
          </Nothing>
        ) : (
          <ItemGroup>
            {yours.map((app) => (
              <AppItem key={app.name} app={app} />
            ))}
          </ItemGroup>
        )}
      </Region>
      <Region title="Taken">
        {taken.length === 0 ? (
          <Nothing title="No app taken from a source yet">Add one from the apps below.</Nothing>
        ) : (
          <ItemGroup>
            {taken.map((app) => (
              <AppItem key={app.name} app={app}>
                <AppBehind folder={app.name} />
                <ExternalLink href={app.source!}>Source</ExternalLink>
              </AppItem>
            ))}
          </ItemGroup>
        )}
      </Region>
      <Region title="Available">
        <AvailableRegion taken={new Set(taken.map((app) => sameRepo(app.source!)))} />
      </Region>
    </>
  );
}

/** An app of the repo: its name (to its page), folder and source, what it holds, and `children` as its actions. */
function AppItem({ app, children }: { app: RepoApp; children?: ReactNode }) {
  return (
    <Item role="listitem" variant="outline">
      <ItemContent>
        <ItemHeading>
          <Link to="/apps/$name" params={{ name: app.name }}>
            {app.name}
          </Link>
          <code className="font-normal text-muted-foreground">{app.dir}</code>
        </ItemHeading>
        <ItemDescription>
          {app.source && (
            <>
              From <code>{app.source}</code> ·{" "}
            </>
          )}
          {app.holds}
        </ItemDescription>
      </ItemContent>
      {children && <ItemActions>{children}</ItemActions>}
    </Item>
  );
}

/**
 * The apps on GitHub not taken yet: `sanoma.apps.list`, called as the person, so once the page
 * knows who you are (in the browser, with the default login), and read by the page, so GitHub never
 * holds up the rest.
 */
function AvailableRegion({ taken }: { taken: ReadonlySet<string> }) {
  const { actor } = useActor();
  const waiting = <Skeleton className="h-16 w-full" />;
  if (actor === undefined) return waiting;
  if (actor === null) {
    return <Nothing title="Nobody signed in">The apps on GitHub are listed for the person on the page.</Nothing>;
  }
  return (
    <Suspense fallback={waiting}>
      <AvailableList actor={actor} taken={taken} />
    </Suspense>
  );
}

function AvailableList({ actor, taken }: { actor: string; taken: ReadonlySet<string> }) {
  const { data } = useSuspenseQuery(availableAppsQuery(actor));
  const apps = data.apps.filter((app) => !taken.has(sameRepo(app.url)));
  return (
    <>
      {data.error && <Notice>Only the repo&apos;s apps show. {data.error}</Notice>}
      {!data.error && apps.length === 0 && (
        <Nothing title="No other apps found on GitHub">
          An app&apos;s source repository carries the topic <code>sanoma-app</code>.
        </Nothing>
      )}
      {apps.length > 0 && (
        <ItemGroup>
          {apps.map((app) => (
            <AvailableItem key={app.repo} app={app} />
          ))}
        </ItemGroup>
      )}
    </>
  );
}

/** An app on GitHub: its name, tier and what Sanoma says, its description, then its README, Try it and Add. */
function AvailableItem({ app }: { app: AvailableApp }) {
  return (
    <Item role="listitem" variant="outline">
      <ItemContent>
        <ItemHeading>
          {app.repo.slice(app.repo.indexOf("/") + 1)}
          <code className="font-normal text-muted-foreground">{app.repo}</code>
          <TierBadge tier={app.tier} />
          {app.reviewed && <Badge variant="secondary">Reviewed</Badge>}
          {app.blocked && <Badge variant="destructive">Commits blocked</Badge>}
        </ItemHeading>
        <ItemDescription>
          {[app.description, app.license].filter(Boolean).join(" · ") || "No description"}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="flex-wrap">
        <ExternalLink href={`${app.url}#readme`}>README</ExternalLink>
        {app.solutions.flatMap(({ id, title, demo }) =>
          demo ? [<ExternalLink key={id} href={demo}>{`Try it: ${title}`}</ExternalLink>] : [],
        )}
        <ChatButton variant="secondary" prompt={takeAppPrompt(app.url)}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          Add
        </ChatButton>
      </ItemActions>
    </Item>
  );
}
