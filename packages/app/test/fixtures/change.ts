import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl, waitFor, withFake } from "@sanoma-ai/testing";
import { type TestApp, useTestApp } from "@sanoma-ai/testing/harness";
import {
  type ApprovalState,
  defineConnector,
  defineWorkflow,
  resolveConfig,
  type SanomaClient,
  type SanomaConfig,
} from "@sanoma-ai/workflows";
import { describeConfig, type PermissionsGrid, permissionsGrid } from "@sanoma-ai/workflows/describe";
import { defineFake } from "@sanoma-ai/workflows/fake";
import { CHANGE_MERGE } from "@sanoma-ai/workflows/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Pool } from "pg";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll } from "vitest";
import { z } from "zod";
import { type FakeRemote, fakeRemote, memorySource } from "../../../workflows/test/fakes/remote.ts";
import { ACTOR_COOKIE } from "../../src/api.ts";
import { type App, startApp } from "../../src/index.ts";
import type { DraftCard } from "../../src/lib/chat.ts";

// A company with a remote, for the change pages' tests (the Changes section and a change's review)
// and the lanes that build on them: a worker and the app over C5's fake host (`fakeRemote`) and a
// repository in memory (`memorySource`), people with an `admin` and a `finance` group, a `refund`
// workflow and no policy on main. `draft` opens a real change of a draft, its check answering the
// branch's Permissions grid, and waits for its Publish. Needs Postgres (`pnpm db:up`) and the
// built app.

const appDir = fileURLToPath(new URL("../..", import.meta.url));

