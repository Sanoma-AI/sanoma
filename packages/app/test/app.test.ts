import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { github } from "@sanoma/connector-github";
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { stripe } from "@sanoma/connector-stripe";
import { testDatabaseUrl } from "@sanoma/testing";
import {
  allow,
  approve,
  approvedFor,
  type ApprovalState,
  defineConfig,
  definePolicy,
  type DriftReport,
  DriverError,
  jsonlLedger,
  memoryLedger,
  type RunSummary,
  startWorker,
  type Worker,
} from "@sanoma/workflows";
import { type ConfigDescription, describeConfig, outlineWorkflow } from "@sanoma/workflows/describe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import announce from "../../workflows/test/fixtures/announce.ts";
import { companyFakes } from "../../workflows/test/fixtures/company/fakes.ts";
import { z } from "zod";
import { type App, type ErrorResponse, type RunDetail, startApp } from "../src/index.ts";
import { ApiError, type ScenariosResponse, type StartRunResponse } from "../src/api.ts";
import { asApiError, fileSource, parse, scenarios, withoutSources } from "../src/server/core.ts";

// Needs Postgres (`pnpm db:up`) and the built app: the tests build it when
// dist/server/server.js is missing or older than a file under src/.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(appDir, "dist");

function needsBuild(): boolean {
  const built = join(distDir, "server", "server.js");
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  const src = join(appDir, "src");
  return readdirSync(src, { recursive: true, encoding: "utf8" }).some(
    (file) => statSync(join(src, file)).mtimeMs > builtAt,
  );
}

const HOLD_TITLE = "Publish the held post";

// Holds publish and send for marketing-lead, unless they already approved something in the run.
// A run started by "held" is held by the policy itself, once for everything it publishes.
const policy = definePolicy(
  ({ op, effect, actor, run }) => {
    if (effect !== "publish" && effect !== "send") return allow();
    if (actor.id === "held") {
      return approvedFor(run.approvals, op.id, "marketing-lead")
        ? allow()
        : approve("marketing-lead", { title: HOLD_TITLE, covers: [resend.broadcast.send, bluesky.post.create] });
    }
    return run.approvals.some((a) => a.approver === "marketing-lead" && a.status === "approved")
      ? allow()
      : approve("marketing-lead");
  },
  { version: "test-1" },
);

/** A copy of the fixtures' feature files, which a test breaks to see the app say so. */
const scenariosDir = mkdtempSync(join(tmpdir(), "sanoma-app-scenarios-"));
cpSync(fileURLToPath(new URL("./fixtures/scenarios/", import.meta.url)), scenariosDir, { recursive: true });
const featureFile = join(scenariosDir, "announce.feature");

const blog = fakeGhost();
/** Bluesky's fake for sandbox runs, whose sample post fails, so its connector page shows a mock's error. */
const social = fakeBluesky();
const freshSocial = social.fresh;
social.fresh = () => {
  const copy = freshSocial();
  copy.failNext("bluesky.post.create", new DriverError("bluesky: the network is down", { retryable: false }));
  return copy;
};
// The workflows' company fixture: its data files, and GitHub and Stripe holding them as declared.
const company = companyFakes();
const companyDir = fileURLToPath(new URL("../../workflows/test/fixtures/company/", import.meta.url));
const config = defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky, github, stripe],
  drivers: [blog.driver, fakeResend().driver, fakeBluesky().driver, ...company.drivers],
  // Sandbox runs call these, seeded from the scenarios, never the drivers above.
  fakes: [fakeGhost(), fakeResend(), social],
  scenarios: pathToFileURL(`${scenariosDir}/`),
  policy,
  ledger: memoryLedger(),
  appName: "sanoma-app-test",
  databaseUrl: testDatabaseUrl("app"),
  root: companyDir,
});

let worker: Worker;
let app: App;
/** The run the API tests start, which the page tests then look for. */
let runId: string;
/** The sandbox run the scenario tests start, which the page tests then render. */
let sandboxId: string;
const SCENARIO = "Launch on time";

beforeAll(async () => {
  if (needsBuild()) {
    execFileSync("pnpm", ["exec", "vite", "build"], { cwd: appDir, stdio: "inherit" });
  }
  worker = await startWorker(config);
  app = await startApp(config, { port: 0 });
});

afterAll(async () => {
  await app?.close();
  await worker?.stop();
  rmSync(scenariosDir, { recursive: true, force: true });
});

interface CallInit {
  method?: string;
  /** Sent as JSON, unless `contentType` is given: then sent as it is, the way another client might. */
  body?: unknown;
  contentType?: string;
  actor?: string;
  headers?: Record<string, string>;
  /** The app to ask; the file's own by default. */
  base?: string;
}

