import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost, testRepository } from "@sanoma-ai/testing/host";
import { type FollowOutput, memoryLedger, type RemoteEvent, resolveConfig } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { delivery, FAKE_WEBHOOK_SECRET, fakeRemote, memorySource, sha } from "../../workflows/test/fakes/remote.ts";
import { ALICE, freshDatabase, pending, rootWith, testhostInfra, waitFor } from "../../workflows/test/harness.ts";
import { type App, startApp } from "../src/index.ts";
import type { AppContext } from "../src/context.ts";
import { type AppHandler, appHandler } from "../src/handler.ts";
import { remoteWebhook } from "../src/server/webhooks.ts";
import { appSnapshot } from "../src/snapshot-build.ts";

// Needs Postgres (`pnpm db:up`) and the built app. A git host's webhooks at `POST /webhooks/<vendor>`
// (`remoteWebhook`), on the fake host of the change workflow's tests, whose deliveries are signed
// JSON (an HMAC of the body), verified by the app and followed by the worker, which has the
// repository, in a run of `follow` per event: a push to `main` applies the declared host, a push
// to a draft's branch tells its change; an unsigned delivery, a vendor with no webhooks and a
// secret not stored are refused. On the Node app, and on the portable handler alone, without the
// checkout, as on the Worker.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "webhook-secret-value";
const repo = { owner: "acme", name: "company" };

const git = testRepository();
const root = rootWith({ "resources/people.ts": ALICE, "resources/infra.ts": testhostInfra(git.url) });
const host = fakeHost(async () => ({ url: "http://127.0.0.1:4100", stop: async () => {} }));
const remote = fakeRemote();
const source = memorySource({ root, remote });
const testApp = useTestApp(
  {
    workflows: [],
    connectors: [host.connector, remote.connector],
    ledger: memoryLedger(),
    root,
    secrets: { bindings: { [FAKE_WEBHOOK_SECRET]: { env: FAKE_WEBHOOK_SECRET } } },
  },
  { databaseUrl: freshDatabase("webhooks"), source: source.source },
);
let app: App;
/** The app's handler with no checkout (`local`), as the Worker's bundle makes it: its pages answer nothing here. */
let portable: AppHandler;

beforeAll(async () => {
  vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv(FAKE_WEBHOOK_SECRET, SECRET);
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  await git.commit();
  app = await startApp(testApp.config, { port: 0, source: source.source });
  const snapshot = await appSnapshot(testApp.config);
  portable = appHandler(
    {
      resolved: resolveConfig(testApp.config),
      snapshot: () => snapshot,
      client: testApp.client,
      login: { name: "none", check() {}, resolveActor: async () => undefined },
      sites: new Map(),
      entry: { fetch: () => new Response("no pages here", { status: 404 }) },
    },
    snapshot,
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await host.close();
  vi.unstubAllEnvs();
  git.remove();
  source.remove();
});

/** A delivery to the app, signed with `secret` (null: unsigned). */
const deliver = (events: RemoteEvent[], secret: string | null = SECRET) =>
  fetch(`${app.url}/webhooks/fakegit`, delivery(events, secret ?? undefined));

/** The same delivery to the portable handler. */
const deliverPortable = (events: RemoteEvent[], secret: string | null = SECRET) =>
  portable.fetch(new Request("http://company.example/webhooks/fakegit", delivery(events, secret ?? undefined)));

/** The follow runs started, newest first. */
const follows = async () => (await testApp.client.runs({ workflow: "follow" })).map((r) => r.runId);

describe("POST /webhooks/<vendor>", () => {
  it("applies the declared host on a signed push to main, in one follow run however often it is delivered", async () => {
    const head = await git.commit();
    const push: RemoteEvent = { kind: "pushed", repo, branch: "main", head };
    expect((await deliver([push])).status).toBe(204);
    expect((await deliver([push])).status).toBe(204);
    const [runId, ...more] = await follows();
    expect(more).toEqual([]);
    expect(await testApp.client.result(runId!)).toEqual({ followed: "main", deploy: `deploy:${head}` });
    const runs = await testApp.client.runs({ workflow: "apply" });
    expect(runs.map((r) => r.runId)).toEqual([`deploy:${head}`]);
    const report = await testApp.client.applyReport(`deploy:${head}`);
    expect(report.results).toEqual([expect.objectContaining({ id: "resources/infra.ts#app", status: "done" })]);
  });

  it("verifies a push to a draft's branch on the portable handler, without the checkout, and the worker brings it into the draft", async () => {
    source.edit("x", { "notes/x.md": "\n" });
    const runId = await testApp.client.openChange({ id: "x", title: "X" }, { startedBy: "alice" });
    await waitFor(pending(() => testApp.client, runId));
    const head = sha("pushed on the host");
    remote.push("draft/x", head);
    const before = await follows();
    expect((await deliverPortable([{ kind: "pushed", repo, branch: "draft/x", head }])).status).toBe(204);
    const [follow] = (await follows()).filter((id) => !before.includes(id));
    expect((await testApp.client.result(follow!)) as FollowOutput).toEqual({ change: "x", told: "commits" });
    expect(await source.source.head("draft/x")).toBe(head);
    // Publish, decided, finds the commits and plans the new head.
    await testApp.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    await waitFor(pending(() => testApp.client, runId, 2));
    expect((await testApp.client.change("x"))!.state.head).toBe(head);
    await testApp.client.changeEvent("x", { kind: "close", by: "alice" }, { by: "alice" });
    await testApp.client.result(runId);
  });

  it("refuses an unsigned or wrongly signed delivery: 401, and starts nothing", async () => {
    const push: RemoteEvent = { kind: "pushed", repo, branch: "main", head: sha("unsigned") };
    const before = await follows();
    expect((await deliver([push], null)).status).toBe(401);
    expect((await deliver([push], "another secret")).status).toBe(401);
    expect((await deliverPortable([push], "another secret")).status).toBe(401);
    expect(await follows()).toEqual(before);
  });

  it("is 404 for a vendor with no webhooks, and while the secret is not stored; POST only", async () => {
    const ctx = { resolved: { remotes: new Map() } } as unknown as AppContext;
    expect((await remoteWebhook(ctx, "github", new Request("http://x/", delivery([])))).status).toBe(404);
    vi.stubEnv(FAKE_WEBHOOK_SECRET, "");
    try {
      expect((await deliver([])).status).toBe(404);
      expect((await deliverPortable([])).status).toBe(404);
    } finally {
      vi.stubEnv(FAKE_WEBHOOK_SECRET, SECRET);
    }
    expect((await fetch(`${app.url}/webhooks/fakegit`)).status).toBe(405);
    expect((await deliver([])).status).toBe(204);
  });
});