export const PEOPLE = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace" });
export const alice = sanoma.person({ id: "alice" });
export const admin = sanoma.group({ name: "admin", members: [ada] });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`;

/** A policy a draft adds: a refund waits for finance unless someone in finance starts it. */
export const REFUNDS_WAIT = `@hold("finance")
@title("Refunds need finance")
forbid (principal, action == Sanoma::Action::"workflow:refund", resource)
unless { principal in Sanoma::Group::"finance" };
`;

const shop = defineConnector("shop", {
  refunds: {
    create: { effect: "money", input: z.object({ amount: z.number().int() }), output: z.object({ id: z.string() }) },
  },
});
const fake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({ refunds: { create: async () => ({ id: "re_1" }) } }),
});
const refund = defineWorkflow({
  name: "refund",
  title: "Refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount }),
});

/** A directory of `files` (a path under it and its text), over a copy of `from` when given. */
function writeRoot(files: Record<string, string>, from?: string): string {
  const root = mkdtempSync(join(tmpdir(), "sanoma-change-"));
  if (from !== undefined) cpSync(from, root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

export interface ChangeApp {
  /** Main's checkout: the people file, no policy. */
  root: string;
  config: SanomaConfig;
  remote: FakeRemote;
  repo: ReturnType<typeof memorySource>;
  testApp: TestApp;
  /** The app over the repository, its remote the fake host's. */
  readonly app: App;
  /** The Permissions grid of main's files with `files` laid over them, as `sanoma check` would report the branch's. */
  gridWith(files: Record<string, string>): PermissionsGrid;
  /**
   * Edits the draft `id` with `files`, its check passing with the branch's grid, opens its change
   * as `startedBy` (alice) and waits for Publish: the change's run id.
   */
  draft(id: string, files: Record<string, string>, options?: { title?: string; startedBy?: string }): Promise<string>;
  /** A page of the app as `as` (ada) sees it, its HTML with React's text separators removed. */
  page(path: string, as?: string): Promise<{ status: number; html: string }>;
}

/**
 * The change fixture for a `describe`: its own database (`name`, dropped first, as a change run
 * left by the last run of the file would be found again), the worker, the app, and their cleanup.
 */
export function useChangeApp(name: string): ChangeApp {
  const databaseUrl = testDatabaseUrl(name);
  beforeAll(async () => {
    const server = new URL(databaseUrl);
    server.pathname = "/postgres";
    const pool = new Pool({ connectionString: server.toString() });
    try {
      await pool.query(`DROP DATABASE IF EXISTS "${new URL(databaseUrl).pathname.slice(1)}" WITH (FORCE)`);
    } finally {
      await pool.end();
    }
  });
  const root = writeRoot({ "resources/people.ts": PEOPLE });
  const branches: string[] = [];
  const remote = fakeRemote();
  const repo = memorySource({ root, remote });
  const config: SanomaConfig = {
    workflows: [refund],
    connectors: [withFake(shop, fake), remote.connector],
    root,
  };
  const testApp = useTestApp(config, { databaseUrl, source: repo.source });
  let app: App | undefined;
  beforeAll(async () => {
    ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
    app = await startApp(testApp.config, { port: 0, source: repo.source });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    repo.remove();
    for (const dir of [root, ...branches]) rmSync(dir, { recursive: true, force: true });
  });

  const fixture: ChangeApp = {
    root,
    config,
    remote,
    repo,
    testApp,
    get app() {
      if (!app) throw new Error("The app has not started");
      return app;
    },
    gridWith(files) {
      const branch = writeRoot(files, root);
      branches.push(branch);
      const at = { ...config, root: branch };
      return permissionsGrid(resolveConfig(at), describeConfig(at));
    },
    async draft(id, files, { title = `Change ${id}`, startedBy = "alice" } = {}) {
      repo.edit(id, files);
      repo.checks(id, { ok: true, problems: [], warnings: [], grid: fixture.gridWith(files) });
      const page = new URL(`/changes/${id}`, fixture.app.url).href;
      const runId = await testApp.client.openChange({ id, title, page }, { startedBy });
      await publishOf(testApp.client, runId);
      return runId;
    },
    page: (path, as) => pageOf(fixture.app, path, as),
  };
  return fixture;
}

/** Whether `approval` is a change's Publish waiting: pending, covering the merge. */
const asksPublish = (approval: ApprovalState) =>
  approval.status === "pending" && approval.covers.includes(CHANGE_MERGE);

/** The change run `runId`'s pending Publish, once it asks (within `timeoutMs`, `waitFor`'s by default). */
export async function publishOf(client: SanomaClient, runId: string, timeoutMs?: number): Promise<ApprovalState> {
  return (
    await waitFor(
      () => client.approvals(runId),
      (all) => all.some(asksPublish),
      timeoutMs,
    )
  ).find(asksPublish)!;
}

/** The change run `runId`'s Publish asked again, once `old` (asked on an earlier head) is withdrawn. */
export async function publishedAgain(
  client: SanomaClient,
  runId: string,
  old: ApprovalState,
  timeoutMs?: number,
): Promise<ApprovalState> {
  const asked = await waitFor(
    () => client.approvals(runId),
    (all) => all.some((a) => a.id === old.id && a.status === "withdrawn") && all.some(asksPublish),
    timeoutMs,
  );
  return asked.find(asksPublish)!;
}

/** A page of `app` as `as` (ada) sees it, its HTML with React's text separators removed. */
export async function pageOf(app: App, path: string, as = "ada"): Promise<{ status: number; html: string }> {
  const res = await fetch(new URL(path, app.url), { headers: { cookie: `${ACTOR_COOKIE}=${as}` } });
  return { status: res.status, html: (await res.text()).replaceAll("<!-- -->", "") };
}

/**
 * A chat's draft card as the server renders it, in a router and over a query cache holding
 * whether the repository has a remote and the draft's change (null when it has none; unread when
 * left out), its HTML with React's text separators removed.
 */
export async function renderDraftCard(
  draft: DraftCard,
  { remote = true, change }: { remote?: boolean; change?: object | null },
): Promise<string> {
  // By a path TypeScript does not follow: the components are JSX and DOM, checked by typecheck:ui,
  // and `queries.ts` defines server functions (see data.test.ts).
  type Keyed = (id?: string) => { queryKey: readonly unknown[] };
  const [{ DraftCardView }, { changeQuery, remoteQuery }] = await Promise.all([
    import(new URL("../../src/components/shell/draft-card.tsx", import.meta.url).href) as Promise<{
      DraftCardView: (props: { draft: DraftCard }) => ReactNode;
    }>,
    import(new URL("../../src/queries.ts", import.meta.url).href) as Promise<{
      changeQuery: Keyed;
      remoteQuery: Keyed;
    }>,
  ]);
  const queryClient = new QueryClient();
  queryClient.setQueryData(remoteQuery().queryKey, remote);
  if (change !== undefined) queryClient.setQueryData(changeQuery(draft.draft).queryKey, change);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () =>
        createElement(QueryClientProvider, { client: queryClient }, createElement(DraftCardView, { draft })),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToString(createElement(RouterProvider, { router })).replaceAll("<!-- -->", "");
}
