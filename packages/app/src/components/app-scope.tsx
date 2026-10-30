import type { AppEntry } from "@sanoma-ai/workflows/describe";
import type { ReactElement } from "react";
import { TableHead, TableRow } from "#/components/ui/table.tsx";
import { ROOT_APP } from "../queries.ts";
import { LinkTab, LinkTabs } from "./common.tsx";

// An app as a scope on a list (Data, Workflows, Permissions): what each folder holds, the root's
// first, the tabs All and one per folder (`?app=`), and a heading per folder, all only while more
// than one folder holds something.

/** What one folder holds: the root's (`ROOT_APP`) or an app's, with where it is. */
export interface AppGroup<T> {
  key: string;
  title: string;
  /** The folder, and for a taken app its source. */
  detail: string;
  items: T[];
}

/**
 * `items` by the folder that holds them (`appOf`: an app's name, undefined for the root), the
 * root's first ("Yours"), then each app's in the apps' order; a folder with none left out.
 */
export function appGroupsOf<T>(
  apps: readonly AppEntry[],
  items: readonly T[],
  appOf: (item: T) => string | undefined,
): AppGroup<T>[] {
  const of = (app: string | undefined) => items.filter((item) => appOf(item) === app);
  return [
    { key: ROOT_APP, title: "Yours", detail: "the root", items: of(undefined) },
    ...apps.map((app) => ({
      key: app.name,
      title: app.name,
      detail: app.source ? `${app.dir}, from ${app.source}` : app.dir,
      items: of(app.name),
    })),
  ].filter((group) => group.items.length > 0);
}

/**
 * The groups `?app=` picks: the one it names, else all (an app with nothing here, or none of
 * that name, shows all); `tab` the one picked, `headed` whether more than one shows.
 */
export function pickGroup<T>(
  groups: AppGroup<T>[],
  app: string | undefined,
): { tab: string | undefined; shown: AppGroup<T>[]; headed: boolean } {
  const tab = groups.some((group) => group.key === app) ? app : undefined;
  const shown = tab === undefined ? groups : groups.filter((group) => group.key === tab);
  return { tab, shown, headed: shown.length > 1 };
}

/**
 * The tabs All and one per folder, each with how many it holds, while more than one folder holds
 * something: `link(key)` is a tab's `<Link>`, with no children (`undefined` for All).
 */
export function AppTabs<T>({
  groups,
  tab,
  link,
}: {
  groups: AppGroup<T>[];
  tab: string | undefined;
  link: (app: string | undefined) => ReactElement;
}) {
  if (groups.length < 2) return null;
  return (
    <LinkTabs label="App" value={tab ?? "all"}>
      <LinkTab value="all" link={link(undefined)} count={groups.reduce((n, group) => n + group.items.length, 0)}>
        All
      </LinkTab>
      {groups.map((group) => (
        <LinkTab key={group.key} value={group.key} link={link(group.key)} count={group.items.length}>
          {group.title}
        </LinkTab>
      ))}
    </LinkTabs>
  );
}

/** A folder's heading as a table's row across `columns`: its title and where it is. */
export function AppGroupRow({ group, columns }: { group: AppGroup<unknown>; columns: number }) {
  return (
    <TableRow className="bg-muted/50 hover:bg-muted/50">
      <TableHead colSpan={columns} scope="colgroup" className="h-8 text-xs text-foreground">
        <AppGroupTitle group={group} />
      </TableHead>
    </TableRow>
  );
}

/** A folder's title and, muted, where it is. */
export const AppGroupTitle = ({ group }: { group: AppGroup<unknown> }) => (
  <>
    {group.title} <span className="font-normal text-muted-foreground">· {group.detail}</span>
  </>
);
