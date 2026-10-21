import { fileURLToPath } from "node:url";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import {
  allow,
  approve,
  defineConnector,
  defineDriver,
  definePolicy,
  deny,
  resolveConfig,
  type SanomaConfig,
  withSetup,
} from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import outboundNext from "../../workflows/test/fixtures/outbound/workflows/outbound-next.ts";
import { ACTOR_HEADER, ApiError, CallRequest, type ErrorResponse } from "../src/api.ts";
import { createApi } from "../src/api-client.ts";
import type { AppContext } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { actorOf, callApi, requireActor, serverFnFailure, validate } from "../src/server/core.ts";

// Needs Postgres (`pnpm db:up`). A site's `api`: `callFn` through the server core, as its server
// function calls it (`withPrincipal`, its validator, `callApi`), for every form of name; and
// `createApi`'s requests, over a fake transport.

const acme = defineConnector("acme", {
  customer: {
    get: {
      effect: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
    },
    rename: {
      effect: "write",
      input: z.object({ id: z.string(), name: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
    },
  },
});
const acmeDriver = defineDriver(acme, {
  customer: { get: async ({ id }) => ({ id, name: "Acme Ltd" }), rename: async (input) => input },
});

/** Allows, but denies a lead `lost` and holds one `won` for `lead`. */
const policy = definePolicy(({ input }) => {
  const stage = (input as { record?: { stage?: string } }).record?.stage;
  if (stage === "lost") return deny("leads are not lost");
  if (stage === "won") return approve("lead");
  return allow();
});

// The outbound fixture's root: its collection, and its workflow, which imports it from there.
const config: SanomaConfig = {
  workflows: [outboundNext],
  connectors: [withSetup(acme, { driver: () => acmeDriver })],
  collections: [outbound],
  policy,
  root: fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)),
};
const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("api") });

const lead = (company: string, stage = "researched") => ({
  company,
  contact: `ada@${company.toLowerCase()}.test`,
  stage,
  owner: "ada",
});

/** The app's context, as startApp builds it, on the test app's client: made at the first call. */
let context: AppContext | undefined;

/**
 * `callFn` with this argument, as the loopback login reads `actor` (none for null) from the header: its answer as
 * the page receives it, or the ApiError's status and body (`serverFnFailure`).
 */
async function call(data: unknown, actor: string | null = "ada") {
  const app = (context ??= {
    resolved: resolveConfig(testApp.config),
    description: describeConfig(testApp.config),
    client: testApp.client,
    login: loopbackLogin(),
  });
  const headers = actor === null ? {} : { [ACTOR_HEADER]: actor };
  const request = { app, actor: actorOf(app, new Request("http://127.0.0.1/", { headers })) };
  try {
    const principal = await requireActor(request);
    return { body: (await callApi(app, principal, validate(CallRequest)(data as CallRequest))) as any };
  } catch (err) {
    const failure = serverFnFailure(err, "POST");
    if (!(failure instanceof ApiError)) throw failure;
    return { status: failure.status, body: failure.body as ErrorResponse };
  }
}

