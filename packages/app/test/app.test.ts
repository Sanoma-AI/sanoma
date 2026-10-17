import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { resend } from "@sanoma-ai/connector-resend";
import { ensureBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  allow,
  approve,
  approvedFor,
  defineConfig,
  defineConnector,
  definePolicy,
  type DriftReport,
  DriverError,
  jsonlLedger,
  memoryLedger,
  type Principal,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Source,
  startWorker,
  type Worker,
  withSetup,
} from "@sanoma-ai/workflows";
import { describeConfig, outlineWorkflow } from "@sanoma-ai/workflows/describe";
import { isNotFound } from "@tanstack/react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import announce from "../../workflows/test/fixtures/announce.ts";
import { companyFakes } from "../../workflows/test/fixtures/company/fakes.ts";
import { marketingFakes } from "../../workflows/test/harness.ts";
import { z } from "zod";
import { type App, startApp } from "../src/index.ts";
import {
  ACTOR_HEADER,
  ApiError,
  ClearCredentialRequest,
  DecideCall,
  type ErrorResponse,
  RUNS_LIMIT,
  RunsQuery,
  SetCredentialRequest,
} from "../src/api.ts";
import type { AppContext, LoginProvider } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import {
  type ActorContext,
  actorOf,
  adopt,
  asApiError,
  clearCredential,
  credentials,
  decide,
  fileSource,
  lastRuns,
  listRuns,
  parse,
  readStartRun,
  requireActor,
  runDetail,
  saysWho,
  scenarios,
  serverFnFailure,
  signOutUrl,
  setCredential,
  startRun,
  validate,
  withoutSources,
} from "../src/server/core.ts";

// Needs Postgres (`pnpm db:up`) and the built app: the tests build it when
// dist/server/server.js is missing or older than a file under src/.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(appDir, "dist");

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

// The marketing vendors: live runs call these fakes.
const vendors = marketingFakes();
const blog = vendors.ghost;
// The workflows' company fixture: its data files, and GitHub and Stripe holding them as declared.
const company = companyFakes();
const companyDir = fileURLToPath(new URL("../../workflows/test/fixtures/company/", import.meta.url));
/**
 * The app's root, with no package.json (so the app is "sanoma"): its scenarios/ is a copy of the
 * fixtures' feature files (which a test breaks to see the app say so), its resources/ the company's.
 */
const appRoot = mkdtempSync(join(tmpdir(), "sanoma-app-"));
const scenariosDir = join(appRoot, "scenarios");
cpSync(fileURLToPath(new URL("./fixtures/scenarios/", import.meta.url)), scenariosDir, { recursive: true });
cpSync(join(companyDir, "resources"), join(appRoot, "resources"), { recursive: true });
const featureFile = join(scenariosDir, "announce.feature");
/** A vendor with a workflow operation and no setup, so no fake: its connector page says so. */
const chat = defineConnector("chat", {
  message: { send: { effect: "send", input: z.object({ text: z.string() }), output: z.object({}) } },
});
// Live runs call these fakes; each sandbox run fakes of its own, seeded from the scenarios.
const config = defineConfig({
  workflows: [announce],
  connectors: [...vendors.connectors, ...company.connectors, chat],
  policy,
  ledger: memoryLedger(),
  databaseUrl: testDatabaseUrl("app"),
  root: appRoot,
});

let worker: Worker;
let app: App;
/** The app's context, as the server functions get it. */
let ctx: AppContext;
/** The run the server function tests start, which the page tests then look for. */
let runId: string;
/** The sandbox run the scenario tests start, which the page tests then render. */
let sandboxId: string;
const SCENARIO = "Launch on time";

/** The clients `contextOf` connects, closed after the file's tests. */
const clients: SanomaClient[] = [];

/**
 * The context startApp builds for a config and hands every request, on a client of its own: the
 * server functions call the server core with it.
 */
async function contextOf(cfg: SanomaConfig, login = loopbackLogin()): Promise<AppContext> {
  const client = await SanomaClient.connect(cfg);
  clients.push(client);
  return { resolved: resolveConfig(cfg), description: describeConfig(cfg), client, login };
}

beforeAll(async () => {
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  worker = await startWorker(config);
  app = await startApp(config, { port: 0 });
  ctx = await contextOf(config);
});

afterAll(async () => {
  await app?.close();
  await Promise.all(clients.map((client) => client.close()));
  await worker?.stop();
  rmSync(appRoot, { recursive: true, force: true });
});

/** Who is asking: the `x-sanoma-actor` header the page sends, or other headers, to an app's context. */
interface As {
  actor?: string;
  headers?: Record<string, string>;
  /** The file's own by default. */
  app?: AppContext;
}

/** What start.ts's `actor` middleware gives a server function for a request with these headers. */
function asking({ actor, headers, app: context = ctx }: As = {}): ActorContext {
  const all = actor === undefined ? { ...headers } : { ...headers, [ACTOR_HEADER]: actor };
  return { app: context, actor: actorOf(context, new Request("http://127.0.0.1/", { headers: all })) };
}

/**
 * A server function's answer as the page receives it: its result, or, with `status`, the
 * ApiError it fails with (`serverFnFailure`, which start.ts's `apiErrors` middleware throws). The
 * router's not-found, a read's answer for nothing found, is thrown.
 */
async function answer<T>(
  method: "GET" | "POST",
  work: () => Promise<T>,
): Promise<{ status?: number; body: T & Partial<ErrorResponse> }> {
  try {
    return { body: (await work()) as T & Partial<ErrorResponse> };
  } catch (err) {
    const failure = serverFnFailure(err, method);
    if (!(failure instanceof ApiError)) throw failure;
    return { status: failure.status, body: failure.body as T & Partial<ErrorResponse> };
  }
}

/**
 * A change as its server function makes it (see functions.ts): `withPrincipal`'s `requireActor`,
 * then the function's validator, then its handler's server core call.
 */
const change =
  <I, D, T>(read: (data: I) => D, call: (app: AppContext, actor: Principal, data: D) => Promise<T>) =>
  (data: unknown, as: As = {}) =>
    answer("POST", async () => {
      const request = asking(as);
      const actor = await requireActor(request);
      return call(request.app, actor, read(data as I));
    });

/** `startRunFn`: a workflow and its input, or a scenario. */
const startAs = change(readStartRun, startRun);
/** `decideFn`: `{ runId, approvalId, decision, note? }`. */
const decideAs = change(validate(DecideCall), decide);
/** `setCredentialFn` and `clearCredentialFn`. */
const setAs = change(validate(SetCredentialRequest), setCredential);
const clearAs = change(validate(ClearCredentialRequest), clearCredential);

/** `getRuns`: the latest runs, by the query. */
const runsOf = (query: Record<string, unknown> = {}) =>
  answer("GET", async () => listRuns(ctx, validate(RunsQuery)(query as RunsQuery)));

/** `getRun`: one run, its ledger, its approvals and a sandbox run's checks. */
const detail = (id: string, context = ctx) => runDetail(context, id);

/** `startRunFn` with this argument, as tester. */
const postRun = (data: unknown) => startAs(data, { actor: "tester" });

/** A page as the server renders it, and its text without the comments React puts between text parts. */
async function page(path: string, base = app.url, init?: RequestInit) {
  const res = await fetch(new URL(path, base), init);
  const html = await res.text();
  return { status: res.status, html, text: html.replaceAll("<!-- -->", "") };
}

/** The runs announce's panel links to, sorted, with `?runs=<filter>` kept on each link. */
const panelRunIds = (html: string, filter: string) =>
  [...html.matchAll(new RegExp(`href="/workflows/announce/runs/([^"?]+)\\?runs=${filter}"`, "g"))]
    .map(([, id]) => id)
    .toSorted();

/** The opening tag of a section's link in the bar: the one to `to` whose label follows. */
const section = (html: string, to: string) =>
  html.match(new RegExp(`<a [^>]*href="${to}"[^>]*>(?=(?:(?!</a>)[\\s\\S])*<span>[A-Z])`))?.[0];

/** The desktop sidebar's state: "expanded" or "collapsed". */
const sidebarState = (html: string) => html.match(/data-state="(expanded|collapsed)"[^>]*data-slot="sidebar"/)?.[1];

/** The opening tag of the link whose text, after any icon, is `label`, or an Item's or a sidebar menu button's title. */
function linkTag(html: string, label: string) {
  const at = html.search(new RegExp(`>${label}(?:</(?:div|span)>)*</a>`));
  if (at < 0) return undefined;
  const start = html.lastIndexOf("<a ", at);
  return html.slice(start, html.indexOf(">", start) + 1);
}

/** The Inbox's rows, in order, each its link's search: `approval`, and `show` when it keeps one. */
const inboxRows = (html: string) =>
  [...html.matchAll(/<a [^>]*href="\/inbox\?([^"]*approval=[^"]*)"[^>]*>/g)].map(([tag, search]) => {
    const params = new URLSearchParams(search!.replaceAll("&amp;", "&"));
    return { approval: params.get("approval"), show: params.get("show"), current: tag.includes('aria-current="page"') };
  });

