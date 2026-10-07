import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { fakeBluesky, fakeGhost, fakeResend } from "@sanoma/testing";
import {
  allow,
  approve,
  type ApprovalState,
  type ConfigDescription,
  defineConfig,
  definePolicy,
  memoryLedger,
  type RunSummary,
  startWorker,
  type Worker,
} from "@sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import announce from "../../workflows/test/fixtures/announce.ts";
import { type App, type RunDetail, startApp } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. A queue name belongs to one app per system database, and the
// workflows tests' app owns the "sanoma" queue in the test database, so this app gets its own
// database beside it (`sanoma_test_app`), which DBOS creates.
const databaseUrl = (() => {
  const url = new URL(process.env.SANOMA_TEST_DATABASE_URL ?? "postgresql://postgres:dbos@localhost:5433/sanoma_test");
  url.pathname = `${url.pathname}_app`;
  return url.toString();
})();

// Holds publish and send for marketing-lead, unless they already approved something in the run.
const policy = definePolicy(({ effect, run }) =>
  (effect === "publish" || effect === "send") &&
  !run.approvals.some((a) => a.approver === "marketing-lead" && a.status === "approved")
    ? approve("marketing-lead")
    : allow(),
);

const config = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: [fakeGhost().driver, fakeResend().driver, fakeBluesky().driver],
  policy,
  ledger: memoryLedger(),
  appName: "sanoma-app-test",
  databaseUrl,
});

// A stand-in for the Vite build, so the tests don't need one. Empty until the page tests fill it.
const uiDir = mkdtempSync(join(tmpdir(), "sanoma-app-ui-"));
let worker: Worker;
let app: App;

beforeAll(async () => {
  worker = await startWorker(config);
  app = await startApp(config, { port: 0, uiDir });
});

afterAll(async () => {
  await app?.close();
  await worker?.stop();
  rmSync(uiDir, { recursive: true, force: true });
});