describe("callFn", () => {
  it("needs someone to say who is asking", async () => {
    expect(await call({ name: "data.outbound.list" }, null)).toMatchObject({
      status: 400,
      body: { code: "invalid_input" },
    });
  });

  it("calls a collection's operations directly, a write as the person asking", async () => {
    const saved = await call({ name: "data.outbound.save", input: { record: lead("Acme") }, id: crypto.randomUUID() });
    expect(saved.body).toMatchObject({ key: "Acme", record: lead("Acme"), updatedBy: "ada" });
    expect((await call({ name: "data.outbound.get", input: { key: "Acme" } })).body).toMatchObject({
      key: "Acme",
      updatedBy: "ada",
    });
    // No input lists with the defaults.
    const listed = await call({ name: "data.outbound.list" });
    expect(listed.body.map((r: { key: string }) => r.key)).toContain("Acme");
  });

  it("calls a vendor's read directly, and refuses its write: a workflow's to call", async () => {
    expect(await call({ name: "acme.customer.get", input: { id: "c1" } })).toEqual({
      body: { id: "c1", name: "Acme Ltd" },
    });
    expect(await call({ name: "acme.customer.rename", input: { id: "c1", name: "B" } })).toMatchObject({
      status: 400,
      body: { code: "invalid_input", error: expect.stringMatching(/cannot be called directly/) },
    });
  });

  it("answers a denied call 403 policy_denied, and a held one 409 approval_pending with its run, in the Inbox", async () => {
    expect(await call({ name: "data.outbound.save", input: { record: lead("Lost Ltd", "lost") } })).toMatchObject({
      status: 403,
      body: { code: "policy_denied", error: expect.stringMatching(/leads are not lost/) },
    });
    const id = crypto.randomUUID();
    const held = await call({ name: "data.outbound.save", input: { record: lead("Won Ltd", "won") }, id });
    expect(held).toEqual({
      status: 409,
      body: { error: expect.stringMatching(/needs an approval/), code: "approval_pending", runId: `call:ada:${id}` },
    });
    const approvals = () => call({ name: "call.approvals", input: { runId: `call:ada:${id}` } });
    await waitFor(async () => (await approvals()).body.length > 0);
    expect((await approvals()).body).toEqual([expect.objectContaining({ approver: "lead", status: "pending" })]);
  });

  it("refuses a name that is neither an operation nor a workflow's", async () => {
    for (const name of ["nope", "data.outbound", "outboundNext.nope", "outboundNext.start.again", "outbound-next"]) {
      expect(await call({ name, input: {} }), name).toMatchObject({
        status: 400,
        body: { code: "invalid_input", error: expect.stringMatching(/is neither an operation nor a workflow/) },
      });
    }
  });

  it("starts a workflow by its api name, and reads its result, latest run, runs, approvals and ledger", async () => {
    await call({ name: "data.outbound.save", input: { record: lead("Next Co") }, id: crypto.randomUUID() });
    const id = crypto.randomUUID();
    const started = await call({ name: "outboundNext.start", input: { company: "Next Co" }, id });
    expect(started).toEqual({ body: { runId: id } });
    // The same id again is the same run.
    expect(await call({ name: "outboundNext", input: { company: "Next Co" }, id })).toEqual({ body: { runId: id } });
    expect((await testApp.client.run(id))?.startedBy).toEqual({ id: "ada" });
    const { runId } = started.body as { runId: string };
    const result = await call({ name: "outboundNext.result", input: { runId } });
    expect(result).toEqual({ body: expect.any(String) });
    expect(await call({ name: "outboundNext.latest" })).toEqual({
      body: { runId, output: result.body, at: expect.any(Number) },
    });
    const runs = await call({ name: "outboundNext.runs", input: { limit: 1 } });
    expect(runs.body).toEqual([expect.objectContaining({ runId, workflow: "outbound-next", status: "finished" })]);
    expect(await call({ name: "outboundNext.approvals", input: { runId } })).toEqual({ body: [] });
    const ledger = await call({ name: "outboundNext.ledger", input: { runId } });
    expect(ledger.body.map((r: { type: string }) => r.type)).toEqual(
      expect.arrayContaining(["run.started", "op.called"]),
    );
    // A run of another workflow is none of this one's.
    expect(await call({ name: "call.ledger", input: { runId } })).toMatchObject({
      status: 404,
      body: { code: "run_not_found" },
    });
  });

  it("answers a run that has not ended 409 run_running, with the run, and refuses a start's bad input", async () => {
    const started = await call({ name: "outboundNext", input: { company: "Nobody" }, id: crypto.randomUUID() });
    const { runId } = started.body as { runId: string };
    expect(await call({ name: "outboundNext.result", input: { runId, waitMs: 0 } })).toEqual({
      status: 409,
      body: { error: expect.stringMatching(/still running/), code: "run_running", runId },
    });
    expect(await call({ name: "outboundNext.start", input: { company: "" } })).toMatchObject({
      status: 400,
      body: { code: "invalid_input", issues: [expect.objectContaining({ path: ["company"] })] },
    });
    // An id is the caller's own, never one of the runtime's (`call:<actor>:<id>`).
    expect(await call({ name: "outboundNext.start", input: { company: "Bob" }, id: "call:bob:1" })).toMatchObject({
      status: 400,
      body: { code: "invalid_input", issues: [expect.objectContaining({ path: ["id"] })] },
    });
    expect(await call({ name: "outboundNext.result", input: {} })).toMatchObject({
      status: 400,
      body: { code: "invalid_input" },
    });
  });
});

/** An `api` whose transport records each request and answers with the next of `answers` (thrown when an Error). */
function fake(...answers: unknown[]) {
  const sent: CallRequest[] = [];
  const api = createApi(async (request) => {
    sent.push(request);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }) as any;
  return { api, sent };
}

/** What the server answers a result asked for too soon. */
const running = () => new ApiError(409, { error: "still running", code: "run_running", runId: "r1" });

describe("createApi", () => {
  const uuid = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

  it("sends a path as the name, an operation's call and a start with a new id each", async () => {
    const { api, sent } = fake();
    await api.data.outbound.list({ order: "company" });
    await api.announce.start({ title: "Hi" });
    await api.stripe.customers.get({ id: "c1" });
    await api.stripe.customers.get({ id: "c1" });
    expect(sent).toEqual([
      { name: "data.outbound.list", input: { order: "company" }, id: uuid },
      { name: "announce.start", input: { title: "Hi" }, id: uuid },
      { name: "stripe.customers.get", input: { id: "c1" }, id: uuid },
      { name: "stripe.customers.get", input: { id: "c1" }, id: uuid },
    ]);
    expect(new Set(sent.map((r) => r.id)).size).toBe(4);
  });

  it("sends a workflow's reads with their arguments as the input, and no id", async () => {
    const { api, sent } = fake();
    await api.announce.result("r1");
    await api.announce.result("r1", 5000);
    await api.announce.latest();
    await api.announce.runs({ limit: 3 });
    await api.announce.approvals("r1");
    await api.announce.ledger("r1");
    expect(sent).toEqual([
      { name: "announce.result", input: { runId: "r1" } },
      { name: "announce.result", input: { runId: "r1", waitMs: 5000 } },
      { name: "announce.latest", input: undefined },
      { name: "announce.runs", input: { limit: 3 } },
      { name: "announce.approvals", input: { runId: "r1" } },
      { name: "announce.ledger", input: { runId: "r1" } },
    ]);
  });

  it("calls a workflow as a function: starts it, then asks for its result while it runs", async () => {
    const { api, sent } = fake({ runId: "r1" }, running(), running(), "done");
    expect(await api.announce({ title: "Hi" })).toBe("done");
    expect(sent).toEqual([
      { name: "announce", input: { title: "Hi" }, id: uuid },
      ...Array.from({ length: 3 }, () => ({ name: "announce.result", input: { runId: "r1" } })),
    ]);
    // Any other failure is the call's.
    const failed = fake({ runId: "r2" }, new ApiError(500, { error: "Something went wrong" }));
    await expect(failed.api.announce({})).rejects.toMatchObject({ status: 500 });
  });

  it("is no thenable, so a path can be awaited as itself", async () => {
    const { api, sent } = fake();
    expect(api.data.then).toBeUndefined();
    expect(typeof (await api.data)).toBe("function");
    expect(sent).toEqual([]);
  });
});