/** The approval open beside the Inbox's list: the row marked current. */
const currentRow = (html: string) => inboxRows(html).find((row) => row.current)?.approval;

/** Whether the link whose text, after any icon, matches `label` is marked current. */
const currentLink = (html: string, label: string) =>
  html
    .replaceAll("<!-- -->", "")
    .match(new RegExp(`(<a [^>]*>)${label}</a>`))?.[1]
    ?.includes('aria-current="page"');

/** The open approval's title: its section's name. */
const openTitle = (html: string) => html.match(/<section aria-label="([^"]+)"/)?.[1];

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

describe("the server functions", () => {
  it("describe the config: workflows, ops, built-ins, the policy and the version, without the workflows' sources", async () => {
    const body = withoutSources(ctx.description);
    expect(body.appName).toBe("sanoma");
    expect(body.version).toMatch(/^sanoma@/);
    expect(body.policy).toEqual({ defined: true, version: "test-1" });
    const wf = body.workflows.find((w) => w.name === "announce");
    expect(wf?.ops).toHaveLength(5);
    expect(wf?.ops).toEqual(expect.arrayContaining(["ghost.post.publish", "resend.broadcast.send"]));
    expect(wf?.builtins).toEqual(["approval", "sleep"]);
    // Each workflow's outline, read from its file when the app started; the file itself is not sent.
    expect(wf?.outline).toEqual(outlineWorkflow(announce));
    expect(wf?.outline).toMatchObject({ file: expect.stringMatching(/announce\.ts$/) });
    expect(body.workflows.every((w) => !("source" in w))).toBe(true);
    // Nor is its code anywhere else in the description, or in the page that carries it.
    const line = "ctx.ghost.post.create({ title, html: body";
    expect(readFileSync(announce.file!, "utf8")).toContain(line);
    expect(JSON.stringify(body)).not.toContain(line);
    expect((await page("/workflows")).html).not.toContain(line);
    expect(body.ops.find((o) => o.id === "resend.broadcast.send")?.effect).toBe("send");
    // Whether each vendor's connector attaches a fake: Ghost's and GitHub's do, chat's does not.
    expect(body.vendors).toMatchObject({ ghost: { fake: true }, github: { fake: true }, chat: { fake: false } });
    expect(body.vendors.resend).toMatchObject({ title: "Resend", logo: { src: expect.stringMatching(/^data:/) } });
    // The data files under the config's root, without problems, passed through as they are.
    expect(body.resources.map((r) => r.id)).toEqual(company.declared.map((r) => r.id));
    expect(body.problems).toEqual([]);
    // And the built-in drift workflow, since the connectors declare resource types.
    expect(body.workflows.find((w) => w.name === "drift")).toMatchObject({ builtin: true });
  });

  it("refuse a run without an actor, for an unknown workflow, or with input the schema refuses", async () => {
    const anonymous = await startAs({ workflow: "announce", input: input("x") });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body).toMatchObject({ code: "invalid_input", error: expect.stringMatching(/x-sanoma-actor/) });

    const unknown = await startAs({ workflow: "nope", input: {} }, { actor: "alice" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["workflow"] })],
    });

    const { title: _, ...untitled } = input("x");
    const invalid = await startAs({ workflow: "announce", input: untitled }, { actor: "alice" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_input");
    expect(invalid.body.issues).toEqual([expect.objectContaining({ path: ["title"], message: expect.any(String) })]);

    expect((await runsOf({ limit: 0 })).status).toBe(400);
    const badStatus = await runsOf({ status: "asleep" });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.issues).toEqual([expect.objectContaining({ path: ["status"] })]);
  });

  it("start a run as the actor, hold it for the approver, refuse anyone else, then finish", async () => {
    const started = await startAs(
      { workflow: "announce", input: input("From the app") },
      { actor: encodeURIComponent("Ålice") },
    );
    expect(started).toEqual({ body: { runId: expect.any(String), workflow: "announce" } });
    runId = started.body.runId;

    const runs = await runsOf({ limit: 50 });
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
    const waiting = await runsOf({ status: "waiting" });
    expect(waiting.body.map((r) => r.runId)).toContain(runId);
    expect(waiting.body.every((r) => r.status === "waiting")).toBe(true);
    const call = { runId, approvalId: approval.id };

    const anonymous = await decideAs({ ...call, decision: "approve" });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.code).toBe("invalid_input");
    const wrong = await decideAs({ ...call, decision: "approve" }, { actor: "someone-else" });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ code: "not_approver", approver: "marketing-lead" });
    expect((await detail(runId)).approvals[0]?.status).toBe("pending");

    const right = await decideAs({ ...call, decision: "approve", note: "ship it" }, { actor: "marketing-lead" });
    expect(right.body).toMatchObject({ id: "approval-1", status: "approved", decidedBy: "marketing-lead" });

    const again = await decideAs({ ...call, decision: "reject" }, { actor: "marketing-lead" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_decided");

    const finished = await waitFor(
      () => detail(runId),
      (d) => d.run.status === "finished",
    );
    const stillWaiting = await runsOf({ status: "waiting" });
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

  it("answer with the approval still pending when no worker reads the decision", async () => {
    const started = await startAs({ workflow: "announce", input: input("Nobody home") }, { actor: "alice" });
    const id = started.body.runId;
    await waitFor(
      () => detail(id),
      (d) => d.approvals.some((a) => a.status === "pending"),
    );
    await worker.stop();
    try {
      const sent = await decideAs(
        { runId: id, approvalId: "approval-1", decision: "approve" },
        { actor: "marketing-lead" },
      );
      expect(sent.status).toBeUndefined();
      expect(sent.body).toMatchObject({ id: "approval-1", status: "pending" });
    } finally {
      worker = await startWorker(config);
    }
  });

  it("say when a run or an approval does not exist, by code, and answer a read of one with the router's not-found", async () => {
    await expect(detail("does-not-exist")).rejects.toMatchObject({
      status: 404,
      body: { code: "run_not_found", error: expect.stringMatching(/does-not-exist/) },
    });
    // getRun, a read, finds nothing: the page shows its not-found view.
    await expect(answer("GET", () => detail("does-not-exist"))).rejects.toSatisfy(isNotFound);
    const approval = await decideAs(
      { runId: "does-not-exist", approvalId: "approval-1", decision: "approve" },
      { actor: "marketing-lead" },
    );
    expect(approval.status).toBe(404);
    expect(approval.body.code).toBe("run_not_found");
  });
});

