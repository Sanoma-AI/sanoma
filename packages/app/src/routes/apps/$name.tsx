import type { AppEntry, ConfigDescription } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Card } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { updateAppPrompt } from "#/lib/apps.ts";
import type { ScenariosResponse } from "../../api.ts";
import { ChatButton } from "../../components/chat-button.tsx";
import {
  AppBehind,
  CrumbHeader,
  ExternalLink,
  LastRun,
  Notice,
  OpName,
  pageTitle,
  plural,
  SiteLink,
} from "../../components/common.tsx";
import { configQuery, lastRunsQuery, opsById, scenariosQuery } from "../../queries.ts";

export const Route = createFileRoute("/apps/$name")({
  // The root route loads the config; each workflow's last run and the scenarios fill two of the
  // card's sections.
  loader: async ({ context: { queryClient }, params }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const app = config.apps.find((entry) => entry.name === params.name);
    if (!app) throw notFound();
    await Promise.all([
      queryClient.query({ ...lastRunsQuery(), staleTime: "static" }),
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
    ]);
    return { crumb: app.name };
  },
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  // Five tables of several columns: the width there is.
  staticData: { wide: true },
  component: AppPage,
  notFoundComponent: () => <Notice variant="destructive">No app {Route.useParams().name}.</Notice>,
});

/**
 * What the app's folder holds, from the description: its sites, collections and workflows (each
 * naming the app), and its policy files (`<dir>/policies/`). People are never an app's: they are
 * declared at the root.
 */