async function call<T = any>(path: string, init: { method?: string; body?: unknown; actor?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.actor !== undefined) headers["x-sanoma-actor"] = init.actor;
  const res = await fetch(new URL(path, app.url), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function waitFor<T>(get: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last saw ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const detail = async (runId: string) => (await call<RunDetail>(`/api/runs/${runId}`)).body;

describe("the API", () => {
  it("describes the config", async () => {
    const { status, body } = await call<ConfigDescription>("/api/config");
    expect(status).toBe(200);
    expect(body.appName).toBe("sanoma-app-test");
    expect(body.policy.defined).toBe(true);
    const wf = body.workflows.find((w) => w.name === "announce");
    expect(wf?.ops).toHaveLength(5);
    expect(wf?.ops).toEqual(expect.arrayContaining(["ghost.post.publish", "resend.broadcast.send"]));
    expect(wf?.builtins).toEqual(["approval", "sleep"]);
    expect(body.ops.find((o) => o.id === "resend.broadcast.send")?.effect).toBe("send");
  });

  it("refuses to start a run without an actor, with an unknown workflow, or with input the schema refuses", async () => {
    const input = { title: "x", body: "<p>x</p>", launchAt: new Date().toISOString() };
    const anonymous = await call("/api/runs", { method: "POST", body: { workflow: "announce", input } });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.error).toMatch(/x-sanoma-actor/);

    const unknown = await call("/api/runs", { method: "POST", actor: "alice", body: { workflow: "nope", input } });
    expect(unknown.status).toBe(404);

    const { title: _, ...untitled } = input;
    const invalid = await call("/api/runs", {
      method: "POST",
      actor: "alice",
      body: { workflow: "announce", input: untitled },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/schema/);
    expect(invalid.body.issues).toEqual([expect.objectContaining({ path: ["title"], message: expect.any(String) })]);
  });

  it("starts a run as the actor, holds it for the approver, refuses anyone else, then finishes", async () => {
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: "alice",
      body: {
        workflow: "announce",
        input: { title: "From the app", body: "<p>Hello</p>", launchAt: new Date(Date.now() - 60_000).toISOString() },
      },
    });
    expect(started.status).toBe(201);
    const { runId } = started.body;
    expect(runId).toEqual(expect.any(String));

    const runs = await call<RunSummary[]>("/api/runs?limit=50");
    expect(runs.body.find((r) => r.runId === runId)).toMatchObject({
      workflow: "announce",
      startedBy: { id: "alice" },
    });

    const held = await waitFor(
      () => detail(runId),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    const approval = held.approvals[0]!;
    expect(approval).toMatchObject({ id: "approval-1", approver: "marketing-lead", status: "pending" });
    const decide = `/api/runs/${runId}/approvals/${approval.id}`;

    const anonymous = await call(decide, { method: "POST", body: { decision: "approve" } });
    expect(anonymous.status).toBe(400);
    const wrong = await call(decide, { method: "POST", actor: "someone-else", body: { decision: "approve" } });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ error: expect.stringMatching(/not the approver/), approver: "marketing-lead" });
    expect((await detail(runId)).approvals[0]?.status).toBe("pending");

    const right = await call<ApprovalState>(decide, {
      method: "POST",
      actor: "marketing-lead",
      body: { decision: "approve", note: "ship it" },
    });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ id: "approval-1", status: "approved", decidedBy: "marketing-lead" });

    const again = await call(decide, { method: "POST", actor: "marketing-lead", body: { decision: "reject" } });
    expect(again.status).toBe(409);

    const finished = await waitFor(
      () => detail(runId),
      (d) => d.run.status === "finished",
    );
    const ledger = finished.ledger ?? [];
    expect(ledger.map((r) => r.type)).toEqual([
      "run.started",
      "op.called",
      "op.called",
      "approval.requested",
      "approval.decided",
      "op.called",
      "op.called",
      "op.called",
      "run.finished",
    ]);
    expect(ledger[0]).toMatchObject({ type: "run.started", actor: { id: "alice" } });
    expect(ledger[4]).toMatchObject({ decision: "approve", by: "marketing-lead", note: "ship it" });
    const calls = ledger.flatMap((r) => (r.type === "op.called" ? [[r.op, r.decision.kind]] : []));
    expect(calls).toEqual([
      ["ghost.post.create", "allow"],
      ["resend.broadcast.create", "allow"],
      ["ghost.post.publish", "allow"],
      ["resend.broadcast.send", "allow"],
      ["bluesky.post.create", "allow"],
    ]);
  });

  it("says when a run or an approval does not exist", async () => {
    const run = await call("/api/runs/does-not-exist");
    expect(run.status).toBe(404);
    expect(run.body.error).toMatch(/does-not-exist/);
    const approval = await call("/api/runs/does-not-exist/approvals/approval-1", {
      method: "POST",
      actor: "marketing-lead",
      body: { decision: "approve" },
    });
    expect(approval.status).toBe(404);
    expect((await call("/api/nothing-here")).status).toBe(404);
  });
});

describe("the page", () => {
  it("says the UI is not built when there is no index.html", async () => {
    const res = await fetch(app.url);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "UI not built" });
  });

  it("serves the built page at / and for any other path, and its assets", async () => {
    writeFileSync(
      join(uiDir, "index.html"),
      '<!doctype html><div id="root"></div><script src="/assets/page.js"></script>',
    );
    mkdirSync(join(uiDir, "assets"), { recursive: true });
    writeFileSync(join(uiDir, "assets", "page.js"), "console.log('page')");

    for (const path of ["/", "/runs/abc", "/inbox"]) {
      const res = await fetch(new URL(path, app.url));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toContain('<div id="root"></div>');
    }
    const asset = await fetch(new URL("/assets/page.js", app.url));
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(await asset.text()).toBe("console.log('page')");
  });
});