describe("scenarios and sandbox runs", () => {
  it("lists the scenarios in the config's feature files, with their steps", async () => {
    const body = await scenarios(ctx);
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
    // Its own lines of the feature file: not the feature's, nor the next scenario's.
    expect(launch.text).not.toContain("Feature:");
    expect(launch.text).not.toContain("Publish retried");
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
    const { status, body } = await postRun({ scenario: "nope" });
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "invalid_input", issues: [expect.objectContaining({ path: ["scenario"] })] });
    expect(body.error).toBe(
      'No scenario named "nope"; the scenarios are "Launch on time", "Publish retried", "Copy rejected"',
    );
  });

  it("starts a sandbox run whose approval waits for a person, then checks it against the scenario", async () => {
    const started = await postRun({ scenario: SCENARIO });
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

    const decided = await decideAs(
      { runId: sandboxId, approvalId: held.approvals[0]!.id, decision: "approve" },
      { actor: "marketing-lead" },
    );
    expect(decided.body.status).toBe("approved");
    const done = await waitFor(
      () => detail(sandboxId),
      (d) => d.run.status === "finished",
    );
    expect(done.checks).toHaveLength(5);
    expect(done.checks?.filter((c) => !c.ok)).toEqual([]);
  });

  it("settles a check once its answer cannot change, and fails those not met when the run ends", async () => {
    const started = await postRun({ scenario: "Copy rejected" });
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

    const decided = await decideAs(
      { runId: id, approvalId: held.approvals[0]!.id, decision: "reject" },
      { actor: "marketing-lead" },
    );
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
      // A workflow with no scenarios has its New run form's Sandbox disabled, and says why.
      const pane = await page("/workflows/announce?new");
      expect(pane.text).toContain("Could not read a scenario: announce.feature:3");
      const sandboxLink = linkTag(pane.html, "Sandbox");
      expect(sandboxLink).toContain('aria-disabled="true"');
      expect(sandboxLink).not.toContain("href=");
      expect(pane.text).toContain("No scenarios for this workflow yet");
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

  it("lists no scenarios, with why, when they cannot be read at all", async () => {
    const resolved = {
      scenarios: pathToFileURL(`${scenariosDir}/`),
      get ops(): never {
        throw new Error("the ops are gone");
      },
    };
    expect(await scenarios({ resolved } as never)).toEqual({
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
    const description = describeConfig(config);
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
  it("renders the workflows on the server, with the sidebar linking to each workflow and no runs or Start page, and the theme left to the browser", async () => {
    const res = await fetch(new URL("/workflows", app.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toMatch(/<h1[^>]*>Workflows<\/h1>/);
    expect(html).toContain('data-slot="sidebar-wrapper"');
    expect(html).toContain('href="/workflows/announce"');
    expect(html).not.toContain('href="/runs"');
    expect(html).not.toContain('href="/start');
    expect(html).toContain("sanoma.theme");
    expect(html.match(/<html[^>]*>/)?.[0]).not.toMatch(/class="[^"]*\bdark\b/);
  });

  it("redirects /, /runs, /start and a run's old URL to their pages under /workflows, and not-found for a run that does not exist", async () => {
    // `/start?workflow=` goes to that workflow's page, which says when it does not exist.
    for (const [path, to] of [
      ["/", /\/workflows$/],
      ["/runs", /\/workflows\?view=runs$/],
      ["/start", /\/workflows$/],
      ["/start?workflow=announce", /\/workflows\/announce\?new=true$/],
      ["/start?workflow=nope", /\/workflows\/nope\?new=true$/],
      // The New run pane's old URL goes to the workflow's New run panel, keeping its scenario and filter.
      ["/workflows/announce/new?scenario=Launch+on+time", /\/workflows\/announce\?scenario=Launch\+on\+time&new=true$/],
      ["/workflows/announce/new?runs=sandbox", /\/workflows\/announce\?runs=sandbox&new=true$/],
    ] as const) {
      const res = await fetch(new URL(path, app.url), { redirect: "manual" });
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toMatch(to);
    }
    expect((await page("/workflows/nope/new")).status).toBe(404);
    // A search value the router reads as a number names no workflow: the router drops it first.
    const numeric = await fetch(new URL("/start?workflow=123", app.url));
    expect(new URL(numeric.url).pathname).toBe("/workflows");
    const old = await fetch(new URL(`/runs/${runId}`, app.url), { redirect: "manual" });
    expect(old.status).toBe(307);
    expect(old.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`)).toBe(true);
    // A run under another workflow's page goes to its own workflow's, under one that does not
    // exist too: the run is read before the page could say there is no such workflow.
    for (const name of ["drift", "typo"]) {
      const elsewhere = await fetch(new URL(`/workflows/${name}/runs/${runId}`, app.url), { redirect: "manual" });
      expect(elsewhere.status, name).toBe(307);
      expect(elsewhere.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`), name).toBe(true);
    }
    const missing = await page("/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No run does-not-exist");
  });

  it("renders a run the policy held: its card in the inbox while held, then the hold, the notes and the records", async () => {
    const started = await startAs({ workflow: "announce", input: input("Held by the policy") }, { actor: "held" });
    const id = started.body.runId;
    const approveAs = (approvalId: string, note: string) =>
      decideAs({ runId: id, approvalId, decision: "approve", note }, { actor: "marketing-lead" });
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
    // `?approval=` opens the hold, the sentence above it saying what it lets through.
    const open = await page(`/inbox?approval=${id}/${hold.id}`);
    expect(openTitle(open.html)).toBe(HOLD_TITLE);
    expect(open.text).toContain(
      `held&#x27;s run</a> of <a href="/workflows/announce">Announce a launch</a> wants to publish a post in Ghost, send a broadcast in Resend, and create a post in Bluesky.`,
    );

    const decided = await approveAs(hold.id, "   ");
    expect(decided.body).toMatchObject({ status: "approved" });
    expect(decided.body.note).toBeUndefined();
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

    // Decided lists it from the latest runs, and opens it with no controls.
    const decidedPage = await page(`/inbox?show=decided&approval=${id}/${hold.id}`);
    // All decided, at the foot of the Inbox's panel, is marked.
    expect(decidedPage.html).toMatch(/<a (?=[^>]*href="\/inbox\?show=decided")[^>]*aria-current="page"/);
    expect(openTitle(decidedPage.html)).toBe(HOLD_TITLE);
    expect(decidedPage.text).toContain("wanted to publish a post in Ghost");
    expect(decidedPage.text).toContain("approved by marketing-lead");
    // Its row says how it was decided, not only by colour.
    expect(decidedPage.text).toContain("approved · Announce a launch · from held");
    expect(decidedPage.text).not.toContain(">Approve<");
  });

  it("lists the pending approvals beside the one open, newest first, each row opening its own", async () => {
    const ids: string[] = [];
    for (const title of ["Inbox first", "Inbox second"]) {
      const started = await postRun({ workflow: "announce", input: input(title) });
      await waitFor(
        () => detail(started.body.runId),
        (d) => d.run.status === "waiting",
      );
      ids.push(started.body.runId);
    }
    const [first, second] = ids.map((id) => `${id}/approval-1`);

    // The server knows no name: every pending approval, the newest open and marked in the list.
    const inbox = await page("/inbox");
    expect(inbox.status).toBe(200);
    const rows = inboxRows(inbox.html).map((row) => row.approval);
    expect(rows.indexOf(second!)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(second!)).toBeLessThan(rows.indexOf(first!));
    expect(currentRow(inbox.html)).toBe(rows[0]);
    expect(inbox.text).toContain("tester&#x27;s run</a> of");
    expect(inbox.text).toContain("is waiting on this decision.");
    expect(inbox.text).toMatch(/Announce a launch · from tester/);
    expect(inbox.html).toContain(">Approve<");

    // `?approval=` opens that one; each row keeps the filter.
    const opened = await page(`/inbox?show=waiting&approval=${first}`);
    expect(currentRow(opened.html)).toBe(first);
    expect(opened.html).toContain(`href="/workflows/announce/runs/${ids[0]}"`);
    expect(inboxRows(opened.html)).toEqual(
      rows.map((approval) => ({ approval, show: "waiting", current: approval === first })),
    );

    // One no longer pending, or never, opens the first instead.
    expect(currentRow((await page("/inbox?approval=nothing/approval-1")).html)).toBe(rows[0]);
  });

  it("links For you, Everyone and All decided in the Inbox's panel, each its own URL, and says when nothing waits for you", async () => {
    const inbox = await page("/inbox?approval=x");
    for (const show of ["mine", "waiting", "decided"]) expect(inbox.html).toContain(`href="/inbox?show=${show}"`);
    // Without a name, Everyone is what shows, and it says how many.
    expect(currentLink(inbox.html, "Everyone · \\d+")).toBe(true);
    expect(currentLink(inbox.html, "For you")).toBe(false);
    const mine = await page("/inbox?show=mine");
    expect(currentLink(mine.html, "For you")).toBe(true);
    expect(mine.text).toContain("Nothing is waiting for you");
    // A link to them, which works with the panel folded too.
    expect(mine.text).toMatch(
      /<a[^>]*href="\/inbox\?show=waiting"[^>]*>Show the \d+ approvals? waiting on others<\/a>/,
    );
  });

  it("says a failed call that is not safe to repeat was not retried, and where to look", async () => {
    blog.failNext("ghost.post.create", new DriverError("ghost: the site is down", { retryable: false, status: 503 }));
    const started = await startAs({ workflow: "announce", input: input("Fails at once") }, { actor: "alice" });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "failed",
    );
    const run = await page(`/workflows/announce/runs/${started.body.runId}`);
    expect(run.text).toContain("ghost: the site is down");
    expect(run.text).toContain("Not retried: this operation is not safe to repeat. Check Ghost before starting again.");
    // The run's error is a notice above the graph, and not a fact again below it.
    const notice = run.html.search(/data-slot="alert-description"[^>]*>[^<]*ghost: the site is down/);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(run.html.search(/data-slot="card-title"[^>]*><h2>Graph</));
    expect(run.html).not.toMatch(/<dt[^>]*>Error<\/dt>/);
  });

  it("renders the workflows on the server: a row for each linking to its page, whose About has its operations and input", async () => {
    const { version } = ctx.description;
    const workflows = await page("/workflows");
    expect(workflows.status).toBe(200);
    expect(workflows.text).toContain(`<code>${version}</code>`);
    // What it may call and its input are About's, not the overview's.
    expect(workflows.text).not.toMatch(/>safe to retry<\/span>/);
    const about = await page("/workflows/announce");
    expect(about.text).toMatch(/>safe to retry<\/span>/);
    for (const title of ["Ghost", "Resend", "Bluesky"]) {
      expect(about.html).toMatch(new RegExp(`<img src="data:image/svg\\+xml,[^"]+" alt="${title}"`));
    }
    expect(about.text).toMatch(/default (&quot;|")newsletter(&quot;|")/);
    // Each workflow's row links to its page; its outline is on that page.
    expect(workflows.html).toMatch(
      /<tr[^>]*><td[^>]*><div[^>]*><a[^>]*href="\/workflows\/announce"[^>]*>Announce a launch<\/a>/,
    );
    expect(workflows.html).not.toContain('aria-label="Loading the graph"');
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

  it("renders a connector's page: its links, each operation's contract, phrases and scenarios, and who uses it", async () => {
    const blogPage = await page("/connectors/ghost");
    expect(blogPage.status).toBe(200);
    expect(blogPage.html).toMatch(/<h1[^>]*>(<img[^>]*>)+Ghost<\/h1>/);
    expect(blogPage.text).toContain("<title>Ghost · Sanoma</title>");
    expect(blogPage.html).toContain('href="https://www.npmjs.com/package/@sanoma-ai/connector-ghost"');
    expect(blogPage.html).toContain("<code>ghost.post.create</code>");
    expect(blogPage.text).toContain("<code>Given a post titled {title} exists</code>");
    expect(blogPage.text).not.toContain("Its connector attaches no fake.");
    // The scenario that names the operation, linking to its workflow's New run in Sandbox mode with it chosen.
    expect(blogPage.html).toContain('href="/workflows/announce?new=true&amp;scenario=Launch+on+time"');
    // What each scenario does with an operation: create is seeded and expected; publish fails
    // once ("Publish retried"), is expected, and must not be called ("Copy rejected").
    for (const label of ["seeds", "fails", "expects", "must not call"]) expect(blogPage.text).toContain(`>${label}<`);
    expect(blogPage.html).toContain('href="/workflows/announce"');

    // A vendor with resource operations only has nothing to fake: no notice that it has no fake.
    // Its resource types are named.
    const githubPage = await page("/connectors/github");
    expect(githubPage.text).not.toContain("Its connector attaches no fake.");
    expect(githubPage.html).toMatch(/Resources: <\/span>Branch protection rule, Repository, Team membership</);

    // One with workflow operations whose connector attaches no fake says so, once.
    const chatPage = await page("/connectors/chat");
    expect(chatPage.text.match(/Its connector attaches no fake\./g)).toHaveLength(1);

    const missing = await page("/connectors/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No connector nope");
  });

  it("renders a workflow's page: its graph beside About, its source under Code, New run behind ?new, and not-found for one that does not exist", async () => {
    const found = await page("/workflows/announce");
    expect(found.status).toBe(200);
    expect(found.html).toMatch(/<h1[^>]*>Announce a launch<\/h1>/);
    expect(found.text).toContain("<title>Announce a launch · Sanoma</title>");
    // The page takes the column's full width (`staticData.wide`); other pages keep the reading width.
    expect(found.html).toContain('data-wide="true"');
    expect((await page("/inbox")).html).not.toContain("data-wide=");
    // The graph's card, drawn in the browser: its title and a skeleton.
    expect(found.html).toMatch(/data-slot="card-title"[^>]*><h2>Graph</);
    expect(found.html).toMatch(/<div data-slot="skeleton"[^>]*aria-label="Loading the graph"/);
    // Beside it, the inspector, with nothing selected: About, what it may call.
    expect(found.html).toMatch(/aria-label="Inspector"/);
    expect(found.html).toMatch(/<h2>About</);
    expect(found.html).toMatch(/<h3[^>]*>Operations it may call<\/h3>/);
    // Under them, the Code tab, open: the source as plain text until its view loads. No Ledger
    // tab: the workflow's pane has no run.
    expect(found.html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Code</);
    expect(found.html).not.toMatch(/role="tab"[^>]*>Ledger</);
    expect(found.html).toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    // New run is a link in the header, to the panel; no form until then. No Run here: it would
    // link to this page. Nothing here goes to the Start page.
    expect(linkTag(found.html, "New run")).toMatch(/data-slot="button"[^>]*href="\/workflows\/announce\?new=true"/);
    expect(found.html).not.toContain('id="field-title"');
    expect(linkTag(found.html, "Run")).toBeUndefined();
    expect(found.html).not.toContain('href="/start?workflow=');
    // The panel drills into the workflow: back to the workflows, its Workflow link marking this
    // pane, its runs, and all of the workflow's runs at its foot. The page has no rail.
    expect(found.html).toMatch(/<a [^>]*href="\/workflows"[^>]*>(<svg.*?<\/svg>)?Workflows<\/a>/);
    expect(linkTag(found.html, "Workflow")).toContain('aria-current="page"');
    expect(found.html).toContain('aria-label="Runs"');
    expect(found.html).toMatch(
      /<a [^>]*href="\/workflows\?view=runs&amp;workflow=announce"[^>]*><span>All runs<\/span>/,
    );
    expect(found.html).not.toContain("Runs of this workflow");

    // ?new: the New run panel in the inspector, live: Live vendors and Sandbox, and the vendors
    // it calls for real; its Close drops ?new. A bare ?new, typed by hand, opens it too.
    for (const path of ["/workflows/announce?new=true", "/workflows/announce?new"]) {
      const panel = await page(path);
      expect(panel.status, path).toBe(200);
      expect(panel.html, path).toMatch(/<h2>New run</);
      expect(panel.html, path).toContain('id="field-title"');
    }
    const panel = await page("/workflows/announce?new");
    expect(panel.html).not.toMatch(/<h2>About</);
    expect(panel.html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(panel.html).toMatch(
      /<a[^>]*href="\/workflows\/announce"[^>]*><svg[^>]*>(?:(?!<\/a>)[\s\S])*Close<\/span><\/a>/,
    );
    // A date-time is its ISO text until the browser shows it in its own time zone: empty here.
    const launchAt = panel.html.match(/<input[^>]*id="field-launchAt"[^>]*>/)?.[0];
    expect(launchAt).toContain('type="text"');
    expect(launchAt).toContain('value=""');
    // Each mode is a link; Sandbox opens the first scenario.
    expect(linkTag(panel.html, "Live vendors")).toContain('aria-current="page"');
    const sandboxLink = linkTag(panel.html, "Sandbox");
    expect(sandboxLink).toContain('href="/workflows/announce?new=true&amp;scenario=Launch+on+time"');
    expect(sandboxLink).not.toContain("aria-current");
    expect(panel.text).toContain("Calls Bluesky, Ghost, Resend for real");
    expect(panel.text).toContain(">Start run<");
    expect(panel.text).not.toContain("Nothing leaves Sanoma");

    const missing = await page("/workflows/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No workflow nope");
  });

  it("renders a sandbox run: its badge, its checks and its seeding, and its badge in the runs", async () => {
    const run = await page(`/workflows/announce/runs/${sandboxId}`);
    expect(run.status).toBe(200);
    expect(run.text).toContain("sandbox · Launch on time");
    expect(run.html).toMatch(/<h2[^>]*>Checks<\/h2>/);
    expect(run.text).toContain("resend.broadcast.send was called");
    expect(run.text).toContain("Seeded 1 from scenario “Launch on time”");
    const runs = await page("/workflows/announce");
    expect(runs.text).toContain("sandbox · Launch on time");
  });

  it("renders a page compact while its cookie says so: the graph lower and the sidebar as its own cookie says, folded from its panel's button", async () => {
    // Comfortable without the cookie: #app unmarked. The panel folds from its button or the rail.
    const comfortable = await page("/workflows/announce");
    expect(comfortable.html).toContain('<div id="app">');
    expect(sidebarState(comfortable.html)).toBe("expanded");
    expect(comfortable.html).toContain('data-slot="sidebar-rail"');
    expect(comfortable.html).toMatch(/<button[^>]*aria-label="Collapse the panel"/);

    // Compact: #app marked (the `compact:` variant lowers the graph's box). The sidebar follows
    // its own cookie.
    const compact = await page("/workflows/announce", app.url, {
      headers: { cookie: "sanoma_density=compact; sidebar_state=false" },
    });
    expect(compact.status).toBe(200);
    expect(compact.html).toContain('<div id="app" data-density="compact">');
    expect(compact.html).toMatch(
      /class="[^"]*compact:h-\[440px\][^"]*"><div class="size-full"><div data-slot="skeleton"[^>]*aria-label="Loading the graph"/,
    );
    expect(sidebarState(compact.html)).toBe("collapsed");
  });

  it("folds the panel while the sidebar's cookie says so: the bar alone, its sections peeking their panels", async () => {
    const folded = await page(`/workflows/announce/runs/${runId}`, app.url, {
      headers: { cookie: "sidebar_state=false" },
    });
    expect(folded.status).toBe(200);
    expect(sidebarState(folded.html)).toBe("collapsed");
    // No panel: neither its runs nor its header; the bar's sections remain, the current one marked.
    expect(folded.html).not.toContain('aria-label="Show runs"');
    expect(folded.html).not.toContain('aria-label="Collapse the panel"');
    expect(panelRunIds(folded.html, "x")).toEqual([]);
    // Inbox and Workflows peek their panels: links still (no button role), with a popup.
    for (const to of ["/inbox", "/workflows"]) {
      const tag = section(folded.html, to);
      expect(tag, to).toContain('aria-haspopup="dialog"');
      expect(tag, to).not.toContain('role="button"');
    }
    expect(section(folded.html, "/workflows")).toContain('aria-current="page"');
    // Resources has no panel to peek.
    expect(section(folded.html, "/resources")).not.toContain("aria-haspopup");
  });

  it("answers any other path with the app's not-found page", async () => {
    const res = await fetch(new URL("/nonexistent", app.url));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div id="app">');
  });

  it("answers a path under /api like any other unknown path", async () => {
    for (const path of ["/api/config", "/api/runs?status=waiting"]) {
      const res = await page(path);
      expect(res.status, path).toBe(404);
      expect(res.html, path).toContain('<div id="app">');
    }
  });

  it("renders a run under its workflow's heading, marked in the panel, and answers a run that does not exist with not-found", async () => {
    const found = await page(`/workflows/announce/runs/${runId}`);
    expect(found.status).toBe(200);
    expect(found.html).toMatch(/<h1[^>]*>Announce a launch<\/h1>/);
    expect(found.text).toContain(`<title>${runId} · Sanoma</title>`);
    expect(found.html).toContain('aria-label="Runs"');
    const link = found.html.match(new RegExp(`<a[^>]*href="/workflows/announce/runs/${runId}"[^>]*>`))?.[0];
    expect(link).toContain('aria-current="page"');
    // React Flow draws the graph in the browser only: the server renders its heading and a
    // skeleton. Under it the Ledger tab is open, each row it has a node for with Show in graph;
    // the source waits behind Code.
    expect(found.html).toMatch(/data-slot="card-title"[^>]*><h2>Graph</);
    expect(found.html).toMatch(/<div data-slot="skeleton"[^>]*aria-label="Loading the graph"/);
    expect(found.html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Ledger</);
    expect(found.html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Code</);
    expect(found.html).toContain('aria-label="Ledger"');
    expect(found.html).toMatch(/<button[^>]*aria-label="Show in graph"/);
    expect(found.html).not.toMatch(/<pre[^>]*>[^<]*ctx\.ghost\.post\.create\(/);
    // A finished run has no banner.
    expect(found.text).not.toContain("Waiting on");
    // The inspector, with nothing selected: the run's facts and its approvals.
    expect(found.html).toMatch(/<h2>Run</);
    expect(found.html).toMatch(/<dt[^>]*>Run id<\/dt><dd[^>]*><code[^>]*>/);
    // The header's New run opens the panel on this pane; no Run. The panel's Workflow link is not
    // the current page here.
    expect(linkTag(found.html, "New run")).toMatch(
      new RegExp(`data-slot="button"[^>]*href="/workflows/announce/runs/${runId}\\?new=true"`),
    );
    expect(linkTag(found.html, "Run")).toBeUndefined();
    expect(linkTag(found.html, "Workflow")).not.toContain("aria-current");
    // The workflow's own approval covers no operation, and says so.
    expect(found.html).toMatch(/Lets through<\/dt><dd[^>]*><span[^>]*>no operation by itself/);
    // ?new on a run's pane: the New run panel in place of the run's facts.
    const panel = await page(`/workflows/announce/runs/${runId}?new`);
    expect(panel.html).toContain('id="field-title"');
    expect(panel.html).not.toMatch(/<h2>Run</);

    // A run waiting on its approval: the banner says on whom and for what, with a button to its node.
    const started = await postRun({ workflow: "announce", input: input("Banner") });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "waiting",
    );
    const waiting = await page(`/workflows/announce/runs/${started.body.runId}`);
    expect(waiting.text).toMatch(/Waiting on marketing-lead for “[^”]+”<button[^>]*>Show approval<\/button>/);
    // The inspector, a card, sets out the approval with Approve and Reject, not in a card of its own.
    expect(waiting.html).toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Approve<\/button>/);
    expect(waiting.html).not.toContain('data-slot="card-footer"');
    const missing = await page("/workflows/announce/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No run does-not-exist");
  });

  it("filters the panel's runs by ?runs=, asking the server for a status, and keeps the filter on the panel's links", async () => {
    const { body: runs } = await runsOf({ workflow: "announce", limit: 50 });
    const sandbox = runs.filter((r) => r.sandbox !== undefined).map((r) => r.runId);
    expect(sandbox).toContain(sandboxId);
    const filtered = await page("/workflows/announce?runs=sandbox");
    expect(filtered.status).toBe(200);
    expect(panelRunIds(filtered.html, "sandbox")).toEqual(sandbox.toSorted());
    expect(filtered.html).not.toContain(`href="/workflows/announce/runs/${runId}`);
    expect(filtered.html).toContain('href="/workflows/announce?runs=sandbox"');
    // The filter is the panel's: the section bar's links and ← Workflows do not carry it.
    expect(filtered.html).toContain('href="/workflows"');
    expect(filtered.html).not.toContain('href="/workflows?runs=');
    expect(filtered.html).not.toContain('href="/inbox?runs=');
    // The panel's links keep only the filter: `?new` and `?scenario=` stay with the pane that shows.
    const opened = await page("/workflows/announce?runs=sandbox&new&scenario=Launch+on+time");
    expect(linkTag(opened.html, "Workflow")).toContain('href="/workflows/announce?runs=sandbox"');
    expect(opened.html).toContain(`href="/workflows/announce/runs/${sandboxId}?runs=sandbox"`);
    // Sandbox is a pick from the latest runs, so none there is all it can say.
    expect((await page("/workflows/drift?runs=sandbox")).text).toContain("No sandbox runs among the latest 50");

    // Failed is the server's to pick (`status=failed`), not a pick from the latest 50, so an
    // older failed run is not lost behind them.
    const { body: failed } = await runsOf({ workflow: "announce", status: "failed", limit: 50 });
    expect(failed).not.toEqual([]);
    const failedPage = await page("/workflows/announce?runs=failed");
    expect(failedPage.status).toBe(200);
    expect(panelRunIds(failedPage.html, "failed")).toEqual(failed.map((r) => r.runId).toSorted());
    // The panel's query as the server hands it to the browser: its hash, keys sorted.
    expect(failedPage.html).toContain(String.raw`\"limit\":50,\"status\":\"failed\",\"workflow\":\"announce\"`);
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
      // Nor Postgres's client, which reads and writes the credentials.
      expect(file).not.toMatch(/^pg[-.]/);
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(
        /pg-protocol|pg-pool|sanoma_credentials|pg_notify/,
      );
    }
  });

  it("refuses requests addressed to a name other than this machine's", async () => {
    expect(await rawStatus(app.url, "/workflows", { host: "attacker.example:80" })).toBe(403);
  });
  // wave 2 B: New run
  it("renders a workflow's page in Sandbox mode: the scenario's input read-only, and the scenario", async () => {
    const launch = (await scenarios(ctx)).scenarios.find((s) => s.name === SCENARIO)!;
    // Only the fields its When sets: the rest are made up.
    expect(launch.input).toMatchObject({ title: "Acme Pro", launchAt: "2030-01-01T09:00:00Z" });
    const { title } = launch.input as { title: string };

    const pane = await page("/workflows/announce?new&scenario=Launch+on+time");
    expect(pane.status).toBe(200);
    // One disabled fieldset around the fields: the browser disables every control in it.
    expect(pane.html).toMatch(/<fieldset[^>]*disabled=""[^>]*>(?:(?!<\/fieldset>)[\s\S])*id="field-title"/);
    expect(pane.html).toMatch(new RegExp(`<input[^>]*id="field-title"[^>]*value="${title}"`));
    // A date-time as the scenario gives it, not in this process's time zone.
    expect(pane.html).not.toContain('type="datetime-local"');
    expect(pane.html).toMatch(/<input[^>]*id="field-launchAt"[^>]*value="2030-01-01T09:00:00Z"/);
    expect(linkTag(pane.html, "Sandbox")).toContain('aria-current="page"');
    expect(linkTag(pane.html, "Live vendors")).not.toContain("aria-current");
    expect(pane.html).toMatch(/<select[^>]*aria-label="Scenario"/);
    expect(pane.text).toContain(
      "Nothing leaves Sanoma: the scenario supplies the input and the fakes answer the calls.",
    );
    expect(pane.text).not.toContain("for real");
    expect(pane.text).toContain(">Start sandbox run<");
    // The scenario's text is behind its disclosure, closed until opened in the browser.
    expect(pane.html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>(<svg.*?<\/svg>)?Scenario<\/button>/);

    // An unknown scenario is still Sandbox, and the page says so in the form's place.
    const unknown = await page("/workflows/announce?new&scenario=nope");
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain("No scenario named “nope”");
    expect(unknown.html).toMatch(/<select[^>]*aria-label="Scenario"/);
    expect(unknown.html).not.toContain('id="field-title"');

    // A search value the router reads as a number is no scenario: Live.
    const numeric = await page("/workflows/announce?new&scenario=123");
    expect(numeric.status).toBe(200);
    expect(numeric.text).toContain(">Start run<");
  });
});

// One more app on the file's database, to test four things a deployment may change: its own
// login, listening on every interface, a ledger the worker does not write to, and data
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
    const started = await startAs({ workflow: "drift", input: {} }, { actor: "alice" });
    if (started.status) throw new Error(`startRunFn failed with ${started.status}: ${started.body.error}`);
    driftRun = started.body.runId;
    const done = await waitFor(
      () => detail(driftRun),
      (d) => d.run.status === "finished",
    );
    const finished = done.ledger.at(-1);
    report = (finished?.type === "run.finished" ? finished.output : undefined) as DriftReport;
  });

  it("lists drift runs by workflow, started as the actor", async () => {
    const { body } = await runsOf({ workflow: "drift", limit: 1 });
    expect(body).toMatchObject([
      { runId: driftRun, workflow: "drift", status: "finished", startedBy: { id: "alice" } },
    ]);
    expect((await runsOf({ workflow: "nope" })).body).toEqual([]);
  });

  it("reads each workflow's latest run, by name", async () => {
    const last = await lastRuns(ctx);
    expect(Object.keys(last).toSorted()).toEqual(["announce", "drift"]);
    const { body: announced } = await runsOf({ workflow: "announce", limit: 1 });
    expect(last.announce?.runId).toBe(announced[0]?.runId);
    expect(last.drift?.runId).toBe(driftRun);
  });

  it("refuses a drift run given any input: it reads the data files itself", async () => {
    const forged = await startAs(
      { workflow: "drift", input: { resources: [{ id: "x#y", vendor: "github", type: "repository", name: "x" }] } },
      { actor: "alice" },
    );
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

  it("adopts a drifted field: the vendor's value into the data file, committed through the source", async () => {
    // A root of its own, so the other tests read the fixture's files as they are.
    const root = mkdtempSync(join(tmpdir(), "sanoma-adopt-"));
    cpSync(join(appRoot, "resources"), join(root, "resources"), { recursive: true });
    const commits: unknown[] = [];
    const source: Source = {
      root,
      commit: (made) => {
        commits.push(made);
        return { revision: "0123456789abcdef" };
      },
      head: () => "0123456789abcdef",
    };
    const adopting: AppContext = { ...ctx, resolved: { ...ctx.resolved, root }, source };
    const alice = { id: "alice" };
    const github = "resources/identity/github.ts";
    const before = readFileSync(join(root, github), "utf8");
    const website = { runId: driftRun, id: `${github}#website`, paths: ["has_wiki"] };
    expect(await adopt(adopting, alice, website)).toEqual({ file: github, revision: "0123456789abcdef" });
    expect(readFileSync(join(root, github), "utf8")).toBe(before.replace("has_wiki: false", "has_wiki: true"));
    expect(commits).toEqual([{ paths: [github], message: "Adopt has_wiki of website from github", author: "alice" }]);

    // Without a source, the file is written and nothing committed.
    const stripe = "resources/billing/stripe.ts";
    const pro = { runId: driftRun, id: `${stripe}#pro`, paths: ["name"] };
    expect(await adopt({ ...adopting, source: undefined }, alice, pro)).toEqual({ file: stripe });
    expect(readFileSync(join(root, stripe), "utf8")).toContain('name: "Sanoma Professional",');
    expect(commits).toHaveLength(1);

    // A commit that fails says so, with the file written.
    const failing: Source = {
      ...source,
      commit: () => {
        throw new Error("index.lock exists");
      },
    };
    await expect(adopt({ ...adopting, source: failing }, alice, pro)).rejects.toMatchObject({
      status: 500,
      body: { error: `Wrote ${stripe}, but could not commit it: index.lock exists` },
    });

    // Only a field the run found drifted, and only while the file still declares it.
    await expect(adopt(adopting, alice, { ...website, paths: ["name"] })).rejects.toMatchObject({
      status: 400,
      body: { error: `name of ${github}#website has not drifted` },
    });
    await expect(adopt(adopting, alice, { ...website, id: `${github}#docs` })).rejects.toMatchObject({ status: 404 });
    writeFileSync(join(root, github), before.replaceAll("website", "site"));
    await expect(adopt(adopting, alice, website)).rejects.toMatchObject({
      status: 409,
      body: { error: `Could not adopt into ${github}: The data file declares no resource website` },
    });
    expect(commits).toHaveLength(1);
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
    // A button to adopt each drifted field.
    expect(resources.text.match(/>Adopt</g)).toHaveLength(2);
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

  it("lists the built-in drift workflow like any other, labelled built-in, and starts it from its page", async () => {
    const workflows = await page("/workflows");
    expect(workflows.text).toContain(">built-in<");
    expect(workflows.text).toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/drift"/);
    const start = await page("/workflows/drift?new=true");
    expect(start.status).toBe(200);
    expect(start.text).toContain(">Start run<");
  });
  it("heads the overview with All runs and New workflow, and All runs with All workflows, each view its own link", async () => {
    const overview = await page("/workflows");
    expect(linkTag(overview.html, "All runs")).toContain('href="/workflows?view=runs"');
    expect(overview.html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(<svg.*?<\/svg>)?New workflow<\/button>/);
    const runs = await page("/workflows?view=runs&status=failed");
    expect(linkTag(runs.html, "All workflows")).toContain('href="/workflows"');
    // The panel's See all, and the brand, are lit on the whole overview alone: not on All runs.
    const seeAll = /<a[^>]*href="\/workflows"[^>]*><span>See all/;
    expect(overview.html.match(seeAll)?.[0]).toContain('aria-current="page"');
    expect(runs.html.match(seeAll)?.[0]).not.toContain("aria-current");
    expect(runs.html).not.toMatch(
      /<a[^>]*href="\/workflows"[^>]*aria-current="page"[^>]*><svg[^>]*lucide-shield-check/,
    );
    expect(overview.html).toMatch(
      /<a[^>]*href="\/workflows"[^>]*aria-current="page"[^>]*><svg[^>]*lucide-shield-check/,
    );
    expect(runs.html).toContain('aria-label="Status"');
  });

  it("lists every workflow in a table: how it starts, the vendors it calls, its last run and what waits, with a chip per filter", async () => {
    const workflows = await page("/workflows");
    const row = (name: string) =>
      workflows.text.match(
        new RegExp(`<tr[^>]*><td[^>]*><div[^>]*><a[^>]*href="/workflows/${name}"(?:(?!</tr>)[\\s\\S])*</tr>`),
      )?.[0];
    const announceRow = row("announce");
    expect(announceRow).toContain(">By hand<");
    for (const title of ["Ghost", "Resend", "Bluesky"]) expect(announceRow).toMatch(new RegExp(`/>${title}</span>`));
    // The tests before leave announce with runs, so it has a last run.
    expect(announceRow).toMatch(/>(finished|failed|waiting|running|sleeping)/);
    // Each filter is a link (All without `?filter=`), with how many it holds, the one shown marked.
    const chips = workflows.text.match(
      /<div role="group" data-slot="button-group"[^>]*aria-label="Show"[^>]*>(.*?)<\/div>/,
    )?.[1];
    expect(chips).toMatch(/<a[^>]*href="\/workflows"[^>]*aria-current="page"[^>]*>All · 2<\/a>/);
    for (const [filter, label] of [
      ["waiting", "Waiting on you"],
      ["failed", "Failed last run"],
      ["builtin", "Built-in · 1"],
    ] as const) {
      expect(chips).toMatch(new RegExp(`<a[^>]*href="/workflows\\?filter=${filter}"[^>]*>${label}`));
    }
    // ?filter=builtin keeps drift alone.
    const builtin = await page("/workflows?filter=builtin");
    expect(builtin.html).toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/drift"/);
    expect(builtin.html).not.toMatch(/<td[^>]*><div[^>]*><a[^>]*href="\/workflows\/announce"/);
    expect(linkTag(builtin.text, "Built-in · 1")).toContain('aria-current="page"');
  });

  it("lists the workflows in the Workflows panel by their last run, and See all; with no panel, the bar alone, peeking", async () => {
    const { text, html } = await page("/workflows");
    expect(html).toMatch(/<input[^>]*aria-label="Find a workflow"/);
    // No name on the server under the default resolver: nothing is waiting on you.
    expect(text).not.toContain(">Waiting on you</h3>");
    // Both under Recent, the one run last first.
    const recent = text.slice(text.indexOf(">Recent</h3>"));
    const last = await lastRuns(ctx);
    const [first, second] = ["announce", "drift"]
      .toSorted((a, b) => last[b]!.createdAt - last[a]!.createdAt)
      .map((name) => recent.indexOf(`href="/workflows/${name}"`));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first!);
    expect(text).toMatch(/<a[^>]*href="\/workflows"[^>]*><span>See all 2 workflows<\/span>/);
    expect(html).toContain("--sidebar-width:calc(var(--sidebar-bar-width) + var(--sidebar-panel-width))");
    expect(html).toContain('data-slot="sidebar-rail"');
    // No panel for Resources: the bar alone, open or not, and no rail to fold it; Inbox and
    // Workflows peek their panels from it.
    const resources = await page("/resources", app.url, { headers: { cookie: "sidebar_state=true" } });
    expect(resources.html).toContain("--sidebar-width:var(--sidebar-bar-width)");
    expect(resources.html).not.toContain('aria-label="Find a workflow"');
    expect(resources.html).not.toContain('data-slot="sidebar-rail"');
    for (const to of ["/inbox", "/workflows"])
      expect(section(resources.html, to), to).toContain('aria-haspopup="dialog"');
  });

  it("lists every run under All runs, linking each to its page, sandbox runs badged, and filters them by ?status= as getRuns does", async () => {
    const { body: finished } = await runsOf({ status: "finished" });
    expect(finished.length).toBeGreaterThan(0);
    // Each page's text, and the runs its table links to, by its search.
    const pages: Record<string, string> = {};
    for (const search of ["", "status=finished", "status=asleep"]) {
      const shown = await page(`/workflows?view=runs&${search}`);
      expect(shown.status, search).toBe(200);
      pages[search] = shown.text;
    }
    const rows = Object.fromEntries(
      Object.entries(pages).map(([search, text]) => [
        search,
        [...text.matchAll(/<a[^>]*href="\/workflows\/[^/"]+\/runs\/([^"?]+)"/g)].map(([, id]) => id).toSorted(),
      ]),
    );
    const all = pages[""]!;
    expect(all).toContain('aria-label="Status"');
    expect(rows[""]).toEqual(expect.arrayContaining([runId, driftRun]));
    expect(all).toContain(`sandbox · ${SCENARIO}`);
    expect(pages["status=finished"]).toMatch(/<option[^>]*value="finished"[^>]*selected=""/);
    expect(rows["status=finished"]).toEqual(finished.map((run) => run.runId).toSorted());
    // One that is not a status reads as any; a status with no runs says so.
    expect(rows["status=asleep"]).toEqual(rows[""]);
    expect((await page("/workflows?view=runs&status=cancelled")).text).toContain("No runs with that status");
  });

  it("filters All runs by ?workflow=, as a workflow's panel links there, and shows the filter with its removal", async () => {
    const { body: announced } = await runsOf({ workflow: "announce" });
    const shown = await page("/workflows?view=runs&workflow=announce");
    expect(shown.status).toBe(200);
    const linked = [...shown.text.matchAll(/<a[^>]*href="\/workflows\/([^/"]+)\/runs\/([^"?]+)"/g)];
    expect(linked.map(([, workflow]) => workflow)).not.toContain("drift");
    expect(new Set(linked.map(([, , id]) => id))).toEqual(new Set(announced.map((run) => run.runId)));
    expect(shown.text).toMatch(/Workflow: <code>announce<\/code>/);
    // Its removal keeps the view and drops the workflow.
    expect(shown.html).toMatch(
      /<a[^>]*href="\/workflows\?view=runs"[^>]*><svg[^>]*>(?:(?!<\/a>)[\s\S])*Any workflow<\/span><\/a>/,
    );
    // A workflow with no runs says so.
    expect((await page("/workflows?view=runs&workflow=nope")).text).toContain("No runs of that workflow");
  });

  it("counts in each workflow's row the approvals its runs wait on", async () => {
    const started = await postRun({ workflow: "announce", input: input("Pill") });
    await waitFor(
      () => detail(started.body.runId),
      (d) => d.run.status === "waiting",
    );
    const { body: waiting } = await runsOf({ status: "waiting", workflow: "announce", limit: RUNS_LIMIT.max });
    const pending = waiting.reduce((n, run) => n + run.approvals.filter((a) => a.status === "pending").length, 0);
    expect(pending).toBeGreaterThan(0);
    const workflows = await page("/workflows");
    // Every approval waiting, on anyone: no name on the server, so none for you.
    expect(workflows.text).toContain(`>${pending} approval${pending === 1 ? "" : "s"}</span>`);
    // Drift asks no one.
    expect(workflows.text.match(/>\d+ approvals?<\/span>/g)).toHaveLength(1);
  });
});

/**
 * A login that says who is asking from a test header, the way a hosted deployment reads its
 * session, and serves a sign-out route of its own.
 */
const hostedLogin: LoginProvider = {
  name: "test",
  check() {},
  resolveActor(request) {
    const who = request.headers.get("x-test-user");
    if (who === "boom") throw new Error("the session store is down");
    return who ? { id: who, groups: ["marketing"] } : undefined;
  },
  handle: (request) =>
    new URL(request.url).pathname === "/auth/test/signout" ? new Response(null, { status: 204 }) : undefined,
  signOut: "/auth/test/signout",
};

describe("an app configured otherwise", () => {
  let dir: string;
  let other: App;
  /** The other app's context, as its server functions get it. */
  let otherCtx: AppContext;
  const warned: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-app-ledger-"));
    mkdirSync(join(dir, "resources"));
    // The same app ("sanoma", as no package.json names it), on its own root: its data files are these.
    const GH = `import { github } from "@sanoma-ai/connector-github/resources";\n`;
    writeFileSync(join(dir, "resources", "good.ts"), `${GH}export const web = github.repository({ name: "web" });\n`);
    writeFileSync(join(dir, "resources", "bad.ts"), `${GH}export const docs = github.repository({ name: 1 });\n`);
    // A directory nothing has written to yet: the worker keeps its records in memory.
    const otherConfig = { ...config, ledger: jsonlLedger(join(dir, "ledger")), root: dir };
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.join(" ")));
    other = await startApp(otherConfig, { host: "0.0.0.0", login: hostedLogin });
    warn.mockRestore();
    otherCtx = await contextOf(otherConfig, hostedLogin);
  });
  afterAll(async () => {
    await other?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots with broken data files: lists the resources it could read, and the problems", async () => {
    expect(warned).toEqual([
      expect.stringMatching(/^sanoma app: the config's files have problems.*\n {2}resources\/bad\.ts:2:1: /s),
    ]);
    const body = withoutSources(otherCtx.description);
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
    startAs(
      { workflow: "announce", input: input("Hosted") },
      { app: otherCtx, headers: user ? { "x-test-user": user } : {} },
    );
  const read = () => detail(runId, otherCtx);
  /** The Inbox as the deployment's user `user` sees it. */
  const inboxAs = async (user: string) =>
    (await fetch(new URL("/inbox", other.url), { headers: { "x-test-user": user } })).text();
  /** The Workflows page as the deployment's user `user` sees it. */
  const workflowsAs = async (user: string) =>
    (await fetch(new URL("/workflows", other.url), { headers: { "x-test-user": user } })).text();

  describe("with a login provider", () => {
    it("says who is asking itself, and where to sign out", () => {
      expect([saysWho(ctx), signOutUrl(ctx)]).toEqual([false, undefined]);
      expect([saysWho(otherCtx), signOutUrl(otherCtx)]).toEqual([true, "/auth/test/signout"]);
    });

    it("gives the login every request first", async () => {
      const res = await fetch(new URL("/auth/test/signout", other.url), { method: "POST" });
      expect(res.status).toBe(204);
    });

    it("starts runs as the principal it resolves, groups included", async () => {
      const started = await post("sso-user");
      expect(started.status).toBeUndefined();
      const run = await waitFor(
        () => detail(started.body.runId),
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

    it("opens the Inbox on For you: the approvals the principal it resolves may decide", async () => {
      // The earlier tests leave announce's runs waiting on marketing-lead.
      const lead = await inboxAs("marketing-lead");
      expect(currentLink(lead, "For you · [1-9]\\d*")).toBe(true);
      expect(inboxRows(lead).length).toBeGreaterThan(0);
      const someoneElse = await inboxAs("sso-user");
      expect(currentLink(someoneElse, "For you · 0")).toBe(true);
      expect(someoneElse).toContain("Nothing is waiting for you");
    });

    it("puts the workflows waiting on the principal first in the Workflows panel, with their counts, and in the overview", async () => {
      const lead = (await workflowsAs("marketing-lead")).replaceAll("<!-- -->", "");
      const waiting = lead.slice(lead.indexOf(">Waiting on you</h3>"), lead.indexOf(">Recent</h3>"));
      expect(waiting).toMatch(/href="\/workflows\/announce"[\s\S]*>\d+<span class="sr-only"> waiting on you<\/span>/);
      expect(lead).toMatch(/>Waiting on you · 1<\/a>/);
      expect(lead).toMatch(/>\d+ approvals?, \d+ for you<\/span>/);
      // Nothing waits on sso-user.
      const someoneElse = (await workflowsAs("sso-user")).replaceAll("<!-- -->", "");
      expect(someoneElse).not.toContain(">Waiting on you</h3>");
      expect(someoneElse).toMatch(/>Waiting on you · 0<\/a>/);
    });

    it("answers a resolver that throws with a 500, and logs why", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const failed = await post("boom");
      expect(failed.status).toBe(500);
      expect(failed.body.error).toBe("Something went wrong");
      expect(logged.mock.calls).toEqual([
        [
          expect.stringContaining("a server function failed"),
          expect.objectContaining({ message: "Could not tell who you are: the session store is down" }),
        ],
      ]);
    });
  });

  describe("on every interface", () => {
    it("answers a request addressed to any name, since it was asked to listen beyond this machine", async () => {
      const base = `http://127.0.0.1:${new URL(other.url).port}`;
      expect(await rawStatus(base, "/workflows", { host: "sanoma.example:80" })).toBe(200);
    });
  });

  describe("reading a jsonl ledger", () => {
    it("says a run that has started has no records there: the app reads another ledger than the worker", async () => {
      const body = await read();
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
      expect(result.ledger).toEqual([]);
      expect(result.ledgerError).toMatch(/corrupt ledger line/);
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]?.[0])).toContain(`could not read the ledger of run ${runId}`);
    });
  });
});

describe("an app whose config no longer has a workflow", () => {
  // The file's database, where announce has runs, read by a config without announce.
  let retired: App;
  beforeAll(async () => {
    retired = await startApp({ ...config, workflows: [] }, { port: 0 });
  });
  afterAll(async () => {
    await retired?.close();
  });

  it("keeps the retired workflow's page while it has runs: its name, its runs, and no Run", async () => {
    const about = await page("/workflows/announce", retired.url);
    expect(about.status).toBe(200);
    expect(about.html).toMatch(/<h1[^>]*>announce<\/h1>/);
    expect(about.text).toContain(
      "This config has no workflow named <code>announce</code>. Its past runs are in the panel.",
    );
    expect(about.html).toContain(`href="/workflows/announce/runs/${runId}"`);
    expect((await page("/workflows/announce?new", retired.url)).html).not.toContain('id="field-title"');
    expect(linkTag(about.html, "New run")).toBeUndefined();
    // A run of it has no New run either: there is nothing to start.
    expect(linkTag((await page(`/workflows/announce/runs/${runId}`, retired.url)).html, "New run")).toBeUndefined();
  });

  it("renders a run of it with only the workflow's name, and its old URL leads there", async () => {
    const run = await page(`/workflows/announce/runs/${runId}`, retired.url);
    expect(run.status).toBe(200);
    // Its graph, from the ledger alone, and its ledger; the Code tab says why it has no source.
    expect(run.html).toMatch(/data-slot="card-title"[^>]*><h2>Graph</);
    expect(run.html).toMatch(/role="tab"[^>]*>Ledger</);
    expect(run.html).toContain('aria-label="Ledger"');
    const old = await fetch(new URL(`/runs/${runId}`, retired.url), { redirect: "manual" });
    expect(old.status).toBe(307);
    expect(old.headers.get("location")?.endsWith(`/workflows/announce/runs/${runId}`)).toBe(true);
  });

  it("answers a workflow with neither a config entry nor runs with not-found", async () => {
    const missing = await page("/workflows/nope", retired.url);
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("No workflow nope");
  });
});

describe("an app whose drivers declare environment variables", () => {
  // Made-up variables and values: nothing here is a credential.
  const URL_VAR = "SANOMA_TEST_GHOST_URL";
  const KEY_VAR = "SANOMA_TEST_GHOST_KEY";
  const SITE = "https://madeup-site.example.test";
  const KEY = "key_madeupvalue";
  const env = z.object({
    [URL_VAR]: z.url().describe("the made-up site's URL"),
    [KEY_VAR]: z
      .string()
      .regex(/^key_[a-z]+$/, "a made-up key, key_<letters>")
      .describe("a made-up key"),
  });
  let declaring: App;
  /** The declaring app's context, as its server functions get it. */
  let declaringCtx: AppContext;
  /** `setCredentialFn` and `clearCredentialFn` on the declaring app, as tester. */
  const set = (data: unknown) => setAs(data, { actor: "tester", app: declaringCtx });
  const clear = (data: unknown) => clearAs(data, { actor: "tester", app: declaringCtx });
  /** `getCredentials` on the declaring app. */
  const statuses = () => credentials(declaringCtx);
  beforeAll(async () => {
    vi.stubEnv(URL_VAR, SITE);
    vi.stubEnv(KEY_VAR, undefined);
    // The ghost driver (the first connector's), with an env: startApp does not refuse what startWorker would.
    const connectors = [
      withSetup(config.connectors[0]!, { driver: () => ({ ...blog.driver, env }) }),
      ...config.connectors.slice(1),
    ];
    declaring = await startApp({ ...config, connectors }, { port: 0 });
    declaringCtx = await contextOf({ ...config, connectors });
    // The table outlives a run of the tests.
    await clear({ name: KEY_VAR });
    await clear({ name: URL_VAR });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await declaring?.close();
  });

  it("says on /connectors how many variables a vendor needs, and nothing for a vendor that declares none", async () => {
    const connectors = await page("/connectors", declaring.url);
    expect(connectors.text).toContain("2 operations · used by 1 workflow · needs 1 variable");
    expect(connectors.text).not.toContain("configured");
    expect((await page("/connectors")).text).not.toMatch(/needs \d+ variable|configured/);
  });

  it("lists each variable on the connector's page with its status and Set, or that the environment sets it", async () => {
    const blogPage = await page("/connectors/ghost", declaring.url);
    expect(blogPage.html).toMatch(/>Credentials<\/h2>/);
    expect(blogPage.text).toMatch(
      new RegExp(`<code>${URL_VAR}</code>.*?>set<.*?the made-up site&#x27;s URL.*?set in the environment`),
    );
    expect(blogPage.text).toMatch(new RegExp(`<code>${KEY_VAR}</code>.*?>missing<.*?a made-up key.*?>Set</button>`));
    // One Set: the environment's variable has no controls.
    expect(blogPage.text.match(/>(Set|Replace|Clear)<\/button>/g)).toEqual([">Set</button>"]);
    expect(blogPage.html).not.toContain(SITE);
    // A vendor whose drivers declare nothing has no such section.
    expect((await page("/connectors/resend", declaring.url)).html).not.toMatch(/>Credentials</);
  });

  it("carries the statuses in getCredentials, not the config's description, never a value", async () => {
    const body = withoutSources(declaringCtx.description);
    expect(body.vendors.ghost).not.toHaveProperty("credentials");
    const found = await statuses();
    expect(Object.keys(found)).toEqual(["ghost"]);
    expect(found.ghost).toEqual([
      { name: URL_VAR, description: "the made-up site's URL", optional: false, status: "set", source: "environment" },
      { name: KEY_VAR, description: "a made-up key", optional: false, status: "missing" },
    ]);
    expect(JSON.stringify([body, found])).not.toContain(SITE);
  });

  it("refuses a value the variable's schema refuses, a name no driver declares, and an anonymous change, without the value", async () => {
    const VALUE = "key_NOT-LOWER";
    const invalid = await set({ name: KEY_VAR, value: VALUE });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["value"] })],
    });
    expect(JSON.stringify(invalid.body)).not.toContain(VALUE);

    const undeclared = await set({ name: "SANOMA_TEST_UNDECLARED", value: KEY });
    expect(undeclared.status).toBe(400);
    expect(undeclared.body).toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ path: ["name"] })],
    });
    expect(JSON.stringify(undeclared.body)).not.toContain(KEY);
    const empty = await set({ name: KEY_VAR, value: "" });
    expect(empty.body.issues?.[0]).toMatchObject({
      path: ["value"],
      message: "Enter a value",
    });

    const anonymous = await setAs({ name: KEY_VAR, value: KEY }, { app: declaringCtx });
    expect(anonymous.status).toBe(400);
    expect((await statuses()).ghost?.[1]?.status).toBe("missing");
  });

  it("stores a value as the actor, says who set it on the page, then clears it", async () => {
    // It succeeds, and nothing comes back: never the value.
    expect(await set({ name: KEY_VAR, value: KEY })).toEqual({ body: undefined });
    const [, key] = (await statuses()).ghost!;
    expect(key).toMatchObject({ name: KEY_VAR, status: "set", source: "stored", setBy: "tester" });

    const blogPage = await page("/connectors/ghost", declaring.url);
    expect(blogPage.text).toMatch(new RegExp(`<code>${KEY_VAR}</code>.*?>set<.*?set by tester · <time`));
    expect(blogPage.text.match(/>(Set|Replace|Clear)<\/button>/g)).toEqual([">Replace</button>", ">Clear</button>"]);
    expect((await page("/connectors", declaring.url)).text).toContain("· configured");
    for (const html of [blogPage.html, JSON.stringify(await statuses())]) expect(html).not.toContain(KEY);

    expect(await clear({ name: KEY_VAR })).toEqual({ body: undefined });
    expect((await statuses()).ghost?.[1]).toEqual({
      name: KEY_VAR,
      description: "a made-up key",
      optional: false,
      status: "missing",
    });
  });
});

describe("startApp", () => {
  it("refuses to listen beyond this machine without a login", async () => {
    await expect(startApp(config, { host: "0.0.0.0" })).rejects.toThrow(
      /^The app has no login, so it listens on this machine only, not 0\.0\.0\.0/,
    );
    expect(() => loopbackLogin().check("::1")).not.toThrow();
  });

  it("says to build the app when it is not built", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sanoma-app-dist-"));
    try {
      await expect(startApp(config, { distDir: empty })).rejects.toThrow(/pnpm --filter @sanoma-ai\/app build/);
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