async function call<T = ErrorResponse>(path: string, init: CallInit = {}) {
  const json = init.contentType === undefined && init.body !== undefined;
  const headers: Record<string, string> = { ...init.headers };
  const contentType = json ? "application/json" : init.contentType;
  if (contentType !== undefined) headers["content-type"] = contentType;
  if (init.actor !== undefined) headers["x-sanoma-actor"] = init.actor;
  const res = await fetch(new URL(path, init.base ?? app.url), {
    method: init.method ?? "GET",
    headers,
    body: json ? JSON.stringify(init.body) : (init.body as string | undefined),
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

/** `POST /api/runs` with this body, as tester. */
const postRun = (body: unknown) => call("/api/runs", { method: "POST", actor: "tester", body });

/** A page as the server renders it, and its text without the comments React puts between text parts. */
async function page(path: string, base = app.url) {
  const res = await fetch(new URL(path, base));
  const html = await res.text();
  return { status: res.status, html, text: html.replaceAll("<!-- -->", "") };
}

/** The Test control's buttons, as the workflow page renders them: its group's inner HTML. */
const testControl = (html: string) =>
  html.match(/<div role="group" data-slot="button-group"[^>]*aria-label="Test a scenario"[^>]*>(.*?)<\/div>/)?.[1];

/** A request's status, sent as written: no normalising of the path, and any Host header. */
function rawStatus(base: string, path: string, headers?: Record<string, string>) {
  const { hostname, port } = new URL(base);
  return new Promise<number>((done, fail) => {
    httpRequest({ host: hostname, port, path, headers }, (r) => {
      r.resume();
      done(r.statusCode ?? 0);
    })
      .on("error", fail)
      .end();
  });
}
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
    // Each workflow's outline, read from its file when the app started; the file itself is not sent.
    expect(wf?.outline).toEqual(outlineWorkflow(announce));
    expect(wf?.outline).toMatchObject({ file: expect.stringMatching(/announce\.ts$/) });
    expect(body.workflows.every((w) => !("source" in w))).toBe(true);
    // Nor is its code anywhere else in the description.
    const line = "ctx.ghost.post.create({ title, html: body";
    expect(readFileSync(announce.file!, "utf8")).toContain(line);
    expect(JSON.stringify(body)).not.toContain(line);
    expect(body.ops.find((o) => o.id === "resend.broadcast.send")?.effect).toBe("send");
    // Each faked operation's sample exchange; GitHub and Stripe have no fake in `fakes`.
    expect(body.ops.find((o) => o.id === "resend.broadcast.send")?.mock).toEqual({
      input: { id: "bc_0001" },
      output: { id: "bc_0001", status: "queued" },
    });
    expect(body.ops.find((o) => o.id === "bluesky.post.create")?.mock).toEqual({
      input: expect.objectContaining({ text: expect.any(String) }),
      error: "bluesky: the network is down",
    });
    expect(
      body.ops.filter((o) => o.vendor === "ghost" || o.vendor === "resend").every((o) => o.mock && "output" in o.mock),
    ).toBe(true);
    expect(
      body.ops.filter((o) => o.vendor === "github" || o.vendor === "stripe").every((o) => o.mock === undefined),
    ).toBe(true);
    expect(body.vendors.resend).toMatchObject({ title: "Resend", logo: { src: expect.stringMatching(/^data:/) } });
    // The data files under the config's root, without problems, passed through as they are.
    expect(body.resources.map((r) => r.id)).toEqual(company.declared.map((r) => r.id));
    expect(body.problems).toEqual([]);
    // And the built-in drift workflow, since the connectors declare resource types.
    expect(body.workflows.find((w) => w.name === "drift")).toMatchObject({ builtin: true });
  });

  it("refuses a run without an actor, for an unknown workflow, or with input the schema refuses", async () => {
    const anonymous = await call("/api/runs", { method: "POST", body: { workflow: "announce", input: input("x") } });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body).toMatchObject({ code: "invalid_input", error: expect.stringMatching(/x-sanoma-actor/) });

    const unknown = await call("/api/runs", { method: "POST", actor: "alice", body: { workflow: "nope", input: {} } });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["workflow"] })],
    });

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

  it("takes only a JSON body, on both routes that change something", async () => {
    for (const path of ["/api/runs", "/api/runs/does-not-exist/approvals/approval-1"]) {
      const asLead = { method: "POST", actor: "marketing-lead" };
      const form = await call(path, {
        ...asLead,
        contentType: "application/x-www-form-urlencoded",
        body: "decision=approve",
      });
      expect(form.status, path).toBe(415);
      expect(form.body.code, path).toBe("invalid_input");
      const empty = await call(path, { ...asLead, contentType: "application/json" });
      expect(empty.status, path).toBe(400);
      expect(empty.body).toMatchObject({ code: "invalid_input", error: expect.stringMatching(/empty/) });
    }
  });

  it("starts a run as the actor, holds it for the approver, refuses anyone else, then finishes", async () => {
    const started = await call<StartRunResponse>("/api/runs", {
      method: "POST",
      actor: encodeURIComponent("Ålice"),
      body: { workflow: "announce", input: input("From the app") },
    });
    expect(started.status).toBe(201);
    expect(started.body).toEqual({ runId: expect.any(String), workflow: "announce" });
    runId = started.body.runId;

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
    const ledger = finished.ledger;
    expect(ledger.map((r) => r.type)).toEqual([
      "run.started",
      "op.called",
      "op.called",
      "approval.requested",
      "approval.decided",
      "sleep.started",
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

  it("answers 202 with the approval still pending when no worker reads the decision", async () => {
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: "alice",
      body: { workflow: "announce", input: input("Nobody home") },
    });
    const id = started.body.runId;
    await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    await worker.stop();
    try {
      const sent = await call<ApprovalState>(`/api/runs/${id}/approvals/approval-1`, {
        method: "POST",
        actor: "marketing-lead",
        body: { decision: "approve" },
      });
      expect(sent.status).toBe(202);
      expect(sent.body).toMatchObject({ id: "approval-1", status: "pending" });
    } finally {
      worker = await startWorker(config);
    }
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

describe("scenarios and sandbox runs", () => {
  it("lists the scenarios in the config's feature files, with their steps", async () => {
    const { status, body } = await call<ScenariosResponse>("/api/scenarios");
    expect(status).toBe(200);
    expect(body.errors).toEqual([]);
    expect(body.scenarios.map((s) => s.name)).toEqual([SCENARIO, "Publish retried", "Copy rejected"]);
    const launch = body.scenarios[0]!;
    expect(launch).toMatchObject({
      workflow: "announce",
      file: "announce.feature",
      text: expect.stringMatching(/^Scenario: Launch on time\n/),
    });
    expect(launch.steps).toContainEqual({
      text: 'a post titled "Old news" exists',
      kind: "given",
      op: "ghost.post.create",
    });
    expect(launch.steps).toContainEqual({ text: "the run succeeds", kind: "then" });
    // What the page lists, not how the worker seeds and checks it.
    expect(launch).not.toHaveProperty("expect");
  });

  it("refuses a request that names both a workflow and a scenario, or neither, at its own field", async () => {
    const both = await postRun({ workflow: "announce", input: {}, scenario: SCENARIO });
    expect(both.status).toBe(400);
    expect(both.body).toMatchObject({ code: "invalid_input", issues: [{ path: [] }] });
    expect(both.body.error).toContain("Send a workflow or a scenario, not both");

    const neither = await postRun({});
    expect(neither.status).toBe(400);
    expect(neither.body.issues).toContainEqual(expect.objectContaining({ path: ["workflow"] }));

    const noWorkflow = await postRun({ workflow: "" });
    expect(noWorkflow.body.issues).toContainEqual(
      expect.objectContaining({ path: ["workflow"], message: "Name a workflow" }),
    );

    const noScenario = await postRun({ scenario: "" });
    expect(noScenario.status).toBe(400);
    expect(noScenario.body.issues).toEqual([
      expect.objectContaining({ path: ["scenario"], message: "Name a scenario" }),
    ]);
  });

  it("refuses a scenario the config does not have, naming those it has", async () => {
    const { status, body } = await call("/api/runs", { method: "POST", actor: "tester", body: { scenario: "nope" } });
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "invalid_input", issues: [expect.objectContaining({ path: ["scenario"] })] });
    expect(body.error).toBe(
      'No scenario named "nope"; the scenarios are "Launch on time", "Publish retried", "Copy rejected"',
    );
  });

  it("starts a sandbox run whose approval waits for a person, then checks it against the scenario", async () => {
    const started = await call<StartRunResponse>("/api/runs", {
      method: "POST",
      actor: "tester",
      body: { scenario: SCENARIO },
    });
    expect(started.status).toBe(201);
    // The scenario's workflow, which the request did not name: the run's page is under it.
    expect(started.body.workflow).toBe("announce");
    sandboxId = started.body.runId;

    // The app decides nothing: the run waits on its approval as a live run does.
    const held = await waitFor(
      () => detail(sandboxId),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    expect(held.run).toMatchObject({ status: "waiting", sandbox: SCENARIO, startedBy: { id: "tester" } });
    expect(held.ledger.find((r) => r.type === "scenario.seeded")).toMatchObject({
      scenario: SCENARIO,
      seeds: [
        expect.objectContaining({ op: "ghost.post.create", input: expect.objectContaining({ title: "Old news" }) }),
      ],
    });
    // A call it expects has been made, so that check is settled; the outcome is not yet.
    expect(held.checks).toContainEqual({ step: 'a post titled "Acme Pro" is created', ok: true, settled: true });
    expect(held.checks).toContainEqual({
      step: "the run succeeds",
      ok: false,
      detail: "run not ended",
      settled: false,
    });

    const decided = await call<ApprovalState>(`/api/runs/${sandboxId}/approvals/${held.approvals[0]!.id}`, {
      method: "POST",
      actor: "marketing-lead",
      body: { decision: "approve" },
    });
    expect(decided.body.status).toBe("approved");
    const done = await waitFor(
      () => detail(sandboxId),
      (d) => d.run.status === "finished",
    );
    expect(done.checks).toHaveLength(5);
    expect(done.checks?.filter((c) => !c.ok)).toEqual([]);
  });

  it("settles a check once its answer cannot change, and fails those not met when the run ends", async () => {
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: "tester",
      body: { scenario: "Copy rejected" },
    });
    expect(started.status).toBe(201);
    const id = started.body.runId;
    const held = await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    // A call not made so far may still be made: not settled, though met.
    expect(held.checks).toEqual([
      { step: "ghost.post.publish was not called", ok: true, settled: false },
      expect.objectContaining({ step: "resend.broadcast.send was called", ok: false, settled: false }),
      { step: 'the run fails with "approval_rejected"', ok: false, detail: "run not ended", settled: false },
    ]);
    expect((await page(`/workflows/announce/runs/${id}`)).text).toMatch(/>not yet</);

    const decided = await call<ApprovalState>(`/api/runs/${id}/approvals/${held.approvals[0]!.id}`, {
      method: "POST",
      actor: "marketing-lead",
      body: { decision: "reject" },
    });
    expect(decided.body.status).toBe("rejected");
    const failed = await waitFor(
      () => detail(id),
      (d) => d.run.status === "failed",
    );
    expect(failed.checks).toEqual([
      { step: "ghost.post.publish was not called", ok: true, settled: true },
      expect.objectContaining({ step: "resend.broadcast.send was called", ok: false, settled: true }),
      { step: 'the run fails with "approval_rejected"', ok: true, settled: true },
    ]);
  });
});

describe("scenarios that no longer load", () => {
  it("says why a seeded run has no checks, and why a scenario cannot start, when its file breaks", async () => {
    const before = await detail(sandboxId);
    expect(before.checks).toBeDefined();
    const text = readFileSync(featureFile, "utf8");
    try {
      writeFileSync(featureFile, "Feature: Broken\n  Scenario: Broken\n    Then nothing\n");
      const broken = await detail(sandboxId);
      expect(broken.checks).toBeUndefined();
      expect(broken.checksError).toMatch(
        /^The feature files no longer have scenario "Launch on time"; these files did not load: announce\.feature:3: no step matches "nothing"\nKnown steps:/,
      );
      const run = await page(`/workflows/announce/runs/${sandboxId}`);
      expect(run.html).toMatch(/<h2[^>]*>Checks<\/h2>/);
      expect(run.text).toContain("Could not check the run against its scenario: The feature files no longer have");
      // A workflow with no scenarios still has its Test control, enabled: it opens the menu, which says so.
      const workflow = await page("/workflows/announce");
      expect(testControl(workflow.text)).toMatch(/>Test<\/button><button[^>]*aria-label="Scenario"/);
      expect(testControl(workflow.text)).not.toContain('disabled=""');
      // A connector's page says why too, above its operations.
      const connector = await page("/connectors/ghost");
      expect(connector.text).toMatch(
        /Could not read a scenario: announce\.feature:3: no step matches &quot;nothing&quot;[\s\S]*<h2[^>]*>Operations<\/h2>/,
      );

      const start = await postRun({ scenario: SCENARIO });
      expect(start.status).toBe(404);
      expect(start.body.error).toMatch(/; these files did not load: announce\.feature:3: no step matches "nothing"/);
    } finally {
      writeFileSync(featureFile, text);
    }
    expect((await detail(sandboxId)).checks).toEqual(before.checks);
  });

  it("lists no scenarios, with why, when they cannot be read at all", () => {
    const resolved = {
      scenarios: pathToFileURL(`${scenariosDir}/`),
      get ops(): never {
        throw new Error("the ops are gone");
      },
    };
    expect(scenarios({ resolved } as never)).toEqual({
      scenarios: [],
      errors: [{ file: "", message: "the ops are gone" }],
    });
  });
});

describe("errors the app answers with", () => {
  it("answers anything unexpected with a 500 that names no detail", () => {
    const api = asApiError(new Error("connect ECONNREFUSED db.internal:5432"));
    expect(api.status).toBe(500);
    expect(api.body).toEqual({ error: "Something went wrong" });
  });

  it("answers an argument a schema refuses, a server function's included, with 400 and the issues", () => {
    let api: unknown;
    try {
      parse(z.object({ runId: z.string().min(1) }), { runId: "" }, "The request");
    } catch (err) {
      api = err;
    }
    if (!(api instanceof ApiError)) throw new Error("expected an ApiError");
    expect(api.status).toBe(400);
    expect(api.body).toMatchObject({
      code: "invalid_input",
      error: expect.stringMatching(/^The request: runId: /),
      issues: [expect.objectContaining({ path: ["runId"] })],
    });
  });
});

describe("a file's source", () => {
  it("is served for a file the description names, a workflow's or a data file, apart from the config", async () => {
    const description = await describeConfig(config);
    const context = { resolved: { root: companyDir } as never, description };
    expect(await fileSource(context, announce.file!)).toEqual({
      source: readFileSync(announce.file!, "utf8").replaceAll("\r\n", "\n"),
    });
    expect(await fileSource(context, "resources/identity/rules.ts")).toEqual({
      source: readFileSync(join(companyDir, "resources/identity/rules.ts"), "utf8"),
    });
    expect(withoutSources(description).workflows.find((wf) => wf.name === "announce")).not.toHaveProperty("source");
    // Nothing else, and not a 404: the page asking would take it for its own not-found.
    for (const file of ["sanoma.config.ts", "resources/../sanoma.config.ts", join(companyDir, "sanoma.config.ts")]) {
      expect(await fileSource(context, file)).toEqual({ source: null });
    }
  });
});

describe("the page", () => {
  it("renders the workflows on the server, and the sidebar links to each workflow and no runs page", async () => {
    const res = await fetch(new URL("/workflows", app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toMatch(/<h1[^>]*>Workflows<\/h1>/);
    expect(html).toContain('href="/workflows/announce"');
    expect(html).not.toContain('href="/runs"');
  });

  it("redirects /, /runs and a run's old URL to their pages under /workflows, and not-found for a run that does not exist", async () => {
    for (const path of ["/", "/runs"]) {
      const res = await fetch(new URL(path, app.url), { redirect: "manual" });
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toMatch(/\/workflows$/);
    }
    const old = await fetch(new URL(`/runs/${runId}`, app.url), { redirect: "manual" });
    expect(old.status).toBe(307);
    expect(old.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`)).toBe(true);
    // A run under another workflow's page goes to its own workflow's.
    const elsewhere = await fetch(new URL(`/workflows/drift/runs/${runId}`, app.url), { redirect: "manual" });
    expect(elsewhere.status).toBe(307);
    expect(elsewhere.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`)).toBe(true);
    const missing = await page("/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No run does-not-exist");
  });

  it("renders a run the policy held: its card in the inbox while held, then the hold, the notes and the records", async () => {
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: "held",
      body: { workflow: "announce", input: input("Held by the policy") },
    });
    const id = started.body.runId;
    const approveAs = (approvalId: string, note: string) =>
      call<ApprovalState>(`/api/runs/${id}/approvals/${approvalId}`, {
        method: "POST",
        actor: "marketing-lead",
        body: { decision: "approve", note },
      });
    await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    // The note is trimmed, and one with nothing in it is left out.
    expect((await approveAs("approval-1", "  copy is fine  ")).body).toMatchObject({ note: "copy is fine" });

    const held = await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.requestedBy === "policy"),
    );
    const hold = held.approvals.find((a) => a.requestedBy === "policy")!;
    expect(hold).toMatchObject({ title: HOLD_TITLE, op: "ghost.post.publish", status: "pending" });
    const inbox = await page("/inbox");
    expect(inbox.status).toBe(200);
    expect(inbox.text).toContain(HOLD_TITLE);

    const decided = await approveAs(hold.id, "   ");
    expect(decided.body).toMatchObject({ status: "approved" });
    expect(decided.body).not.toHaveProperty("note");
    const done = await waitFor(
      () => detail(id),
      (d) => d.run.status === "finished",
    );
    const notes = done.ledger.flatMap((r) => (r.type === "approval.decided" ? [r.note] : []));
    expect(notes).toEqual(["copy is fine", undefined]);

    const run = await page(`/workflows/announce/runs/${id}`);
    expect(run.status).toBe(200);
    expect(run.text).toContain(`“${HOLD_TITLE}” asked of marketing-lead`);
    expect(run.text).toContain(`marketing-lead approved “${HOLD_TITLE}”`);
    expect(run.text).toContain("copy is fine");
    expect(run.text).toMatch(/approved by marketing-lead/);
    expect(run.text).toContain("<code>ghost.post.publish</code>");
    // Each call after its vendor's logo, the dark theme's variant hidden until it applies.
    expect(run.html).toMatch(/<img src="data:image\/svg\+xml,[^"]+" alt="Ghost" class="[^"]*dark:hidden[^"]*"\/>/);
    expect(run.html).toMatch(
      /<img src="data:image\/svg\+xml,[^"]+" alt="Ghost" class="hidden [^"]*dark:block[^"]*"\/>/,
    );
    expect(run.text).toContain("Started by held");
    expect(run.text).toMatch(/>finished<\/span>/);
  });

  it("says a failed call that is not safe to repeat was not retried, and where to look", async () => {
    blog.failNext("ghost.post.create", new DriverError("ghost: the site is down", { retryable: false, status: 503 }));
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: "alice",
      body: { workflow: "announce", input: input("Fails at once") },
    });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "failed",
    );
    const run = await page(`/workflows/announce/runs/${started.body.runId}`);
    expect(run.text).toContain("ghost: the site is down");
    expect(run.text).toContain("Not retried: this operation is not safe to repeat. Check Ghost before starting again.");
  });

  it("renders the workflows on the server: each one's outline, operations and input, and a link to its page", async () => {
    const version = (await call<ConfigDescription>("/api/config")).body.version;
    const workflows = await page("/workflows");
    expect(workflows.status).toBe(200);
    expect(workflows.text).toContain(`<code>${version}</code>`);
    expect(workflows.text).toMatch(/>safe to retry<\/span>/);
    for (const title of ["Ghost", "Resend", "Bluesky"]) {
      expect(workflows.html).toMatch(new RegExp(`<img src="data:image/svg\\+xml,[^"]+" alt="${title}"`));
    }
    expect(workflows.text).toMatch(/default (&quot;|")newsletter(&quot;|")/);
    expect(workflows.html).toContain('href="/workflows/announce"');
    // Each workflow's outline, drawn in the browser like the run graph: a heading, what it is, a skeleton.
    expect(workflows.text).toMatch(
      /<h3[^>]*>Outline<\/h3><p[^>]*>Read from the body of run; the functions it calls are not shown, even those defined in it<\/p><div[^>]*><div data-slot="skeleton"[^>]*aria-label="Loading the graph"/,
    );

    expect(workflows.html).toContain('href="/workflows/announce/new"');
  });

  it("renders the start form on the server", async () => {
    const start = await page("/start");
    expect(start.status).toBe(200);
    expect(start.html).toContain('id="field-title"');
    expect(start.html).toContain('type="datetime-local"');
  });

  it("renders the theme switch and the sidebar on the server, the theme left to the browser", async () => {
    const workflows = await page("/workflows");
    expect(workflows.html).toContain("sanoma.theme");
    expect(workflows.html).toContain('data-slot="sidebar-wrapper"');
    expect(workflows.html.match(/<html[^>]*>/)?.[0]).not.toMatch(/class="[^"]*\bdark\b/);
  });

  it("lists the connectors, each linking to its page, without their operations", async () => {
    const connectors = await page("/connectors");
    expect(connectors.status).toBe(200);
    expect(connectors.html).toMatch(/<h1[^>]*>Connectors<\/h1>/);
    expect(connectors.text).toContain("<title>Connectors · Sanoma</title>");
    for (const title of ["Ghost", "Resend", "Bluesky", "GitHub"]) expect(connectors.text).toContain(`>${title}<`);
    expect(connectors.html).toContain('href="/connectors/ghost"');
    expect(connectors.text).toContain("2 operations · used by 1 workflow");
    // Only the hydration data, which carries the whole config, names an operation.
    expect(connectors.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")).not.toMatch(/ghost\.post\.create/);
    // The sidebar, on every page, links to it.
    expect(connectors.html).toContain('href="/connectors"');
  });

  it("renders a connector's page: its links, each operation's contract, phrases, mock and scenarios, and who uses it", async () => {
    const blogPage = await page("/connectors/ghost");
    expect(blogPage.status).toBe(200);
    expect(blogPage.html).toMatch(/<h1[^>]*>(<img[^>]*>)+Ghost<\/h1>/);
    expect(blogPage.text).toContain("<title>Ghost · Sanoma</title>");
    expect(blogPage.html).toContain('href="https://www.npmjs.com/package/@sanoma/connector-ghost"');
    expect(blogPage.html).toContain("<code>ghost.post.create</code>");
    expect(blogPage.text).toContain("<code>Given a post titled {title} exists</code>");
    // The mock: what the fake returned for a made-up input, publish publishing the post create made.
    expect(blogPage.html).toMatch(/>Mock<\/h3>/);
    expect(blogPage.text).toContain(">Called with<");
    expect(blogPage.text).toMatch(/&quot;id&quot;: &quot;post_0001&quot;/);
    // The scenario that names the operation, linking to its workflow with it chosen.
    expect(blogPage.html).toContain('href="/workflows/announce?scenario=Launch+on+time"');
    // What each scenario does with an operation: create is seeded and expected; publish fails
    // once ("Publish retried"), is expected, and must not be called ("Copy rejected").
    for (const label of ["seeds", "fails", "expects", "must not call"]) expect(blogPage.text).toContain(`>${label}<`);
    expect(blogPage.html).toContain('href="/workflows/announce"');

    // A sample the fake failed says how.
    const socialPage = await page("/connectors/bluesky");
    expect(socialPage.text).toContain("Fails with <code>bluesky: the network is down</code>");

    // A vendor without a fake in `fakes` says so, once, and shows no mock; its resource types are named.
    const githubPage = await page("/connectors/github");
    expect(githubPage.text.match(/No fake in this config\./g)).toHaveLength(1);
    expect(githubPage.html).not.toMatch(/>Mock<\/h3>/);
    expect(githubPage.html).toMatch(/Resources: <\/span>Branch protection rule, Repository, Team membership</);

    const missing = await page("/connectors/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No connector nope");
  });

  it("renders a workflow's page: its graph beside its source, and not-found for one that does not exist", async () => {
    const found = await page("/workflows/announce");
    expect(found.status).toBe(200);
    expect(found.html).toMatch(/<h1[^>]*>Announce a launch<\/h1>/);
    expect(found.text).toContain("<title>Announce a launch · Sanoma</title>");
    // The graph is drawn in the browser; the source is there as plain text until its view loads.
    expect(found.html).toMatch(/<div data-slot="skeleton"[^>]*aria-label="Loading the graph"/);
    expect(found.html).toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    // The layout's Run button opens the New run pane; nothing here goes to the Start page.
    expect(found.html).toContain('href="/workflows/announce/new"');
    expect(found.html).not.toContain('href="/start?workflow=');

    const missing = await page("/workflows/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No workflow nope");
  });

  it("renders a workflow's scenario, the Test control, and says when a scenario does not exist", async () => {
    const chosen = await page(`/workflows/announce?scenario=${encodeURIComponent(SCENARIO)}`);
    expect(chosen.status).toBe(200);
    // One split control: Test, naming the chosen scenario, and the menu that chooses one.
    expect(chosen.html).toMatch(
      /<div role="group" data-slot="button-group"[^>]*><button[^>]*>.*?Test “Launch on time”<\/button><button[^>]*aria-label="Scenario"/,
    );
    // The scenario's own lines, not the rest of its file.
    const shown = [...chosen.text.matchAll(/<pre[^>]*>([^<]*)<\/pre>/g)]
      .map(([, text]) => text!)
      .find((text) => text.startsWith("Scenario: Launch on time\n"));
    expect(shown).toBeDefined();
    expect(shown).not.toContain("Feature:");
    expect(shown).not.toContain("Publish retried");
    expect(chosen.text).toContain("From <code>announce.feature</code>");

    const unknown = await page("/workflows/announce?scenario=nope");
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain("No scenario named “nope”");
    // With none chosen, Test opens the menu, and is enabled.
    const control = testControl(unknown.text);
    expect(control).toMatch(/>Test<\/button><button[^>]*aria-label="Scenario"/);
    expect(control).toContain('aria-haspopup="menu"');
    expect(control).not.toContain('disabled=""');

    // A search value the router reads as a number is no scenario (or workflow), not a crash.
    expect((await page("/workflows/announce?scenario=123")).status).toBe(200);
    expect((await page("/start?workflow=123")).status).toBe(200);
  });

  it("renders a sandbox run: its badge, its checks and its seeding, and its badge in the runs", async () => {
    const run = await page(`/workflows/announce/runs/${sandboxId}`);
    expect(run.status).toBe(200);
    expect(run.text).toContain("sandbox · Launch on time");
    expect(run.html).toMatch(/<h2[^>]*>Checks<\/h2>/);
    expect(run.text).toContain("resend.broadcast.send was called");
    expect(run.text).toContain("Seeded 1 call from scenario “Launch on time”");
    const runs = await page("/workflows/announce");
    expect(runs.text).toContain("sandbox · Launch on time");
  });

  it("answers any other path with the app's not-found page", async () => {
    const res = await fetch(new URL("/nonexistent", app.url));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div id="app">');
  });

  it("renders a run, and answers a run that does not exist with not-found", async () => {
    const found = await page(`/workflows/announce/runs/${runId}`);
    expect(found.status).toBe(200);
    expect(found.html).toMatch(/<h2[^>]*>Ledger<\/h2>/);
    // React Flow draws the graph in the browser only: the server renders its heading and a
    // skeleton, and the workflow's source beside it as plain text until its view loads.
    expect(found.html).toMatch(/<h2[^>]*>Graph<\/h2>/);
    expect(found.html).toMatch(/<div data-slot="skeleton"[^>]*aria-label="Loading the graph"/);
    expect(found.html).toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    // The workflow's own approval covers no operation, and says so.
    expect(found.html).toMatch(/Lets through<\/dt><dd[^>]*><span[^>]*>no operation by itself/);
    const missing = await page("/workflows/announce/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No run does-not-exist");
  });

  it("renders a run under its workflow: the workflow's heading, the run's ledger, and the run marked in the rail", async () => {
    const found = await page(`/workflows/announce/runs/${runId}`);
    expect(found.status).toBe(200);
    expect(found.html).toMatch(/<h1[^>]*>Announce a launch<\/h1>/);
    expect(found.html).toMatch(/<h2[^>]*>Ledger<\/h2>/);
    expect(found.text).toContain(`<title>${runId} · Sanoma</title>`);
    const link = found.html.match(new RegExp(`<a[^>]*href="/workflows/announce/runs/${runId}"[^>]*>`))?.[0];
    expect(link).toContain('aria-current="page"');
    expect(found.html).toContain('aria-label="Runs of this workflow"');
  });

  it("filters the rail by ?runs=, and keeps the filter on the rail's links", async () => {
    const { body: runs } = await call<RunSummary[]>("/api/runs?workflow=announce&limit=50");
    const sandbox = runs.filter((r) => r.sandbox !== undefined).map((r) => r.runId);
    expect(sandbox).toContain(sandboxId);
    const filtered = await page("/workflows/announce?runs=sandbox");
    expect(filtered.status).toBe(200);
    const listed = [...filtered.html.matchAll(/href="\/workflows\/announce\/runs\/([^"?]+)\?runs=sandbox"/g)].map(
      ([, id]) => id,
    );
    expect(listed.toSorted()).toEqual(sandbox.toSorted());
    expect(filtered.html).not.toContain(`href="/workflows/announce/runs/${runId}`);
    expect(filtered.html).toContain('href="/workflows/announce/new?runs=sandbox"');
  });

  it("renders the New run pane: the start form for the workflow", async () => {
    const pane = await page("/workflows/announce/new");
    expect(pane.status).toBe(200);
    expect(pane.html).toMatch(/<h1[^>]*>Announce a launch<\/h1>/);
    expect(pane.html).toContain('id="field-title"');
    expect(pane.text).toContain("<title>New run · Sanoma</title>");
  });

  it("serves the built assets, hashed ones as immutable, and nothing outside them", async () => {
    const [asset] = readdirSync(join(distDir, "client", "assets")).filter((f) => f.endsWith(".js"));
    const res = await fetch(new URL(`/assets/${asset}`, app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    // A raw request, so the client doesn't normalise the dots away.
    expect(await rawStatus(app.url, "/assets/%2e%2e/%2e%2e/package.json")).not.toBe(200);
  });

  it("keeps the runtime out of the browser bundle", () => {
    const dir = join(distDir, "client", "assets");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      // Nor the scenarios' Gherkin parser and faker, which only the server loads.
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/DBOSClient|systemDatabaseUrl|@cucumber|faker/);
    }
  });

  it("refuses requests addressed to a name other than this machine's", async () => {
    expect(await rawStatus(app.url, "/api/config", { host: "attacker.example:80" })).toBe(403);
  });
  // wave 2 B: New run
});