const partsOf = (name: string) => (config: ConfigDescription) => {
  const app = config.apps.find((entry) => entry.name === name);
  if (!app) return undefined;
  const policies = config.policy.files
    .filter(({ file }) => file.startsWith(`${app.dir}/policies/`))
    .map(({ file, text }) => ({
      file,
      rules: text.match(/^\s*(?:permit|forbid)\s*\(/gm)?.length ?? 0,
      reasons: [...text.matchAll(/@reason\("((?:[^"\\]|\\.)*)"\)/g)].map(([, reason]) => reason!),
    }));
  return {
    app,
    sites: config.sites.filter((site) => site.app === name),
    collections: config.collections.filter((c) => c.app === name),
    workflows: config.workflows.filter((wf) => wf.app === name),
    policies,
    ops: opsById(config),
  };
};

/** The scenarios under the app's folder, by feature file, and the files there that could not be read. */
const scenariosUnder = (dir: string) => {
  const inside = (file: string) => file.startsWith(`${dir}/`);
  return ({ scenarios, errors }: ScenariosResponse) => {
    const byFile = Map.groupBy(
      scenarios.filter((s) => inside(s.file)),
      (s) => s.file,
    );
    return {
      files: [...byFile].map(([file, list]) => ({
        file,
        count: list.length,
        workflows: [...new Set(list.map((s) => s.workflow))],
      })),
      errors: errors.filter((e) => inside(e.file)),
    };
  };
};

/**
 * An app's page: its folder and, for one taken from a source, how far behind it is, the source and
 * Update in the header; then its parts in one card, a section each: Sites, Collections, Workflows
 * (what each may call, its last run), Policies and Scenarios.
 */
function AppPage() {
  const { name } = Route.useParams();
  const select = useMemo(() => partsOf(name), [name]);
  const { data: parts } = useSuspenseQuery({ ...configQuery(), select });
  // The loader found it; a config that no longer has it reads as not found.
  if (!parts) throw notFound();
  const { app } = parts;
  return (
    <>
      <CrumbHeader
        action={
          app.source && (
            <>
              <ExternalLink href={app.source}>Source</ExternalLink>
              <ChatButton prompt={updateAppPrompt(app.name)}>Update</ChatButton>
            </>
          )
        }
      >
        {app.source && <AppBehind folder={app.name} />}
      </CrumbHeader>
      <About app={app} />
      <Card className="gap-0 py-0">
        <Part title="Sites" note={`${parts.sites.length} · in the bar`}>
          {parts.sites.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Pages</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead className="text-right">Seen by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parts.sites.map((site) => (
                  <TableRow key={site.name}>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-2">
                        <SiteLink site={site} />
                        <code className="text-xs font-normal text-muted-foreground">/sites/{site.name}</code>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{plural(site.pages.length, "page")}</TableCell>
                    <TableCell className="whitespace-normal">
                      <Codes items={[...new Set(site.calls.map((call) => call.target))]} />
                    </TableCell>
                    <TableCell className="text-right">
                      {site.public ? (
                        <Badge variant="secondary">Visitors</Badge>
                      ) : (
                        <span className="text-muted-foreground">People in the app</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Part>
        <Part title="Collections" note={`${parts.collections.length} · on Data`}>
          {parts.collections.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Collection</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Fields</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parts.collections.map(({ name: collection, title, key, fields }) => (
                  <TableRow key={collection}>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to="/data/$name" params={{ name: collection }}>
                          {title ?? collection}
                        </Link>
                        <code className="text-xs font-normal text-muted-foreground">data.{collection}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code>{key}</code>
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {Object.keys(fields).join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Part>
        <Part title="Workflows" note={`${parts.workflows.length} · on Workflows`}>
          {parts.workflows.length > 0 && <Workflows workflows={parts.workflows} ops={parts.ops} />}
        </Part>
        <Part title="Policies" note={`${plural(parts.policies.length, "file")} · on Permissions`}>
          {parts.policies.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Rules</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parts.policies.map(({ file, rules, reasons }) => (
                  <TableRow key={file}>
                    <TableCell>
                      <code className="text-xs">{file}</code>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{plural(rules, "rule")}</TableCell>
                    <TableCell className="whitespace-normal">{reasons.join("; ") || "-"}</TableCell>
                    <TableCell className="text-right">
                      <Link to="/permissions">See the grid</Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Part>
        <Part title="Scenarios" note="run by sanoma check">
          <Scenarios dir={app.dir} />
        </Part>
      </Card>
      <p className="text-sm text-muted-foreground">
        People are never inside an app: its folder declares collections, workflows, policies and sites, and the
        company&apos;s people stay at the root, on People.
      </p>
    </>
  );
}

/** Where the app is, and where it came from. */
function About({ app }: { app: AppEntry }) {
  return (
    <p className="text-sm text-muted-foreground">
      {app.source ? (
        <>
          Taken from <ExternalLink href={app.source}>{app.source}</ExternalLink> into <code>{app.dir}/</code>.
        </>
      ) : (
        <>
          The company&apos;s own app, in <code>{app.dir}/</code>.
        </>
      )}{" "}
      Everything below lives in that folder and is named <code>{app.name}.</code>…
    </p>
  );
}

/** A section of the app's card: its heading, how many and where else it shows, then its table, or None. */
function Part({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col border-b last:border-b-0">
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
      {children || NONE}
    </section>
  );
}

/** What a section with nothing to list says. */
const NONE = <p className="px-4 pb-3 text-sm text-muted-foreground">None.</p>;

/** Names as code; a dash for none. */
function Codes({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {items.map((item) => (
        <code key={item} className="text-xs">
          {item}
        </code>
      ))}
    </span>
  );
}

/** The app's workflows: each with what it may call, by effect, and its last run, linking to its runs. */
function Workflows({ workflows, ops }: { workflows: ConfigDescription["workflows"]; ops: ReturnType<typeof opsById> }) {
  const { data: last } = useSuspenseQuery(lastRunsQuery());
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead>Uses</TableHead>
          <TableHead>Last run</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Runs</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {workflows.map((wf) => (
          <TableRow key={wf.name}>
            <TableCell className="font-medium">
              <div className="flex flex-wrap items-center gap-2">
                <Link to="/workflows/$name" params={{ name: wf.name }}>
                  {wf.title ?? wf.name}
                </Link>
                <code className="text-xs font-normal text-muted-foreground">{wf.name}</code>
              </div>
            </TableCell>
            <TableCell className="whitespace-normal">
              {wf.ops.length === 0 ? (
                <span className="text-muted-foreground">-</span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {wf.ops.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1.5 text-xs">
                      <OpName id={id} op={ops.get(id)} />
                    </span>
                  ))}
                </span>
              )}
            </TableCell>
            <TableCell>
              <LastRun run={last[wf.name]} none="Never run" />
            </TableCell>
            <TableCell className="text-right">
              <Link to="/workflows/$name" params={{ name: wf.name }} search={{ view: "runs" }}>
                Runs
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The feature files under the app's folder: how many scenarios each holds, for which workflows, or why it cannot be read. */
function Scenarios({ dir }: { dir: string }) {
  const select = useMemo(() => scenariosUnder(dir), [dir]);
  const {
    data: { files, errors },
  } = useSuspenseQuery({ ...scenariosQuery(), select });
  if (files.length === 0 && errors.length === 0) return NONE;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>File</TableHead>
          <TableHead>Scenarios</TableHead>
          <TableHead>Of</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map(({ file, count, workflows }) => (
          <TableRow key={file}>
            <TableCell>
              <code className="text-xs">{file}</code>
            </TableCell>
            <TableCell className="text-muted-foreground">{plural(count, "scenario")}</TableCell>
            <TableCell className="whitespace-normal">
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {workflows.map((workflow) => (
                  <Link key={workflow} to="/workflows/$name" params={{ name: workflow }} search={{ view: "scenarios" }}>
                    {workflow}
                  </Link>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ))}
        {errors.map(({ file, message }) => (
          <TableRow key={file}>
            <TableCell>
              <code className="text-xs">{file}</code>
            </TableCell>
            <TableCell colSpan={2} className="whitespace-normal text-destructive">
              {message}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
