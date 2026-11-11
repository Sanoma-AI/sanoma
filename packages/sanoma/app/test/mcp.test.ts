import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl, waitFor, withFake } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import {
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  type Principal,
  resolveConfig,
  type SanomaConfig,
  visitorPrincipal,
  withSetup,
} from "sanoma/workflows";
import { defineFake } from "sanoma/workflows/fake";
import { BUILT_IN_WORKFLOWS } from "sanoma/workflows/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { customers as crmCustomers } from "../../workflows/test/fixtures/company-apps/apps/crm/resources/data.ts";
import followUp from "../../workflows/test/fixtures/company-apps/apps/crm/workflows/follow-up.ts";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import { ACTOR_HEADER } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { admitting } from "../src/login/admission.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { actorOf, agentDescription, callApi } from "../src/server/core.ts";
import { postMcp } from "../src/server/mcp.ts";
import { appSnapshot } from "../src/snapshot-build.ts";

// Needs Postgres (`pnpm db:up`), and the app built (`pnpm --filter sanoma build`) for the last
// describe, which goes through the app's handler. `POST /mcp`: its guards, both protocol eras'
// tools/list, and each tool, through `postMcp` as the route calls it.

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
  customer: {
    get: async ({ id }) => ({ id, name: "Acme Ltd" }),
    rename: async (input) => input,
  },
});

// A vendor whose hooks a data file declares, so the config has drift; what it declares (the URL and
// a write-only token) is what `describe` must not say.
const DESIRED_URL = "https://example.com/desired-hook";
const SECRET = "secret-no-agent-reads";
const hook = defineResource({
  vendor: "hooks",
  type: "hook",
  title: "Hook",
  identity: "name",
  schema: z.object({ name: z.string(), url: z.string().nullish(), token: z.string().nullish() }),
  fields: { immutable: [], vendorOwned: [], writeOnly: ["token"] },
  find: ({ name }) => name,
});
const hooks = defineConnector("hooks", { hook }, { title: "Hooks", package: "@acme/hooks" });
const hooksFake = defineFake(hooks, {
  initial: () => ({}),
  ops: () => ({
    hook: {
      import: async ({ id }) => ({ id, gone: false, state: { name: id, url: DESIRED_URL } }),
      read: async ({ id }) => ({ id, gone: true }),
    },
  }),
});

