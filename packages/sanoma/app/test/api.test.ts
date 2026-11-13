import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl, waitFor } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import {
  ANONYMOUS_PRINCIPAL,
  defineConnector,
  defineDriver,
  defineWorkflow,
  DriverError,
  type Principal,
  resolveConfig,
  type SanomaConfig,
  visitorPrincipal,
  withSetup,
} from "sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import outboundNext from "../../workflows/test/fixtures/outbound/workflows/outbound-next.ts";
import { ACTOR_HEADER, AGENT_HEADER, ApiError, AppConfigSchema, CallRequest, type ErrorResponse } from "../src/api.ts";
import { createApi } from "../src/api-client.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { actorOf, appConfig, callApi, postCall, requireActor, serverFnFailure, validate } from "../src/server/core.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import companySites from "./fixtures/company-sites/sanoma.config.ts";

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
    close: {
      effect: "write",
      input: z.object({ id: z.string() }),
      output: z.object({}),
    },
  },
});
const acmeDriver = defineDriver(acme, {
  customer: {
    get: async ({ id }) => ({ id, name: "Acme Ltd" }),
    rename: async (input) => input,
    close: async ({ id }) => {
      throw new DriverError(`${id} cannot be closed`, { retryable: false });
    },
  },
});

// The outbound fixture, copied to a root of its own: its collection, and its workflow, which imports
// it from there, with its people and a policy that allows, but denies a lead `lost` and holds one
// `won` for `lead`, and lets visitors start the workflow.
const root = mkdtempSync(join(tmpdir(), "sanoma-api-"));
cpSync(fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)), root, { recursive: true });
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lead = sanoma.person({ id: "lead" });
export const claudeCode = sanoma.agent({ id: "claude-code", client: "claude-code" });
`,
);
mkdirSync(join(root, "policies"));
writeFileSync(
  join(root, "policies/leads.cedar"),
  `@reason("leads are not lost")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "lost" };

@hold("lead")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "won" };

permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:outbound-next", resource);
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A workflow whose run fails: its one call's vendor refuses it. */
const refuse = defineWorkflow({
  name: "refuse",
  title: "Close a customer",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [acme.customer.close],
  run: async (ctx, { id }) => ctx.acme.customer.close({ id }),
});

const config: SanomaConfig = {
  workflows: [outboundNext, refuse],
  connectors: [withSetup(acme, { driver: () => acmeDriver })],
  collections: [outbound],
  root,
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
const snapshot = await appSnapshot(testApp.config);
const appContext = (): AppContext =>
  (context ??= {
    resolved: resolveConfig(testApp.config),
    snapshot,
    client: testApp.client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  });

/**
 * `callFn` with this argument, as the loopback login reads `actor` (none for null) from the header: its answer as
 * the page receives it, or the ApiError's status and body (`serverFnFailure`).
 */
async function call(data: unknown, actor: string | null = "ada") {
  const app = appContext();
  const headers = actor === null ? {} : { [ACTOR_HEADER]: actor };
  const request = { app, actor: actorOf(app, new Request("http://127.0.0.1/", { headers })) };
  return answered(async () => callApi(app, await requireActor(request), validate(CallRequest)(data as CallRequest)));
}

/** `callFn` as `principal`, as a public site's front door would ask it: the staff login admits no visitor. */
const visit = (data: unknown, principal: Principal) =>
  answered(() => callApi(appContext(), principal, validate(CallRequest)(data as CallRequest)));

/** What `callApi` answered, or the ApiError's status and body (`serverFnFailure`). */
async function answered(asked: () => Promise<unknown>) {
  try {
    return { body: (await asked()) as any };
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

/**
 * `POST /api/call` (`postCall`) with this body, as the loopback login reads `actor` from the header
 * (or as `as` says, a login's), with `headers` besides, on `app`: the answer's status and JSON.
 */
async function post(
  body: unknown,
  actor: string | null = "ada",
  { headers = {}, app = appContext(), as }: { headers?: Record<string, string>; app?: AppContext; as?: Principal } = {},
) {
  const sent = {
    "content-type": "application/json",
    ...(actor === null ? {} : { [ACTOR_HEADER]: actor }),
    ...headers,
  };
  const request = new Request("http://127.0.0.1/api/call", {
    method: "POST",
    headers: sent,
    body: JSON.stringify(body),
  });
  const res = await postCall(request, { app, actor: as ? async () => as : actorOf(app, request) });
  return { status: res.status, body: (await res.json()) as any };
}

describe("POST /api/call", () => {
  it("starts a workflow and reads its result as callFn does, over plain JSON", async () => {
    await post({ name: "data.outbound.save", input: { record: lead("Json Co") }, id: crypto.randomUUID() });
    const id = crypto.randomUUID();
    expect(await post({ name: "outboundNext.start", input: { company: "Json Co" }, id })).toEqual({
      status: 200,
      body: { runId: id },
    });
    expect(await post({ name: "outboundNext.result", input: { runId: id } })).toEqual({
      status: 200,
      body: expect.any(String),
    });
  });

  it("answers a failed run's result 422 with its failure, so a client neither retries it nor loses why", async () => {
    const id = crypto.randomUUID();
    await post({ name: "refuse.start", input: { id: "c9" }, id });
    expect(await post({ name: "refuse.result", input: { runId: id } })).toEqual({
      status: 422,
      body: { error: "c9 cannot be closed", code: "driver_failed", runId: id },
    });
  });

  it("refuses an api token on the app's own host, whose login reads none", async () => {
    const app = appContext();
    const headers = { "content-type": "application/json", authorization: "Bearer sca_test", [ACTOR_HEADER]: "ada" };
    const request = new Request("http://127.0.0.1/api/call", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "data.outbound.list" }),
    });
    const res = await postCall(request, { app, actor: actorOf(app, request) });
    expect(res.status).toBe(401);
  });

  it("answers a refusal with its status and body, and a request that says nobody or names nothing 400", async () => {
    expect(await post({ name: "nothing.here" })).toMatchObject({ status: 400, body: { code: "invalid_input" } });
    expect(await post({ input: {} })).toMatchObject({ status: 400, body: { code: "invalid_input" } });
    expect(await post({ name: "outboundNext.start", input: { company: "Bob" } }, null)).toMatchObject({
      status: 400,
      body: { code: "invalid_input" },
    });
  });
});