// One more app on the file's database, to test four things a deployment may change: its own
// resolveActor, listening on every interface, a ledger the worker does not write to, and data
// files, one of them broken.
describe("resources and drift", () => {
  let driftRun: string;
  let report: DriftReport;
  beforeAll(async () => {
    // GitHub and Stripe hold what the data files declare, but for one field each, and one rule is gone.
    company.seed();
    company.github.override("repository", "website", { has_wiki: true });
    company.stripe.override("product", "prod_SanomaFixturePro", { name: "Sanoma Professional" });
    company.github.remove("branch_protection", "docs:main");
    // Started as any workflow is, with its input: nothing.
    const started = await call<{ runId: string }>("/api/runs", {
      method: "POST",
      actor: "alice",
      body: { workflow: "drift", input: {} },
    });
    if (started.status !== 201) throw new Error(`POST /api/runs answered ${started.status}`);
    driftRun = started.body.runId;
    const done = await waitFor(
      () => detail(driftRun),
      (d) => d.run.status === "finished",
    );
    const finished = done.ledger.at(-1);
    report = (finished?.type === "run.finished" ? finished.output : undefined) as DriftReport;
  });

  it("lists drift runs by workflow, started as the actor", async () => {
    const { body } = await call<RunSummary[]>("/api/runs?workflow=drift&limit=1");
    expect(body).toMatchObject([
      { runId: driftRun, workflow: "drift", status: "finished", startedBy: { id: "alice" } },
    ]);
    expect((await call<RunSummary[]>("/api/runs?workflow=nope")).body).toEqual([]);
  });

  it("refuses a drift run given any input: it reads the data files itself", async () => {
    const forged = await call("/api/runs", {
      method: "POST",
      actor: "alice",
      body: {
        workflow: "drift",
        input: { resources: [{ id: "x#y", vendor: "github", type: "repository", name: "x" }] },
      },
    });
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("invalid_input");
  });

  it("finds two drifted, one gone and three clean", () => {
    expect(report.resources.filter((r) => r.status === "drifted")).toEqual([
      expect.objectContaining({
        id: "resources/billing/stripe.ts#pro",
        fields: [{ path: "name", desired: "Sanoma Pro", actual: "Sanoma Professional" }],
      }),
      expect.objectContaining({
        id: "resources/identity/github.ts#website",
        fields: [{ path: "has_wiki", desired: false, actual: true }],
      }),
    ]);
    expect(report.resources.filter((r) => r.status === "gone").map((r) => r.id)).toEqual([
      "resources/identity/rules.ts#docsMain",
    ]);
    expect(report.resources.filter((r) => r.status === "clean")).toHaveLength(3);
  });

  it("renders each resource with its drift badge, the fields that differ, and a link to the run", async () => {
    const resources = await page("/resources");
    expect(resources.status).toBe(200);
    expect(resources.html).toMatch(/<h1[^>]*>Resources<\/h1>/);
    expect(resources.text).toContain("<title>Resources · Sanoma</title>");
    expect(resources.text).toContain(`href="/workflows/drift/runs/${driftRun}"`);
    expect(resources.text).toContain('href="/resources?resource=resources%2Fidentity%2Fgithub.ts%23website"');
    expect(resources.text.match(/>drifted: 1 field</g)).toHaveLength(2);
    expect(resources.text.match(/>gone</g)).toHaveLength(1);
    expect(resources.text.match(/>clean</g)).toHaveLength(3);
    expect(resources.text).toContain("2 drifted");
    // Each drifted field, as declared and as the vendor holds it.
    expect(resources.text).toMatch(/<code>has_wiki<\/code>.*?<code>false<\/code>.*?<code>true<\/code>/s);
    expect(resources.text).toMatch(
      /<code>name<\/code>.*?<code>&quot;Sanoma Pro&quot;<\/code>.*?<code>&quot;Sanoma Professional&quot;<\/code>/s,
    );
    expect(resources.html).toContain('href="/resources"');
    // A resource's declaration in its file, from the search: as plain text on the server.
    const chosen = await page("/resources?resource=resources%2Fidentity%2Fgithub.ts%23website");
    expect(chosen.text).toMatch(/<h2[^>]*><code>resources\/identity\/github\.ts<\/code><\/h2>/);
  });

  it("lists the built-in drift workflow like any other, labelled built-in, with its Run", async () => {
    const workflows = await page("/workflows");
    expect(workflows.text).toContain(">built-in<");
    expect(workflows.text).toContain('href="/workflows/drift/new"');
  });

  it("starts the built-in drift workflow from the Start page like any other", async () => {
    const start = await page("/start?workflow=drift");
    expect(start.text).not.toContain("No workflow named");
  });
  // wave 2 C: Home
});

