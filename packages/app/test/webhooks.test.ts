import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost, testRepository } from "@sanoma-ai/testing/host";
import { memoryLedger, type RemoteEvent } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { delivery, FAKE_WEBHOOK_SECRET, fakeRemote, memorySource, sha } from "../../workflows/test/fakes/remote.ts";
import { freshDatabase, pending, rootWith, waitFor } from "../../workflows/test/harness.ts";
import { type App, startApp } from "../src/index.ts";
import type { AppContext } from "../src/context.ts";
import { remoteWebhook } from "../src/server/webhooks.ts";

// Needs Postgres (`pnpm db:up`) and the built app. A git host's webhooks at `POST /webhooks/<vendor>`
// (`remoteWebhook`), on the fake host of the change workflow's tests, whose deliveries are signed
// JSON: a push to `main` applies the declared host, a push to a draft's branch tells its change,
// and an unsigned delivery, a vendor with no webhooks and a secret not stored are refused.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "webhook-secret-value";
const repo = { owner: "acme", name: "company" };

const git = testRepository();
const root = rootWith({
  "resources/people.ts": `import { sanoma } from "sanoma/resources";\n\nexport const alice = sanoma.person({ id: "alice" });\n`,
  "resources/infra.ts": [
    'import { testhost } from "@sanoma-ai/testing-host/resources";',
    "",
    `export const app = testhost.app({ name: "company", source: ${JSON.stringify(git.url)}, ref: "main", port: 0 });`,
    "",
  ].join("\n"),
});
const host = fakeHost(async () => ({ url: "http://127.0.0.1:4100", stop: async () => {} }));
const remote = fakeRemote();
const source = memorySource({ root, remote });
const testApp = useTestApp(
  { workflows: [], connectors: [host.connector, remote.connector], ledger: memoryLedger(), root },
  { databaseUrl: freshDatabase("webhooks"), source: source.source },
);
let app: App;

beforeAll(async () => {
  vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv(FAKE_WEBHOOK_SECRET, SECRET);
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  await git.commit();
  app = await startApp(testApp.config, { port: 0, source: source.source });
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

describe("POST /webhooks/<vendor>", () => {
  it("applies the declared host on a signed push to main, once however often it is delivered", async () => {
    const head = await git.commit();
    const push: RemoteEvent = { kind: "pushed", repo, branch: "main", head };
    expect((await deliver([push])).status).toBe(204);
    expect((await deliver([push])).status).toBe(204);
    const runs = await testApp.client.runs({ workflow: "apply" });
    expect(runs.map((r) => r.runId)).toEqual([`deploy:${head}`]);
    const report = await testApp.client.applyReport(`deploy:${head}`);
    expect(report.results).toEqual([expect.objectContaining({ id: "resources/infra.ts#app", status: "done" })]);
  });

  it("brings a signed push to a draft's branch into the draft and tells its change: commits", async () => {
    source.edit("x", { "notes/x.md": "\n" });
    const runId = await testApp.client.openChange({ id: "x", title: "X" }, { startedBy: "alice" });
    await waitFor(pending(() => testApp.client, runId));
    const head = sha("pushed on the host");
    remote.push("draft/x", head);
    expect((await deliver([{ kind: "pushed", repo, branch: "draft/x", head }])).status).toBe(204);
    expect(await source.source.head("draft/x")).toBe(head);
    // Publish, decided, finds the commits and plans the new head.
    await testApp.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    await waitFor(pending(() => testApp.client, runId, 2));
    expect((await testApp.client.change("x"))!.state.head).toBe(head);
    await testApp.client.changeEvent("x", { kind: "close", by: "alice" }, { by: "alice" });
    await testApp.client.result(runId);
  });

  it("refuses an unsigned or wrongly signed delivery: 401, and does nothing", async () => {
    const push: RemoteEvent = { kind: "pushed", repo, branch: "main", head: sha("unsigned") };
    expect((await deliver([push], null)).status).toBe(401);
    expect((await deliver([push], "another secret")).status).toBe(401);
    const runs = await testApp.client.runs({ workflow: "apply" });
    expect(runs.map((r) => r.runId)).not.toContain(`deploy:${push.head}`);
  });

  it("is 404 for a vendor with no webhooks, and while the secret is not stored; POST only", async () => {
    const ctx = { resolved: { remotes: new Map() } } as unknown as AppContext;
    expect((await remoteWebhook(ctx, "github", new Request("http://x/", delivery([])))).status).toBe(404);
    vi.stubEnv(FAKE_WEBHOOK_SECRET, "");
    try {
      expect((await deliver([])).status).toBe(404);
    } finally {
      vi.stubEnv(FAKE_WEBHOOK_SECRET, SECRET);
    }
    expect((await fetch(`${app.url}/webhooks/fakegit`)).status).toBe(405);
    expect((await deliver([])).status).toBe(204);
  });
});
