import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { testDatabaseUrl } from "@sanoma/testing";
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
import { type App, type ErrorResponse, type RunDetail, startApp } from "../src/index.ts";

// Needs Postgres (`pnpm db:up`) and the built app: the tests build it once when
// dist/server/server.js is missing. Rebuild with `pnpm --filter @sanoma/app build` after
// changing anything under src/ but index.ts.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(appDir, "dist");

// Holds publish and send for marketing-lead, unless they already approved something in the run.
const policy = definePolicy(
  ({ effect, run }) =>
    (effect === "publish" || effect === "send") &&
    !run.approvals.some((a) => a.approver === "marketing-lead" && a.status === "approved")
      ? approve("marketing-lead")
      : allow(),
  { version: "test-1" },
);

const config = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: [fakeGhost().driver, fakeResend().driver, fakeBluesky().driver],
  policy,
  ledger: memoryLedger(),
  appName: "sanoma-app-test",
  databaseUrl: testDatabaseUrl("app"),
});

let worker: Worker;
let app: App;
/** The run the API tests start, which the page tests then look for. */
let runId: string;

beforeAll(async () => {
  if (!existsSync(join(distDir, "server", "server.js"))) {
    execFileSync("pnpm", ["exec", "vite", "build"], { cwd: appDir, stdio: "inherit" });
  }
  worker = await startWorker(config);
  app = await startApp(config, { port: 0 });
});

afterAll(async () => {
  await app?.close();
  await worker?.stop();
});

async function call<T = ErrorResponse>(path: string, init: { method?: string; body?: unknown; actor?: string } = {}) {
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

const detail = async (id: string) => (await call<RunDetail>(`/api/runs/${id}`)).body;
const input = (title: string) => ({
  title,
  body: "<p>Hello</p>",
  launchAt: new Date(Date.now() - 60_000).toISOString(),
});

describe("the API", () => {
  it("describes the config: workflows, ops, built-ins, the policy and the version", async () => {
    const { status, body } = await call<ConfigDescription>("/api/config");
    expect(status).toBe(200);
    expect(body.appName).toBe("sanoma-app-test");
    expect(body.version).toMatch(/^sanoma-app-test@/);
    expect(body.policy).toEqual({ defined: true, version: "test-1" });
    const wf = body.workflows.find((w) => w.name === "announce");
    expect(wf?.ops).toHaveLength(5);
    expect(wf?.ops).toEqual(expect.arrayContaining(["ghost.post.publish", "resend.broadcast.send"]));
    expect(wf?.builtins).toEqual(["approval", "sleep"]);
    expect(body.ops.find((o) => o.id === "resend.broadcast.send")?.effect).toBe("send");
  });

  it("refuses a run without an actor, for an unknown workflow, or with input the schema refuses", async () => {
    const anonymous = await call("/api/runs", { method: "POST", body: { workflow: "announce", input: input("x") } });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body).toMatchObject({ code: "invalid_input", error: expect.stringMatching(/x-sanoma-actor/) });

    const unknown = await call("/api/runs", { method: "POST", actor: "alice", body: { workflow: "nope", input: {} } });
    expect(unknown.status).toBe(404);

    const { title: _, ...untitled } = input("x");
    const invalid = await call("/api/runs", {
      method: "POST",
      actor: "alice",
      body: { workflow: "announce", input: untitled },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_input");
    expect(invalid.body.issues).toEqual([expect.objectContaining({ path: ["title"], message: expect.any(String) })]);

    const notJson = await fetch(new URL("/api/runs", app.url), {
      method: "POST",
      headers: { "x-sanoma-actor": "alice", "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(await call("/api/runs?limit=0").then((r) => r.status)).toBe(400);
    const badStatus = await call("/api/runs?status=asleep");
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.issues).toEqual([expect.objectContaining({ path: ["status"] })]);
  });

  it("starts a run as the actor, holds it for the approver, refuses anyone else, then finishes", async () => {
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: encodeURIComponent("Ålice"),
      body: { workflow: "announce", input: input("From the app") },
    });
    expect(started.status).toBe(201);
    runId = started.body.runId;
    expect(runId).toEqual(expect.any(String));

    const runs = await call<RunSummary[]>("/api/runs?limit=50");
    expect(runs.body.find((r) => r.runId === runId)).toMatchObject({
      workflow: "announce",
      startedBy: { id: "Ålice" },
    });

    const held = await waitFor(
      () => detail(runId),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    const approval = held.approvals[0]!;
    expect(approval).toMatchObject({ id: "approval-1", approver: "marketing-lead", status: "pending" });
    expect(held.run.status).toBe("waiting");
    const waiting = await call<RunSummary[]>("/api/runs?status=waiting");
    expect(waiting.status).toBe(200);
    expect(waiting.body.map((r) => r.runId)).toContain(runId);
    expect(waiting.body.every((r) => r.status === "waiting")).toBe(true);
    const decide = `/api/runs/${runId}/approvals/${approval.id}`;

    const anonymous = await call(decide, { method: "POST", body: { decision: "approve" } });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.code).toBe("invalid_input");
    const wrong = await call(decide, { method: "POST", actor: "someone-else", body: { decision: "approve" } });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ code: "not_approver", approver: "marketing-lead" });
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
    expect(again.body.code).toBe("already_decided");

    const finished = await waitFor(
      () => detail(runId),
      (d) => d.run.status === "finished",
    );
    const stillWaiting = await call<RunSummary[]>("/api/runs?status=waiting");
    expect(stillWaiting.body.map((r) => r.runId)).not.toContain(runId);
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
    expect(ledger[0]).toMatchObject({ type: "run.started", actor: { id: "Ålice" } });
    expect(ledger[4]).toMatchObject({ decision: "approve", by: "marketing-lead", note: "ship it" });
    const ops = ledger.flatMap((r) => (r.type === "op.called" ? [[r.op, r.decision.kind]] : []));
    expect(ops).toEqual([
      ["ghost.post.create", "allow"],
      ["resend.broadcast.create", "allow"],
      ["ghost.post.publish", "allow"],
      ["resend.broadcast.send", "allow"],
      ["bluesky.post.create", "allow"],
    ]);
  });

  it("says when a run or an approval does not exist, by code", async () => {
    const run = await call("/api/runs/does-not-exist");
    expect(run.status).toBe(404);
    expect(run.body).toMatchObject({ code: "run_not_found", error: expect.stringMatching(/does-not-exist/) });
    const approval = await call("/api/runs/does-not-exist/approvals/approval-1", {
      method: "POST",
      actor: "marketing-lead",
      body: { decision: "approve" },
    });
    expect(approval.status).toBe(404);
    expect(approval.body.code).toBe("run_not_found");
    expect((await call("/api/nothing-here")).status).toBe(404);
  });
});

