import type { CollectionEntry, ConfigDescription, SiteEntry, WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, type MouseEvent, type ReactElement } from "react";
import { Card } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { ButtonLink, CrumbHeader, LinkTab, LinkTabs, Nothing, SiteLink } from "../../components/common.tsx";
import { LinkRow } from "../../components/runs-table.tsx";
import { useSites } from "#/lib/sites.ts";
import { configQuery, DataListSearch, ROOT_APP } from "../../queries.ts";

export const Route = createFileRoute("/data/")({ validateSearch: DataListSearch, component: DataPage });

/** A collection's row: the collection, the workflows that save to it and the sites that call it. */
interface Row {
  collection: CollectionEntry;
  writtenBy: WorkflowEntry[];
  shownOn: SiteEntry[];
}

/** The collections one folder declares: the root's (`ROOT_APP`) or an app's, with where it is. */
interface Group {
  key: string;
  title: string;
  /** The folder, and for a taken app its source. */
  detail: string;
  rows: Row[];
}

/**
 * The config's collections grouped by the folder that declares them, the root's first ("Yours"),
 * then each app's in the apps' order; a folder with none is left out. Each row with the workflows
 * whose `uses` save to it (`data.<name>.save`, the built-ins left out) and the sites whose calls
 * name it.
 */
function groupsOf(config: ConfigDescription): Group[] {
  const rowOf = (collection: CollectionEntry): Row => {
    const save = `data.${collection.name}.save`;
    return {
      collection,
      writtenBy: config.workflows.filter((wf) => !wf.builtin && wf.ops.includes(save)),
      shownOn: config.sites.filter((site) =>
        site.calls.some((call) => call.kind === "collection" && call.target === collection.name),
      ),
    };
  };
  const rows = (app: string | undefined) => config.collections.filter((c) => c.app === app).map(rowOf);
  return [
    { key: ROOT_APP, title: "Yours", detail: "the root", rows: rows(undefined) },
    ...config.apps.map((app) => ({
      key: app.name,
      title: app.name,
      detail: app.source ? `${app.dir}, from ${app.source}` : app.dir,
      rows: rows(app.name),
    })),
  ].filter((group) => group.rows.length > 0);
}

/** A link inside a row that opens the grid: its own page, not the row's. */
const stop = (e: MouseEvent) => e.stopPropagation();

/**
 * Every collection of the config, with how many there are; while they are in more than one folder,
 * the tabs All, Yours (the root's) and each app's (`?app=`), with how many each, and the rows under
 * a heading per folder. One card holds the table: a row opens its grid. With sites, the header
 * leads to the Sites page, which the bar has no tile for.
 */
function DataPage() {
  const { app } = Route.useSearch();
  const { data: groups } = useSuspenseQuery({ ...configQuery(), select: groupsOf });
  const sites = useSites().length > 0;
  const total = groups.reduce((n, group) => n + group.rows.length, 0);
  // An app with no collections, or none of that name, shows them all.
  const tab = groups.some((group) => group.key === app) ? app : undefined;
  const shown = tab === undefined ? groups : groups.filter((group) => group.key === tab);
  const headed = shown.length > 1;
  return (
    <>
      <CrumbHeader
        count={total}
        action={
          sites && (
            <ButtonLink variant="outline" size="sm">
              <Link to="/sites">Sites</Link>
            </ButtonLink>
          )
        }
      />
      {groups.length > 1 && (
        <LinkTabs label="Show" value={tab ?? "all"}>
          <LinkTab value="all" link={<Link to="/data" search={{}} />} count={total}>
            All
          </LinkTab>
          {groups.map((group) => (
            <LinkTab
              key={group.key}
              value={group.key}
              link={<Link to="/data" search={{ app: group.key }} />}
              count={group.rows.length}
            >
              {group.title}
            </LinkTab>
          ))}
        </LinkTabs>
      )}
      <Card className="gap-0 py-0">
        {total === 0 ? (
          <Nothing className="border-0" title="This config has no collections">
            Declare them in <code>resources/data.ts</code>, each with <code>collection()</code> from{" "}
            <code>sanoma/data</code>.
          </Nothing>
        ) : (
          <>
            <p className="border-b p-3 text-sm text-muted-foreground">
              A collection is declared in its folder&apos;s <code>resources/</code>; an app&apos;s folder names it. Its
              records live in the company&apos;s database: open one for its grid.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Collection</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Fields</TableHead>
                  <TableHead>Written by</TableHead>
                  <TableHead>Shown on</TableHead>
                  <TableHead>Declared in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((group) => (
                  <Fragment key={group.key}>
                    {headed && (
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableHead colSpan={6} scope="colgroup" className="h-8 text-xs text-foreground">
                          {group.title} <span className="font-normal text-muted-foreground">· {group.detail}</span>
                        </TableHead>
                      </TableRow>
                    )}
                    {group.rows.map((row) => (
                      <CollectionRow key={row.collection.name} row={row} />
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </>
  );
}

/** A collection's row, opening its grid; each name in it links to its own page. */
function CollectionRow({ row: { collection, writtenBy, shownOn } }: { row: Row }) {
  const { name, title, key, fields, declared } = collection;
  return (
    <LinkRow link={{ to: "/data/$name", params: { name } }}>
      <TableCell className="font-medium">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/data/$name" params={{ name }} onClick={stop}>
            {title ?? name}
          </Link>
          <code className="text-xs font-normal text-muted-foreground">data.{name}</code>
        </div>
      </TableCell>
      <TableCell>
        <code>{key}</code>
      </TableCell>
      <TableCell className="whitespace-normal text-muted-foreground">{Object.keys(fields).join(", ")}</TableCell>
      <TableCell className="whitespace-normal">
        <Names
          items={writtenBy.map((wf) => (
            <Link key={wf.name} to="/workflows/$name" params={{ name: wf.name }} onClick={stop}>
              {wf.title ?? wf.name}
            </Link>
          ))}
        />
      </TableCell>
      <TableCell className="whitespace-normal">
        <Names
          items={shownOn.map((site) => (
            <SiteLink key={site.name} site={site} onClick={stop} />
          ))}
        />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {declared ? (
          <Link
            to="/hosting"
            search={{ resource: declared.id }}
            onClick={stop}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {declared.at.file}
          </Link>
        ) : (
          "-"
        )}
      </TableCell>
    </LinkRow>
  );
}

/** Names in a cell, between commas; a dash for none. */
function Names({ items }: { items: ReactElement[] }) {
  if (items.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <span>
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && ", "}
          {item}
        </Fragment>
      ))}
    </span>
  );
}