// The root: its people, the hook, and a policy that holds a lookup of customer "held" for `lead`.
const root = mkdtempSync(join(tmpdir(), "sanoma-mcp-"));
mkdirSync(join(root, "resources"));
mkdirSync(join(root, "policies"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lead = sanoma.person({ id: "lead" });
`,
);
writeFileSync(
  join(root, "resources/hooks.ts"),
  `import { hooks } from "@acme/hooks/resources";

export const hook = hooks.hook({ name: "deploys", url: "${DESIRED_URL}", token: "${SECRET}" });

export default [hook];
`,
);
const POLICY = `@hold("lead")
forbid (principal, action == Sanoma::Action::"acme.customer.get", resource)
when { context.input.id == "held" };
`;
writeFileSync(join(root, "policies/acme.cedar"), POLICY);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A workflow that looks a customer up and answers its name. */
const greet = defineWorkflow({
  name: "greet-customer",
  title: "Greet a customer",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [acme.customer.get],
  run: async (ctx, { id }) => (await ctx.acme.customer.get({ id })).name,
});

// With an app's workflow (`crm.follow-up`, from the company-apps fixture), named with its app.
const config: SanomaConfig = {
  workflows: [greet, followUp],
  connectors: [withSetup(acme, { driver: () => acmeDriver }), withFake(hooks, hooksFake)],
  collections: [outbound, crmCustomers],
  root,
};
const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("mcp") });

let context: AppContext | undefined;
const snapshot = await appSnapshot(testApp.config);
/** The app's context, as startApp builds it, on the test app's client: made at the first call. */
const appContext = (): AppContext =>
  (context ??= {
    resolved: resolveConfig(testApp.config),
    snapshot,
    client: testApp.client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  });

const MODERN = "2026-07-28";
/** A 2026-07-28 request's envelope: the version, the client and its capabilities, on every request. */
const envelope = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Era = "modern" | "legacy";
interface Asked {
  era?: Era;
  actor?: string | null;
  headers?: Record<string, string>;
  site?: string;
  /** Who the login says is asking, instead of the loopback header's name: a visitor, say. */
  as?: Principal;
}

/**
 * `POST /mcp` (`postMcp`) with a JSON-RPC request for `method`, as a client of `era` sends it: a
 * 2026-07-28 one with its envelope and `Mcp-Method`/`Mcp-Name` headers, a 2025-era one bare, with no
 * `initialize` first (the stateless server needs none). Its status and the JSON-RPC message, read
 * from an SSE stream's one event when it streams.
 */
async function mcp(method: string, params: Record<string, unknown> = {}, asked: Asked = {}) {
  const { era = "modern", actor = "ada", headers = {}, site, as } = asked;
  const modern = era === "modern";
  const name = typeof params.name === "string" ? { "mcp-name": params.name } : {};
  const request = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(actor === null ? {} : { [ACTOR_HEADER]: actor }),
      ...(modern && { "mcp-protocol-version": MODERN, "mcp-method": method, ...name }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern ? { ...params, _meta: envelope } : params,
    }),
  });
  const app = appContext();
  const actorFn = as ? async () => as : actorOf(app, request);
  const res = await postMcp(request, { app, actor: actorFn, ...(site !== undefined && { site }) });
  return { status: res.status, body: await messageOf(res) };
}

/** The JSON body, or an SSE stream's last `data:` event. */
async function messageOf(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return text ? JSON.parse(text) : undefined;
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .at(-1);
  return data && JSON.parse(data.slice("data:".length));
}

/** A `tools/call` of `name` with `args`: its result (`structuredContent`, `isError`). */
async function tool(name: string, args: Record<string, unknown> = {}, asked: Asked = {}) {
  const { status, body } = await mcp("tools/call", { name, arguments: args }, asked);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.result as { structuredContent?: any; isError?: boolean; content: { text: string }[] };
}

/** Expects each entry's fields to be among `allowed`. */
const fieldsOf = (entries: object[], allowed: string[]) =>
  expect(allowed).toEqual(expect.arrayContaining(entries.flatMap((entry) => Object.keys(entry))));

const TOOLS = ["describe", "drift", "get_run", "lookup", "start_run", "wait_run"];

describe("tools/list", () => {
  for (const era of ["modern", "legacy"] as const) {
    it(`lists the six tools to a ${era === "modern" ? "2026-07-28" : "2025-era"} client, each titled, the start the one write`, async () => {
      const { status, body } = await mcp("tools/list", {}, { era });
      expect(status).toBe(200);
      const tools = body.result.tools as { name: string; title?: string; description?: string; annotations?: any }[];
      expect(tools.map((t) => t.name).toSorted()).toEqual(TOOLS);
      for (const t of tools) {
        expect(t.title, t.name).toEqual(expect.any(String));
        expect(t.description, t.name).toEqual(expect.any(String));
        expect(t.annotations, t.name).toEqual(
          t.name === "start_run" ? { destructiveHint: true } : { readOnlyHint: true },
        );
      }
    });
  }

  it("answers a 2026-07-28 client's subscriptions/listen at once, and ends the response: nothing is ever published", async () => {
    const listening = mcp("subscriptions/listen", { notifications: { toolsListChanged: true } });
    const answered = await Promise.race([
      listening,
      new Promise<"still open">((resolve) => setTimeout(() => resolve("still open"), 5000)),
    ]);
    expect(answered).toMatchObject({ status: 200, body: { error: { code: -32603 } } });
  });

  it("answers a 2025-era client's initialize, which it may still send first", async () => {
    const { status, body } = await mcp(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-test", version: "1" } },
      { era: "legacy" },
    );
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: expect.anything() } });
    // The tools never change, so a client is not invited to listen for a change.
    expect(body.result.capabilities.tools.listChanged).not.toBe(true);
  });
});

describe("the describe tool", () => {
  it("answers the company's workflows, direct operations and collections, as callApi's sanoma.describe", async () => {
    const { structuredContent: described } = await tool("describe");
    expect(described).toEqual(agentDescription(snapshot.description));
    expect(described).toEqual(await callApi(appContext(), { id: "ada" }, { name: "sanoma.describe" }));
    expect(described.workflows).toContainEqual({
      name: "greet-customer",
      apiName: "greetCustomer",
      title: "Greet a customer",
      trigger: "manual",
      input: expect.objectContaining({ properties: { id: { type: "string" } } }),
    });
    // Only the company's own: no workflow of the runtime's, which start_run does not start.
    expect(described.workflows.map((wf: { name: string }) => wf.name).toSorted()).toEqual([
      "crm.follow-up",
      "greet-customer",
    ]);
    expect(described.workflows.filter((wf: { name: string }) => BUILT_IN_WORKFLOWS.has(wf.name))).toEqual([]);
    const ops = described.ops.map((op: { id: string }) => op.id);
    expect(ops).toEqual(expect.arrayContaining(["acme.customer.get", "data.outbound.list"]));
    // A write a workflow calls is not called directly, so it is not listed.
    expect(ops).not.toContain("acme.customer.rename");
    expect(described.ops.find((op: { id: string }) => op.id === "acme.customer.get")).toEqual({
      id: "acme.customer.get",
      effect: "read",
      input: expect.any(Object),
      output: expect.any(Object),
    });
    expect(described.collections).toEqual([
      expect.objectContaining({ name: "crm.customers", key: "email" }),
      expect.objectContaining({ name: "outbound", key: expect.any(String), fields: expect.any(Object) }),
    ]);
  });

  it("says nothing of the policy, the files, the resources' values, secrets, connections or the database", async () => {
    const { structuredContent: described } = await tool("describe");
    expect(Object.keys(described).toSorted()).toEqual(["collections", "name", "ops", "workflows"]);
    const text = JSON.stringify(described);
    // Each, for the full description, is there: what `describe` leaves out.
    const full = JSON.stringify(snapshot.description);
    for (const left of [fileURLToPath(import.meta.url), "Sanoma::Action", DESIRED_URL, SECRET]) {
      expect(full, left).toContain(left);
      expect(text, left).not.toContain(left);
    }
    expect(text).not.toContain(root);
    // Each entry has these fields alone: no file, source, outline or declaration (an input schema may name any field).
    fieldsOf(described.workflows, ["name", "apiName", "title", "trigger", "input"]);
    fieldsOf(described.ops, ["id", "effect", "description", "input", "output"]);
    fieldsOf(described.collections, ["name", "title", "key", "fields", "ops"]);
  });

  it("is refused to a visitor through callApi too", async () => {
    await expect(
      callApi(appContext(), visitorPrincipal("auth0", "u1"), { name: "sanoma.describe" }),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });
});

describe("lookup", () => {
  it("calls a direct read as the person asking: an operation's, and a collection's", async () => {
    expect((await tool("lookup", { op: "acme.customer.get", input: { id: "c1" } })).structuredContent).toEqual({
      id: "c1",
      name: "Acme Ltd",
    });
    const listed = await tool("lookup", { op: "data.outbound.list" });
    expect(listed.isError).toBeFalsy();
  });

  it("refuses what is not a lookup: a write, and an operation the config does not have", async () => {
    for (const op of ["acme.customer.rename", "acme.customer.nothing"]) {
      const refused = await tool("lookup", { op, input: { id: "c1", name: "B" } });
      expect(refused.isError, op).toBe(true);
      expect(refused.structuredContent, op).toMatchObject({
        code: "invalid_input",
        status: 400,
        error: expect.stringMatching(/is not a lookup/),
      });
    }
  });

  it("answers a held lookup with its run, which get_run reads and wait_run says is still running", async () => {
    const held = await tool("lookup", { op: "acme.customer.get", input: { id: "held" } });
    expect(held.isError).toBe(true);
    expect(held.structuredContent).toMatchObject({ code: "approval_pending", status: 409, runId: expect.any(String) });
    const { runId } = held.structuredContent;
    expect((await tool("get_run", { runId })).structuredContent).toMatchObject({
      runId,
      workflow: "call",
      startedBy: { id: "ada" },
    });
    const waited = await tool("wait_run", { runId, waitMs: 0 });
    expect(waited.isError).toBeFalsy();
    expect(waited.structuredContent).toEqual({ runId, status: "running" });
  });

  it("files one approval for a held lookup retried with its id", async () => {
    const id = crypto.randomUUID();
    const asked = () => tool("lookup", { op: "acme.customer.get", input: { id: "held" }, id });
    const [first, again] = [await asked(), await asked()];
    expect(first.structuredContent).toMatchObject({ code: "approval_pending", runId: `call:ada:${id}` });
    expect(again.structuredContent).toMatchObject({ code: "approval_pending", runId: `call:ada:${id}` });
  });
});

describe("start_run, get_run and wait_run", () => {
  it("starts a workflow by its name or api name, and reads its run and its output", async () => {
    for (const workflow of ["greet-customer", "greetCustomer"]) {
      const started = await tool("start_run", { workflow, input: { id: "c2" } });
      expect(started.isError, workflow).toBeFalsy();
      const { runId } = started.structuredContent;
      expect(runId).toEqual(expect.any(String));
      expect(await tool("wait_run", { runId })).toMatchObject({
        structuredContent: { runId, status: "finished", output: "Acme Ltd" },
      });
      expect((await tool("get_run", { runId })).structuredContent).toMatchObject({
        runId,
        workflow: "greet-customer",
        status: "finished",
        startedBy: { id: "ada" },
      });
    }
  });

  it("starts an app's workflow by its name with its app, or its api name", async () => {
    for (const workflow of ["crm.follow-up", "crmFollowUp"]) {
      const { runId } = (await tool("start_run", { workflow, input: { email: "nobody@acme.test" } })).structuredContent;
      expect(await tool("wait_run", { runId }), workflow).toMatchObject({
        structuredContent: { status: "finished", output: { followedUp: false } },
      });
    }
  });

  it("makes one run of a start retried with its id, and refuses that id for another input", async () => {
    const id = crypto.randomUUID();
    const start = (input: object) => tool("start_run", { workflow: "greet-customer", input, id });
    expect((await start({ id: "c3" })).structuredContent).toEqual({ runId: id });
    expect((await start({ id: "c3" })).structuredContent).toEqual({ runId: id });
    expect((await start({ id: "c4" })).structuredContent).toMatchObject({ code: "invalid_input" });
  });

  it("refuses the runtime's own workflows, however written, a workflow the config does not have and a bad input", async () => {
    for (const workflow of ["apply", "drift", "call", "go-live", "goLive", "login-code", "loginCode"]) {
      expect((await tool("start_run", { workflow })).structuredContent, workflow).toMatchObject({
        code: "invalid_input",
        error: expect.stringMatching(/runtime's own workflows are not started here.*drift tool/),
      });
    }
    for (const workflow of ["nothing", "Call", " drift", "drift.start", "greetCustomer.start"]) {
      expect((await tool("start_run", { workflow })).structuredContent, workflow).toMatchObject({
        code: "invalid_input",
        error: expect.stringMatching(/^No workflow .* to start/),
      });
    }
    expect((await tool("start_run", { workflow: "greet-customer", input: {} })).structuredContent).toMatchObject({
      code: "invalid_input",
    });
  });

  it("answers a run nobody started run_not_found", async () => {
    for (const name of ["get_run", "wait_run"]) {
      const missing = await tool(name, { runId: "no-such-run" });
      expect(missing.isError, name).toBe(true);
      expect(missing.structuredContent, name).toMatchObject({ code: "run_not_found", status: 404 });
    }
  });
});

describe("drift", () => {
  it("starts the built-in drift as the person asking, and answers its report once it ends", async () => {
    const started = await tool("drift", { waitMs: 0 });
    expect(started.isError).toBeFalsy();
    const { runId } = started.structuredContent;
    expect(started.structuredContent).toMatchObject({ runId: expect.any(String), status: expect.any(String) });
    const done = await waitFor(
      async () => (await tool("wait_run", { runId })).structuredContent,
      (answer: any) => answer.status === "finished",
    );
    expect(done.output).toMatchObject({ resources: [expect.objectContaining({ vendor: "hooks", type: "hook" })] });
    expect((await tool("get_run", { runId })).structuredContent).toMatchObject({
      workflow: "drift",
      startedBy: { id: "ada" },
    });
  });

  it("makes one drift run when retried with its id", async () => {
    const id = crypto.randomUUID();
    expect((await tool("drift", { waitMs: 0, id })).structuredContent).toMatchObject({ runId: id });
    expect((await tool("drift", { waitMs: 0, id })).structuredContent).toMatchObject({ runId: id });
  });

  it("says plainly that a company declaring no resources has nothing to check", async () => {
    const app = appContext();
    const workflows = snapshot.description.workflows.filter((wf) => wf.name !== "drift");
    const bare: AppContext = { ...app, snapshot: { ...snapshot, description: { ...snapshot.description, workflows } } };
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drift", arguments: {} } }),
    });
    const res = await postMcp(request, { app: bare, actor: async () => ({ id: "ada" }) });
    expect((await messageOf(res)).result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_input", error: expect.stringMatching(/declares no resources/) },
    });
  });
});

describe("the guards", () => {
  it("answers 404 on a public site's host", async () => {
    expect((await mcp("tools/list", {}, { site: "www" })).status).toBe(404);
  });

  it("refuses a request that names nobody 400, and a visitor 403", async () => {
    expect(await mcp("tools/list", {}, { actor: null })).toMatchObject({
      status: 400,
      body: { code: "invalid_input" },
    });
    for (const as of [visitorPrincipal("auth0", "u1"), { id: "token:t1", groups: [] }]) {
      expect(await mcp("tools/list", {}, { as }), as.id).toMatchObject({
        status: 403,
        body: { code: "policy_denied" },
      });
    }
  });

  it("refuses another site's Origin, and takes the app's own", async () => {
    for (const origin of ["https://attacker.example", "null"]) {
      expect(await mcp("tools/list", {}, { headers: { origin } }), origin).toMatchObject({
        status: 403,
        body: { code: "policy_denied" },
      });
    }
    expect((await mcp("tools/list", {}, { headers: { origin: "http://127.0.0.1" } })).status).toBe(200);
  });
});

describe("POST /mcp through the app", () => {
  let app: App | undefined;
  beforeAll(async () => {
    app = await startApp(testApp.config, { port: 0 });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  const post = (headers: Record<string, string>) =>
    fetch(new URL("/mcp", app!.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("serves an MCP client, which sends no Origin and no CSRF token, as the person it names", async () => {
    const res = await post({ [ACTOR_HEADER]: "ada" });
    expect(res.status).toBe(200);
    expect((await messageOf(res)).result.tools.map((t: { name: string }) => t.name).toSorted()).toEqual(TOOLS);
  });

  it("refuses a browser's request from another site or origin, by Sec-Fetch-Site or by Origin", async () => {
    for (const site of ["cross-site", "same-site"]) {
      expect((await post({ [ACTOR_HEADER]: "ada", "sec-fetch-site": site })).status, site).toBe(403);
    }
    for (const origin of ["https://attacker.example", "null"]) {
      expect((await post({ [ACTOR_HEADER]: "ada", origin })).status, origin).toBe(403);
    }
  });
});