describe("the page", () => {
  it("renders the runs on the server, and redirects / to them", async () => {
    const res = await fetch(new URL("/runs", app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain("<h1>Runs</h1>");
    expect(html).toContain(`href="/runs/${runId}"`);
    const root = await fetch(app.url, { redirect: "manual" });
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toMatch(/\/runs$/);
  });

  it("answers any other path with the app's not-found page", async () => {
    const res = await fetch(new URL("/nonexistent", app.url));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div id="app">');
  });

  it("renders a run, and answers a run that does not exist with not-found", async () => {
    const found = await fetch(new URL(`/runs/${runId}`, app.url));
    expect(found.status).toBe(200);
    expect(await found.text()).toContain("<h2>Ledger</h2>");
    const missing = await fetch(new URL("/runs/does-not-exist", app.url));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("No run <!-- -->does-not-exist");
  });

  it("serves the built assets, hashed ones as immutable, and nothing outside them", async () => {
    const [asset] = readdirSync(join(distDir, "client", "assets")).filter((f) => f.endsWith(".js"));
    const res = await fetch(new URL(`/assets/${asset}`, app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    // A raw request, so the client doesn't normalise the dots away.
    const status = await new Promise<number>((done, fail) => {
      const url = new URL(app.url);
      httpRequest({ host: url.hostname, port: url.port, path: "/assets/%2e%2e/%2e%2e/package.json" }, (r) => {
        r.resume();
        done(r.statusCode ?? 0);
      })
        .on("error", fail)
        .end();
    });
    expect(status).not.toBe(200);
  });

  it("keeps the runtime out of the browser bundle", () => {
    const dir = join(distDir, "client", "assets");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/dbos/i);
    }
  });

  it("refuses requests addressed to a name other than this machine's", async () => {
    const status = await new Promise<number>((done, fail) => {
      const url = new URL(app.url);
      httpRequest(
        { host: url.hostname, port: url.port, path: "/api/config", headers: { host: "attacker.example:80" } },
        (r) => {
          r.resume();
          done(r.statusCode ?? 0);
        },
      )
        .on("error", fail)
        .end();
    });
    expect(status).toBe(403);
  });
});

describe("startApp", () => {
  it("says to build the app when it is not built", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      await expect(startApp(config, { distDir: empty })).rejects.toThrow(/pnpm --filter @sanoma\/app build/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