/** Who a run is started by when the declared agent `claude-code` starts it for ada. */
const agentForAda = { id: "claude-code", groups: ["agents"], onBehalfOf: "ada" };

describe("POST /api/call as a declared agent, named in x-sanoma-agent", () => {
  const agent = { [AGENT_HEADER]: "claude-code" };

  it("starts a run as the agent for the person on this machine, and as the person without the header", async () => {
    const id = crypto.randomUUID();
    const started = await post({ name: "outboundNext.start", input: { company: "Agent Co" }, id }, "ada", {
      headers: agent,
    });
    expect(started).toEqual({ status: 200, body: { runId: id } });
    expect((await testApp.client.run(id))?.startedBy).toEqual(agentForAda);
    const own = (await post({ name: "outboundNext", input: { company: "Agent Co" } })).body.runId as string;
    expect((await testApp.client.run(own))?.startedBy).toMatchObject({ id: "ada" });
  });

  it("refuses an id that is no declared agent, and an agent any built-in but its own", async () => {
    for (const named of ["nobody", "lead"]) {
      expect(
        await post({ name: "data.outbound.list" }, "ada", { headers: { [AGENT_HEADER]: named } }),
        named,
      ).toMatchObject({
        status: 403,
        body: { code: "not_admitted" },
      });
    }
    expect(await post({ name: "goLive", input: {} }, "ada", { headers: agent })).toMatchObject({
      status: 403,
      body: { code: "policy_denied" },
    });
  });

  it("refuses the header on a host and on a public site's host, whose logins say who is asking", async () => {
    const app = appContext();
    const hosted: AppContext = { ...app, login: { ...app.login, name: "staff" } };
    expect(
      await post({ name: "data.outbound.list" }, null, { app: hosted, as: { id: "ada" }, headers: agent }),
    ).toMatchObject({
      status: 400,
      body: {
        code: "invalid_input",
        error: expect.stringMatching(/x-sanoma-agent header is taken on this machine alone/),
      },
    });
    expect((await post({ name: "data.outbound.list" }, null, { app: hosted, as: { id: "ada" } })).status).toBe(200);
    // A request with a bearer on a public site's host (its front door's visitor; a token's admission
    // is the tokens' own): as before without the header, refused with it.
    const site: AppContext = { ...app, site: "members", login: { ...app.login, name: "site:members" } };
    const token = visitorPrincipal("auth0", "u9");
    const bearer = { authorization: "Bearer sca_t1" };
    const started = await post({ name: "outboundNext", input: { company: "Token Co" } }, null, {
      app: site,
      as: token,
      headers: bearer,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((await testApp.client.run(started.body.runId))?.startedBy).toEqual(token);
    expect(
      await post({ name: "outboundNext", input: { company: "Token Co" } }, null, {
        app: site,
        as: token,
        headers: { ...bearer, ...agent },
      }),
    ).toMatchObject({ status: 400, body: { code: "invalid_input" } });
  });
});

describe("POST /api/call through the app", () => {
  let app: App | undefined;
  beforeAll(async () => {
    app = await startApp(testApp.config, { port: 0 });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  /** The app's own origin, which a client that is not a browser sends as its `Origin`. */
  const origin = () => new URL(app!.url).origin;
  const send = (headers: Record<string, string>, body: unknown = { name: "data.outbound.list" }) =>
    fetch(new URL("/api/call", app!.url), {
      method: "POST",
      headers: { "content-type": "application/json", [ACTOR_HEADER]: "ada", ...headers },
      body: JSON.stringify(body),
    });

  it("takes a request that is no browser's when it names the app's own Origin, as sanoma call does", async () => {
    const res = await send({ origin: origin() });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("refuses one that says nothing of where it comes from, and another site's", async () => {
    // Node's fetch sends no Origin, Sec-Fetch-Site or Referer: the route's CSRF check refuses it.
    expect((await send({})).status).toBe(403);
    expect((await send({ origin: "https://attacker.example" })).status).toBe(403);
    expect((await send({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("starts a run as the agent x-sanoma-agent names, for the person", async () => {
    const id = crypto.randomUUID();
    const res = await send(
      { origin: origin(), [AGENT_HEADER]: "claude-code" },
      { name: "outboundNext.start", input: { company: "Route Co" }, id },
    );
    expect([res.status, await res.json()]).toEqual([200, { runId: id }]);
    expect((await testApp.client.run(id))?.startedBy).toEqual(agentForAda);
  });
});

describe("callFn for a visitor", () => {
  const visitor = visitorPrincipal("auth0", "u1");

  it("starts a workflow a policy permits it, and reads only the result of its own run", async () => {
    const started = await visit({ name: "outboundNext", input: { company: "Nobody Co" } }, visitor);
    const { runId } = started.body as { runId: string };
    expect((await testApp.client.run(runId))?.startedBy).toEqual(visitor);
    expect(await visit({ name: "outboundNext.result", input: { runId } }, visitor)).toEqual({ body: null });
    const other = (await call({ name: "outboundNext", input: { company: "Nobody Co" } })).body.runId;
    expect(await visit({ name: "outboundNext.result", input: { runId: other } }, visitor)).toMatchObject({
      status: 404,
      body: { code: "run_not_found" },
    });
    for (const name of ["outboundNext.latest", "outboundNext.runs", "outboundNext.approvals", "outboundNext.ledger"]) {
      expect(await visit({ name, input: { runId } }, visitor), name).toMatchObject({
        status: 403,
        body: {
          code: "policy_denied",
          error: expect.stringContaining("a visitor reads only the result of a run it started"),
        },
      });
    }
  });

  it("calls no built-in workflow, nor what no policy permits it", async () => {
    expect(await visit({ name: "call.approvals", input: { runId: "x" } }, visitor)).toMatchObject({
      status: 400,
      body: { code: "invalid_input" },
    });
    expect(await visit({ name: "data.outbound.list" }, visitor)).toMatchObject({
      status: 403,
      body: { code: "policy_denied" },
    });
    expect(await visit({ name: "outboundNext", input: { company: "Nobody Co" } }, ANONYMOUS_PRINCIPAL)).toMatchObject({
      status: 403,
      body: { code: "policy_denied" },
    });
  });

  it("starts none of the app's own actions on the repository, nor does an api token, whatever its groups", async () => {
    const token: Principal = { id: "token:t1", groups: ["admin"] };
    for (const principal of [visitor, token]) {
      for (const name of ["adopt", "patch", "goLive", "goLiveHost", "connectExisting"]) {
        expect(await visit({ name, input: {} }, principal), `${principal.id} ${name}`).toMatchObject({
          status: 400,
          body: { code: "invalid_input", error: expect.stringContaining("is neither an operation nor a workflow") },
        });
      }
    }
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

describe("getConfig", () => {
  it("holds to AppConfigSchema, on the outbound copy and the company-sites fixture, with each content kind's front matter keys", async () => {
    const outboundConfig = appConfig(appContext());
    expect(AppConfigSchema.parse(outboundConfig)).toEqual(outboundConfig);
    expect(outboundConfig.content).toEqual([]);
    const sites = appConfig({
      ...appContext(),
      resolved: resolveConfig(companySites),
      snapshot: await appSnapshot(companySites),
    });
    expect(AppConfigSchema.parse(sites)).toEqual(sites);
    // Drafts kept, translations laid over their originals: every key a file holds.
    expect(sites.content).toEqual([{ kind: "posts", fields: ["title", "description", "draft", "publishedAt"] }]);
  });
});
