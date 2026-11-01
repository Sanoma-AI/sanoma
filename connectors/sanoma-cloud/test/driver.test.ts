import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudDriver } from "../src/driver.ts";

// The driver against a stand-in for sanoma-ops's public api (`POST /api/call`) in this process:
// the requests it sends (a start with an id per call, then results until the run ends, the token
// as a bearer), how it maps the workflows' answers to the resource operations, and its errors.

const TOKEN = "sca_test-token";

/** A workflow's run in the stand-in: its output, or the api's refusal of its result. */
type Answer = { output: unknown } | { status: number; body: unknown };

interface Sent {
  name: string;
  input?: unknown;
  id?: string;
  headers: IncomingHttpHeaders;
}

/** Answers `body` as JSON with `status`. */
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

let server: Server;
let url: string;
let sent: Sent[] = [];
/** How each workflow (by api name) answers a run of it, given its input. */
let workflows: Record<string, (input: any) => Answer> = {};
/** How many `run_running` answers a run's result gets before its own. */
let running = 1;

beforeAll(async () => {
  const runs = new Map<string, { answer: Answer; waits: number }>();
  let n = 0;
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk));
    req.on("end", () => {
      if (req.url !== "/api/call" || req.method !== "POST") return json(res, 404, { error: "Not found" });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "Unauthorized" });
      const body = JSON.parse(text) as Omit<Sent, "headers">;
      sent.push({ ...body, headers: req.headers });
      const [api, method] = body.name.split(".");
      if (method === "start") {
        const runId = body.id ?? `run-${++n}`;
        if (!runs.has(runId)) runs.set(runId, { answer: workflows[api!]!(body.input), waits: running });
        return json(res, 200, { runId });
      }
      const run = runs.get((body.input as { runId: string }).runId)!;
      if (run.waits-- > 0) return json(res, 409, { error: "Run is still running", code: "run_running" });
      return "output" in run.answer ? json(res, 200, run.answer.output) : json(res, run.answer.status, run.answer.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

beforeEach(() => {
  vi.stubEnv("SANOMA_CLOUD_TOKEN", TOKEN);
  vi.stubEnv("SANOMA_CLOUD_URL", url);
  sent = [];
  running = 1;
  workflows = {};
});

afterEach(() => vi.unstubAllEnvs());

let n = 0;
const call = (opId: string, idempotencyKey = `${opId}:${++n}`): CallContext => ({
  idempotencyKey,
  runId: "driver",
  opId,
  attempt: 1,
  secrets: memorySecrets(),
});
const driver = cloudDriver({ timeoutMs: 5_000 });
const op = (name: string, input: object, key?: string) =>
  driver.ops[name]!(input, call(`cloud.${name}`, key)) as Promise<any>;

/** A company as `cloud-list` answers it, with a host at `revision` and a database. */
const acme = (revision = "abc123") => ({
  slug: "acme",
  name: "acme",
  url: "https://acme.sanoma.work",
  status: "running",
  revision,
  database: { id: "proj-1", region: "us-east" },
  repository: { owner: "acme", name: "acme-ops", ref: "main" },
});

const declaredHost = {
  source: "https://github.com/acme/acme-ops.git",
  ref: "main",
  revision: "abc123",
  domains: { app: "acme.sanoma.work" },
};

describe("cloud's host through the workflows", () => {
  it("creates one with cloud-signup, its slug from domains.app, waiting out run_running, then reads it from cloud-list", async () => {
    let made = false;
    workflows = {
      cloudSignup: () => ((made = true), { output: { slug: "acme", url: "https://acme.sanoma.work" } }),
      cloudList: () => ({ output: made ? [acme()] : [] }),
    };
    const done = await op("host.create", { desired: declaredHost });
    expect(done).toEqual({
      id: "acme",
      state: {
        name: "acme",
        source: "https://github.com/acme/acme-ops.git",
        ref: "main",
        revision: "abc123",
        port: 3000,
        domains: { app: "acme.sanoma.work" },
        url: "https://acme.sanoma.work",
        healthy: true,
      },
    });
    expect(sent.map((s) => s.name)).toEqual([
      "cloudSignup.start",
      "cloudSignup.result",
      "cloudSignup.result",
      "cloudList.start",
      "cloudList.result",
      "cloudList.result",
    ]);
    expect(sent[0]).toMatchObject({
      input: {
        slug: "acme",
        name: "acme",
        part: "host",
        repository: { owner: "acme", name: "acme-ops" },
        ref: "main",
        revision: "abc123",
        domains: { app: "acme.sanoma.work" },
      },
      id: expect.stringMatching(/^sanoma-cloud-[0-9a-f]{32}$/),
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
    // A read starts a run of its own each time: no id.
    expect(sent[3]).toMatchObject({ input: { slug: "acme" } });
    expect(sent[3]!.id).toBeUndefined();
  });

  it("starts the same run for each attempt of one call, so a retry resumes it", async () => {
    workflows = { cloudSignup: () => ({ output: { slug: "acme" } }), cloudList: () => ({ output: [acme()] }) };
    await op("host.create", { desired: declaredHost }, "same-key");
    await op("host.create", { desired: declaredHost }, "same-key");
    const ids = sent.filter((s) => s.name === "cloudSignup.start").map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("deploys apply's revision after a signup whose host runs another", async () => {
    let revision = "old";
    workflows = {
      cloudSignup: () => ({ output: { slug: "acme" } }),
      cloudList: () => ({ output: [acme(revision)] }),
      cloudDeploy: (input: { revision: string }) => ((revision = input.revision), { output: { revision } }),
    };
    const done = await op("host.create", { desired: declaredHost });
    expect(done.state.revision).toBe("abc123");
    expect(sent.find((s) => s.name === "cloudDeploy.start")?.input).toEqual({ slug: "acme", revision: "abc123" });
  });

  it("reads one cloud-list does not hold as gone, and a company without a host the same", async () => {
    workflows = { cloudList: () => ({ output: [] }) };
    expect(await op("host.read", { id: "acme" })).toEqual({ id: "acme", gone: true });
    workflows = { cloudList: () => ({ output: [{ ...acme(), revision: undefined }] }) };
    expect(await op("host.import", { id: "acme" })).toEqual({ id: "acme", gone: true });
  });

  it("plans a new revision as an update that cloud-deploy makes, and nothing else as none", async () => {
    let revision = "abc123";
    workflows = {
      cloudList: () => ({ output: [acme(revision)] }),
      cloudDeploy: (input: { revision: string }) => ((revision = input.revision), { output: { revision } }),
    };
    expect(await op("host.plan", { id: "acme", desired: declaredHost })).toMatchObject({ action: "none", replace: [] });
    const next = { ...declaredHost, revision: "def456" };
    expect(await op("host.plan", { id: "acme", desired: next })).toMatchObject({
      action: "update",
      replace: [],
      planned: { revision: "def456" },
    });
    const done = await op("host.update", { id: "acme", desired: next, expect: { action: "update", replace: [] } });
    expect(done).toMatchObject({ id: "acme", state: { revision: "def456" } });
    expect(sent.filter((s) => s.name === "cloudDeploy.start").map((s) => s.input)).toEqual([
      { slug: "acme", revision: "def456" },
    ]);
  });

  it("plans another ref or repository as a replace, which update refuses: a deploy moves only the revision", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    const moved = { ...declaredHost, ref: "release", source: "https://github.com/acme/other.git" };
    expect(await op("host.plan", { id: "acme", desired: moved })).toMatchObject({
      action: "replace",
      replace: ["source", "ref"],
    });
    await expect(op("host.update", { id: "acme", desired: moved })).rejects.toMatchObject({
      vendorCode: "immutable",
      retryable: false,
    });
  });

  it("closes the host with cloud-close, and is done already when it is gone", async () => {
    let held = [acme()];
    workflows = {
      cloudList: () => ({ output: held }),
      cloudClose: () => ((held = []), { output: {} }),
    };
    expect(await op("host.delete", { id: "acme" })).toEqual({ id: "acme", gone: true });
    expect(await op("host.delete", { id: "acme" })).toEqual({ id: "acme", gone: true });
    expect(sent.filter((s) => s.name === "cloudClose.start").map((s) => s.input)).toEqual([
      { slug: "acme", part: "host" },
    ]);
  });
});

describe("cloud's database through the workflows", () => {
  it("takes the one company the token holds when it has no name, binding a database the wizard made", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    expect(await op("database.create", { desired: { region: "us-east" } })).toEqual({
      id: "acme",
      state: { name: "acme", region: "us-east", id: "proj-1", healthy: true },
    });
    expect(sent.filter((s) => s.name.endsWith(".start")).map((s) => [s.name, s.input])).toEqual([
      ["cloudList.start", {}],
      ["cloudList.start", { slug: "acme" }],
    ]);
  });

  it("makes one with cloud-signup for its name", async () => {
    let made = false;
    workflows = {
      cloudList: () => ({
        output: made ? [{ slug: "acme", status: "creating", database: { id: "proj-2", region: "eu-central" } }] : [],
      }),
      cloudSignup: () => ((made = true), { output: { slug: "acme", database: { id: "proj-2" } } }),
    };
    const done = await op("database.create", { desired: { name: "acme", region: "eu-central" } });
    expect(done).toEqual({ id: "acme", state: { name: "acme", region: "eu-central", id: "proj-2", healthy: true } });
    expect(sent.find((s) => s.name === "cloudSignup.start")?.input).toEqual({
      slug: "acme",
      name: "acme",
      part: "database",
      region: "eu-central",
    });
  });

  it("refuses to plan one with no name while the token holds no company, or several", async () => {
    workflows = { cloudList: () => ({ output: [] }) };
    await expect(op("database.plan", { desired: { region: "us-east" } })).rejects.toMatchObject({
      vendorCode: "no_slug",
      message: expect.stringContaining("declare `name`"),
    });
    workflows = { cloudList: () => ({ output: [acme(), { ...acme(), slug: "beta" }] }) };
    await expect(op("database.create", { desired: {} })).rejects.toMatchObject({ vendorCode: "no_slug" });
  });

  it("plans another region as a replace, which update refuses: the data would stay behind", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    expect(await op("database.plan", { id: "acme", desired: { region: "us-east" } })).toMatchObject({ action: "none" });
    const moved = { region: "eu-central" };
    expect(await op("database.plan", { id: "acme", desired: moved })).toMatchObject({
      action: "replace",
      replace: ["region"],
    });
    await expect(op("database.update", { id: "acme", desired: moved })).rejects.toMatchObject({
      vendorCode: "immutable",
    });
  });

  it("closes the database with cloud-close, and stores no URL: the host binds it", async () => {
    let held = [acme()];
    workflows = {
      cloudList: () => ({ output: held }),
      cloudClose: () => ((held = []), { output: {} }),
    };
    expect(await op("database.delete", { id: "acme" })).toEqual({ id: "acme", gone: true });
    expect(sent.find((s) => s.name === "cloudClose.start")?.input).toEqual({ slug: "acme", part: "database" });
    expect(await op("database.storeUrl", { id: "acme", export: "store" })).toEqual({
      stored: false,
      reason: expect.stringContaining("binds the database's URL to the company's host"),
    });
  });
});

describe("cloud's driver errors", () => {
  it("fails a call with the run's failure, final for a workflow's refusal", async () => {
    workflows = {
      cloudList: () => ({ output: [] }),
      cloudSignup: () => ({
        status: 400,
        body: { error: "acme.sanoma.work is taken: pick another address", code: "invalid_input" },
      }),
    };
    await expect(op("host.create", { desired: declaredHost })).rejects.toMatchObject({
      message: "Sanoma Cloud: cloud-signup: acme.sanoma.work is taken: pick another address",
      retryable: false,
      status: 400,
      vendorCode: "invalid_input",
    });
  });

  it("retries a 5xx, and no reply", async () => {
    workflows = { cloudList: () => ({ status: 500, body: { error: "Something went wrong" } }) };
    await expect(op("host.read", { id: "acme" })).rejects.toMatchObject({ retryable: true, status: 500 });
    vi.stubEnv("SANOMA_CLOUD_URL", "http://127.0.0.1:1");
    await expect(op("host.read", { id: "acme" })).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("the request failed"),
    });
  });

  it("says a refused token is unknown or revoked, never its value, and refuses a call without one", async () => {
    vi.stubEnv("SANOMA_CLOUD_TOKEN", "sca_revoked");
    const refused = op("host.read", { id: "acme" });
    await expect(refused).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(refused).rejects.toThrow("SANOMA_CLOUD_TOKEN was refused: it is unknown or revoked");
    await expect(refused).rejects.not.toThrow("sca_revoked");
    vi.stubEnv("SANOMA_CLOUD_TOKEN", "");
    await expect(op("host.read", { id: "acme" })).rejects.toThrow("SANOMA_CLOUD_TOKEN is not set");
    expect(sent.filter((s) => s.headers.authorization !== `Bearer ${TOKEN}`)).toEqual([]);
  });

  it("gives up on a run that has not ended in its time, retryable", async () => {
    running = 1000;
    workflows = { cloudList: () => ({ output: [] }) };
    const quick = cloudDriver({ timeoutMs: 5_000, runTimeoutMs: 50 });
    await expect(quick.ops["host.read"]!({ id: "acme" }, call("cloud.host.read"))).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("has not ended in 50 ms"),
    });
  });
});