describe("an app configured otherwise", () => {
  let dir: string;
  let other: App;
  const warned: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-app-ledger-"));
    mkdirSync(join(dir, "resources"));
    const GH = `import { github } from "@sanoma/connector-github/resources";\n`;
    writeFileSync(join(dir, "resources", "good.ts"), `${GH}export const web = github.repository({ name: "web" });\n`);
    writeFileSync(join(dir, "resources", "bad.ts"), `${GH}export const docs = github.repository({ name: 1 });\n`);
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.join(" ")));
    other = await startApp(
      // A directory nothing has written to yet: the worker keeps its records in memory.
      { ...config, ledger: jsonlLedger(join(dir, "ledger")), root: dir },
      {
        host: "0.0.0.0",
        // Says who is asking from a test header, the way a hosted deployment reads its login.
        resolveActor: (request) => {
          const who = request.headers.get("x-test-user");
          if (who === "boom") throw new Error("the session store is down");
          return who ? { id: who, groups: ["marketing"] } : undefined;
        },
      },
    );
    warn.mockRestore();
  });
  afterAll(async () => {
    await other?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots with broken data files: lists the resources it could read, and the problems", async () => {
    expect(warned).toEqual([
      expect.stringMatching(/^sanoma app: the data files have problems.*\n {2}resources\/bad\.ts:2:1: /s),
    ]);
    const { body } = await call<ConfigDescription>("/api/config", { base: other.url });
    expect(body.resources.map((r) => r.id)).toEqual(["resources/good.ts#web"]);
    expect(body.problems).toEqual([
      {
        file: "resources/bad.ts",
        line: 2,
        column: 1,
        message: expect.stringMatching(/^export const docs: github\.repository: /),
      },
    ]);
  });

  it("shows the data files' problems on the resources page, and the resources it could read", async () => {
    const resources = await page("/resources", other.url);
    expect(resources.status).toBe(200);
    expect(resources.text).toContain("1 problem in the data files: their resources are left out");
    expect(resources.text).toMatch(/<code>resources\/bad\.ts:2:1<\/code> export const docs: github\.repository: /);
    expect(resources.text).toContain("resources/good.ts#web");
  });

  const post = (user?: string) =>
    call<ErrorResponse & { runId?: string }>("/api/runs", {
      method: "POST",
      base: other.url,
      headers: user ? { "x-test-user": user } : {},
      body: { workflow: "announce", input: input("Hosted") },
    });
  const read = () => call<RunDetail>(`/api/runs/${runId}`, { base: other.url });

  describe("with its own resolveActor", () => {
    it("starts runs as the principal it resolves, groups included", async () => {
      const started = await post("sso-user");
      expect(started.status).toBe(201);
      const run = await waitFor(
        () => detail(started.body.runId!),
        (d) => d.run.startedBy !== undefined,
      );
      expect(run.run.startedBy).toEqual({ id: "sso-user", groups: ["marketing"] });
    });

    it("refuses a change it names nobody for without mentioning the header it does not read", async () => {
      const anonymous = await post();
      expect(anonymous.status).toBe(400);
      expect(anonymous.body.code).toBe("invalid_input");
      expect(anonymous.body.error).not.toMatch(/x-sanoma-actor/);
    });

    it("renders who the deployment says is asking, and never asks for a name", async () => {
      const res = await fetch(new URL("/workflows", other.url), { headers: { "x-test-user": "sso-user" } });
      const html = await res.text();
      // The user menu's trigger: the deployment's name for you, and whose name it is. Nothing
      // asks for a name or says one is kept here (the menu, with no "Change name" either,
      // renders only once opened).
      expect(html).toMatch(/>sso-user<\/span><span[^>]*>Signed in by the deployment<\/span>/);
      expect(html).not.toContain("Who are you?");
      expect(html).not.toContain("Name kept in this browser");
    });

    it("answers a resolver that throws with a 500, and logs why", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const failed = await post("boom");
      expect(failed.status).toBe(500);
      expect(failed.body.error).toBe("Something went wrong");
      expect(logged.mock.calls).toEqual([
        [
          expect.stringContaining("POST /api/runs failed"),
          expect.objectContaining({ message: "Could not tell who you are: the session store is down" }),
        ],
      ]);
    });
  });

  describe("on every interface", () => {
    it("answers a request addressed to any name, since it was asked to listen beyond this machine", async () => {
      const base = `http://127.0.0.1:${new URL(other.url).port}`;
      expect(await rawStatus(base, "/api/config", { host: "sanoma.example:80" })).toBe(200);
    });
  });

  describe("reading a jsonl ledger", () => {
    it("says a run that has started has no records there: the app reads another ledger than the worker", async () => {
      const { status, body } = await read();
      expect(status).toBe(200);
      expect(body.ledger).toEqual([]);
      expect(body.ledgerError).toBe(
        "No records for a run that has started; is the app reading the same ledger as the worker?",
      );
      const html = await page(`/workflows/announce/runs/${runId}`, other.url);
      expect(html.status).toBe(200);
      expect(html.text).toContain("is the app reading the same ledger as the worker?");
    });

    it("shows why it cannot read a corrupt ledger, and logs it for the operator once", async () => {
      mkdirSync(join(dir, "ledger"), { recursive: true });
      writeFileSync(join(dir, "ledger", `${encodeURIComponent(runId)}.jsonl`), "not json\n");
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await read();
      // Read again, as the page's poll does: logged once for the run and the failure.
      await read();
      expect(result.status).toBe(200);
      expect(result.body.ledger).toEqual([]);
      expect(result.body.ledgerError).toMatch(/corrupt ledger line/);
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]?.[0])).toContain(`could not read the ledger of run ${runId}`);
    });
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

  it("refuses a build without its client files, or with none in it, rather than serving pages with no script or style", async () => {
    const half = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      mkdirSync(join(half, "server"));
      writeFileSync(join(half, "server", "server.js"), "");
      const refusal = `The app is not built: ${join(half, "client")} is missing`;
      await expect(startApp(config, { distDir: half })).rejects.toThrow(refusal);
      mkdirSync(join(half, "client"));
      await expect(startApp(config, { distDir: half })).rejects.toThrow(refusal);
    } finally {
      rmSync(half, { recursive: true, force: true });
    }
  });

  it("reports both failures when neither the server entry nor the database works", async () => {
    const broken = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      mkdirSync(join(broken, "server"));
      mkdirSync(join(broken, "client"));
      writeFileSync(join(broken, "server", "server.js"), "");
      writeFileSync(join(broken, "client", "index.txt"), "");
      const err = await startApp({ ...config, databaseUrl: "not a url" }, { distDir: broken }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(2);
      expect((err as Error).message).toMatch(
        /^The app could not start: .*server\.js does not export a \{ fetch \} server entry; and Invalid URL/,
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
