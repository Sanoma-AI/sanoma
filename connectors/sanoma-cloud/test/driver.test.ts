import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type CallContext, memorySecrets, VENDOR } from "sanoma/workflows";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { host as hostType } from "../src/connector.ts";
import { cloudDriver, workflowsApi } from "../src/driver.ts";
import { cloud } from "../src/index.ts";

// The driver against a stand-in for sanoma-ops's public api (`POST /api/call`) in this process:
// the requests it sends (a start with an id per call, then results until the run ends, the token
// as a bearer, read from the call's secrets), how it maps the workflows' answers to the resource
// operations, and its errors.

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
/** The company's secrets, which each call reads its token from. */
let stored: Record<string, string> = {};

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
  vi.stubEnv("SANOMA_CLOUD_URL", url);
  stored = { SANOMA_CLOUD_TOKEN: TOKEN };
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
  secrets: memorySecrets(stored),
});
const driver = cloudDriver({ timeoutMs: 5_000 });
const op = (name: string, input: object, key?: string) =>
  driver.ops[name]!(input, call(`cloud.${name}`, key)) as Promise<any>;

/** A company `c1` as `cloud-list` answers it, at `slug` (`acme`), its trial on, with `parts`. */
const row = ({ slug = "acme", ...parts }: Record<string, unknown> = {}) => ({
  id: "c1",
  slug,
  name: "Acme",
  url: `https://${slug}.sanoma.work`,
  status: "creating",
  createdAt: "2026-11-01T00:00:00.000Z",
  trialEndsAt: "2026-11-15T00:00:00.000Z",
  ...parts,
});

/** The token's company as `cloud-list` answers it, with a host at `revision` and a database. */
const acme = (revision = "abc123") =>
  row({
    status: "running",
    revision,
    database: { id: "proj-1", healthy: true, region: "us-east" },
    repository: { owner: "acme", name: "acme-ops", ref: "main" },
  });

/** The token's company before its host is made: its database, its repository, no revision. */
const hostless = () => ({ ...acme(), status: "creating", revision: undefined });

const declaredHost = {
  hostname: "acme.sanoma.work",
  database: "c1",
  source: "https://github.com/acme/acme-ops.git",
  ref: "main",
  revision: "abc123",
};

/** Each start's workflow and input, in order. */
const starts = () => sent.filter((s) => s.name.endsWith(".start")).map((s) => [s.name, s.input]);

describe("cloud's host through the workflows", () => {
  it("reads when the company's free trial ends with its host, only while the Cloud runs it, and passes it on in its outputs", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    const { state } = await op("host.read", { id: "c1" });
    expect(state.trialEndsAt).toBe("2026-11-15T00:00:00.000Z");
    expect(hostType.host!.outputs(state)).toMatchObject({ trialEndsAt: "2026-11-15T00:00:00.000Z" });
    for (const status of ["creating", "failed", "moved"]) {
      workflows = { cloudList: () => ({ output: [{ ...acme(), status }] }) };
      const read = await op("host.read", { id: "c1" });
      expect(read.state, status).not.toHaveProperty("trialEndsAt");
      expect(hostType.host!.outputs(read.state), status).not.toHaveProperty("trialEndsAt");
    }
  });

  it("creates the token's company's with cloud-signup by its id, waiting out run_running, then reads it by id", async () => {
    let made = false;
    workflows = {
      cloudSignup: () => ((made = true), { output: { id: "c1", slug: "acme", url: "https://acme.sanoma.work" } }),
      cloudList: () => ({ output: [made ? acme() : hostless()] }),
    };
    const done = await op("host.create", { desired: declaredHost });
    expect(done).toEqual({
      id: "c1",
      state: {
        id: "c1",
        hostname: "acme.sanoma.work",
        database: "c1",
        source: "https://github.com/acme/acme-ops.git",
        ref: "main",
        revision: "abc123",
        port: 3000,
        url: "https://acme.sanoma.work",
        healthy: true,
        trialEndsAt: "2026-11-15T00:00:00.000Z",
      },
    });
    expect(sent.map((s) => s.name)).toEqual([
      "cloudList.start",
      "cloudList.result",
      "cloudList.result",
      "cloudSignup.start",
      "cloudSignup.result",
      "cloudSignup.result",
      "cloudList.start",
      "cloudList.result",
      "cloudList.result",
    ]);
    // The token's company first, with no id: one token, one company.
    expect(sent[0]).toMatchObject({ input: {} });
    expect(sent[3]).toMatchObject({
      input: {
        id: "c1",
        part: "host",
        repository: { owner: "acme", name: "acme-ops" },
        ref: "main",
        revision: "abc123",
      },
      id: expect.stringMatching(/^sanoma-cloud-[0-9a-f]{32}$/),
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
    // A read starts a run of its own each time: no id.
    expect(sent[6]).toMatchObject({ input: { id: "c1" } });
    expect(sent[6]!.id).toBeUndefined();
  });

  it("starts the same run for each attempt of one call, so a retry resumes it", async () => {
    workflows = { cloudSignup: () => ({ output: {} }), cloudList: () => ({ output: [hostless()] }) };
    await expect(op("host.create", { desired: declaredHost }, "same-key")).rejects.toMatchObject({
      vendorCode: "not_made",
    });
    await expect(op("host.create", { desired: declaredHost }, "same-key")).rejects.toMatchObject({
      vendorCode: "not_made",
    });
    const ids = sent.filter((s) => s.name === "cloudSignup.start").map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("binds a host the wizard made rather than make it again, at apply's revision", async () => {
    let revision = "old";
    workflows = {
      cloudList: () => ({ output: [acme(revision)] }),
      cloudDeploy: (input: { revision: string }) => ((revision = input.revision), { output: { revision } }),
    };
    const done = await op("host.create", { desired: declaredHost });
    expect(done).toMatchObject({ id: "c1", state: { revision: "abc123" } });
    expect(starts().filter(([name]) => name !== "cloudList.start")).toEqual([
      ["cloudDeploy.start", { id: "c1", slug: "acme", revision: "abc123" }],
    ]);
  });

  it("refuses to bind a host the wizard made from another repository or branch: a deploy would move it there", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    for (const declared of [
      { ...declaredHost, source: "https://github.com/acme/other.git" },
      { ...declaredHost, ref: "release" },
    ]) {
      await expect(op("host.create", { desired: declared })).rejects.toMatchObject({
        vendorCode: "immutable",
        retryable: false,
      });
    }
    expect(starts().filter(([name]) => name !== "cloudList.start")).toEqual([]);
  });

  it("moves a host made at the company's own address to the declared one, a rename", async () => {
    let slug = "acme";
    workflows = {
      cloudList: () => ({ output: [{ ...acme(), slug, url: `https://${slug}.sanoma.work` }] }),
      cloudDeploy: (input: { slug: string }) => ((slug = input.slug), { output: {} }),
    };
    const done = await op("host.create", { desired: { ...declaredHost, hostname: "acme-co.sanoma.work" } });
    expect(done).toMatchObject({
      id: "c1",
      state: { id: "c1", hostname: "acme-co.sanoma.work", url: "https://acme-co.sanoma.work" },
    });
    expect(sent.find((s) => s.name === "cloudDeploy.start")?.input).toEqual({
      id: "c1",
      slug: "acme-co",
      revision: "abc123",
    });
  });

  it("reads one cloud-list does not hold as gone, and a company without a host the same", async () => {
    workflows = { cloudList: () => ({ output: [] }) };
    expect(await op("host.read", { id: "c1" })).toEqual({ id: "c1", gone: true });
    workflows = { cloudList: () => ({ output: [hostless()] }) };
    expect(await op("host.import", { id: "c1" })).toEqual({ id: "c1", gone: true });
  });

  it("plans a new revision as an update that cloud-deploy makes, and nothing else as none", async () => {
    let revision = "abc123";
    workflows = {
      cloudList: () => ({ output: [acme(revision)] }),
      cloudDeploy: (input: { revision: string }) => ((revision = input.revision), { output: { revision } }),
    };
    expect(await op("host.plan", { id: "c1", desired: declaredHost })).toMatchObject({ action: "none", replace: [] });
    const next = { ...declaredHost, revision: "def456" };
    expect(await op("host.plan", { id: "c1", desired: next })).toMatchObject({
      action: "update",
      replace: [],
      planned: { revision: "def456" },
    });
    const done = await op("host.update", { id: "c1", desired: next, expect: { action: "update", replace: [] } });
    expect(done).toMatchObject({ id: "c1", state: { revision: "def456" } });
    expect(sent.filter((s) => s.name === "cloudDeploy.start").map((s) => s.input)).toEqual([
      { id: "c1", slug: "acme", revision: "def456" },
    ]);
  });

  it("plans another hostname as an update, a rename that cloud-deploy makes in place", async () => {
    let slug = "acme";
    workflows = {
      cloudList: () => ({ output: [{ ...acme(), slug, url: `https://${slug}.sanoma.work` }] }),
      cloudDeploy: (input: { slug: string }) => ((slug = input.slug), { output: {} }),
    };
    const renamed = { ...declaredHost, hostname: "acme-co.sanoma.work" };
    const plan = { action: "update", replace: [] };
    expect(await op("host.plan", { id: "c1", desired: renamed })).toMatchObject({
      ...plan,
      planned: { id: "c1", hostname: "acme-co.sanoma.work", revision: "abc123" },
    });
    expect(await op("host.update", { id: "c1", desired: renamed, expect: plan })).toEqual({
      id: "c1",
      state: expect.objectContaining({ id: "c1", hostname: "acme-co.sanoma.work", url: "https://acme-co.sanoma.work" }),
    });
    expect(sent.filter((s) => s.name === "cloudDeploy.start").map((s) => s.input)).toEqual([
      { id: "c1", slug: "acme-co", revision: "abc123" },
    ]);
    expect(await op("host.plan", { id: "c1", desired: renamed })).toMatchObject({ action: "none" });
    // A retry of the update, once the rename went through: done, with no deploy again.
    expect(await op("host.update", { id: "c1", desired: renamed, expect: plan })).toMatchObject({
      id: "c1",
      state: { hostname: "acme-co.sanoma.work" },
    });
    expect(sent.filter((s) => s.name === "cloudDeploy.start")).toHaveLength(1);
  });

  it("plans another ref or repository as a replace, which update refuses: a deploy moves only the revision and address", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    const moved = { ...declaredHost, ref: "release", source: "https://github.com/acme/other.git" };
    expect(await op("host.plan", { id: "c1", desired: moved })).toMatchObject({
      action: "replace",
      replace: ["source", "ref"],
    });
    await expect(op("host.update", { id: "c1", desired: moved })).rejects.toMatchObject({
      vendorCode: "immutable",
      retryable: false,
    });
  });

  it("refuses to plan or make one while the token is for no company, naming its id when it is", async () => {
    workflows = { cloudList: () => ({ output: [] }) };
    await expect(op("host.plan", { desired: declaredHost })).rejects.toMatchObject({
      vendorCode: "no_company",
      retryable: false,
      message: expect.stringContaining("the Cloud token is for no company yet"),
    });
    await expect(op("host.create", { desired: declaredHost })).rejects.toMatchObject({ vendorCode: "no_company" });
    expect(starts()).toEqual([
      ["cloudList.start", {}],
      ["cloudList.start", {}],
    ]);
    workflows = { cloudList: () => ({ output: [hostless()] }) };
    expect(await op("host.plan", { desired: declaredHost })).toMatchObject({
      action: "create",
      planned: { id: "c1", hostname: "acme.sanoma.work" },
      unknown: ["url", "healthy", "trialEndsAt"],
    });
  });

  it("fails a create whose host cloud-list does not show, rather than bind one the next plan makes again", async () => {
    workflows = { cloudSignup: () => ({ output: {} }), cloudList: () => ({ output: [hostless()] }) };
    await expect(op("host.create", { desired: declaredHost })).rejects.toMatchObject({ vendorCode: "not_made" });
  });

  it("closes the host with cloud-close by its id, and is done already when it is gone", async () => {
    let held = [acme()];
    workflows = {
      cloudList: () => ({ output: held }),
      cloudClose: () => ((held = []), { output: {} }),
    };
    expect(await op("host.delete", { id: "c1" })).toEqual({ id: "c1", gone: true });
    expect(await op("host.delete", { id: "c1" })).toEqual({ id: "c1", gone: true });
    expect(sent.filter((s) => s.name === "cloudClose.start").map((s) => s.input)).toEqual([{ id: "c1", part: "host" }]);
  });
});

describe("cloud's database through the workflows", () => {
  it("binds the database the wizard made with the token's company", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    expect(await op("database.create", { desired: { region: "us-east" } })).toEqual({
      id: "c1",
      state: { id: "c1", region: "us-east", healthy: true },
    });
    // One list: the company it takes holds the database already.
    expect(starts()).toEqual([["cloudList.start", {}]]);
    // Not one in another region than the declared: it cannot move.
    await expect(op("database.create", { desired: { region: "eu-central" } })).rejects.toMatchObject({
      vendorCode: "immutable",
      message: expect.stringContaining("region"),
    });
    expect(starts().filter(([name]) => name !== "cloudList.start")).toEqual([]);
  });

  it("makes one for the token's company with cloud-signup by its id", async () => {
    let made = false;
    workflows = {
      cloudList: () => ({
        output: [row(made ? { database: { id: "proj-2", healthy: true, region: "eu-central" } } : {})],
      }),
      cloudSignup: () => ((made = true), { output: { id: "c1", slug: "acme", database: { id: "proj-2" } } }),
    };
    const done = await op("database.create", { desired: { region: "eu-central" } });
    expect(done).toEqual({ id: "c1", state: { id: "c1", region: "eu-central", healthy: true } });
    expect(sent.find((s) => s.name === "cloudSignup.start")?.input).toEqual({
      id: "c1",
      part: "database",
      region: "eu-central",
    });
  });

  it("refuses to plan one while the token is for no company, and plans the company's id otherwise", async () => {
    workflows = { cloudList: () => ({ output: [] }) };
    await expect(op("database.plan", { desired: { region: "us-east" } })).rejects.toMatchObject({
      vendorCode: "no_company",
    });
    workflows = { cloudList: () => ({ output: [row()] }) };
    expect(await op("database.plan", { desired: { region: "us-east" } })).toMatchObject({
      action: "create",
      planned: { id: "c1", region: "us-east" },
      unknown: ["healthy"],
    });
  });

  it("plans another region as a replace, which update refuses: the data would stay behind", async () => {
    workflows = { cloudList: () => ({ output: [acme()] }) };
    expect(await op("database.plan", { id: "c1", desired: { region: "us-east" } })).toMatchObject({ action: "none" });
    const moved = { region: "eu-central" };
    expect(await op("database.plan", { id: "c1", desired: moved })).toMatchObject({
      action: "replace",
      replace: ["region"],
    });
    await expect(op("database.update", { id: "c1", desired: moved })).rejects.toMatchObject({
      vendorCode: "immutable",
    });
  });

  it("closes the database with cloud-close by its id, and stores no URL: the host binds it", async () => {
    let held = [acme()];
    workflows = {
      cloudList: () => ({ output: held }),
      cloudClose: () => ((held = []), { output: {} }),
    };
    expect(await op("database.delete", { id: "c1" })).toEqual({ id: "c1", gone: true });
    expect(sent.find((s) => s.name === "cloudClose.start")?.input).toEqual({ id: "c1", part: "database" });
    expect(await op("database.storeUrl", { id: "c1", export: "store" })).toEqual({
      stored: false,
      reason: expect.stringContaining("binds the database's URL to the company's host"),
    });
  });
});

describe("cloud's account operations through the workflows", () => {
  it("says whether an address is free with cloud-available, and refuses an answer that is not one", async () => {
    workflows = { cloudAvailable: ({ slug }) => ({ output: { available: slug === "acme", yours: false } }) };
    expect(await op("company.available", { slug: "acme" })).toEqual({ available: true, yours: false });
    expect(sent.find((s) => s.name === "cloudAvailable.start")?.input).toEqual({ slug: "acme" });
    workflows = { cloudAvailable: () => ({ output: { free: true } }) };
    await expect(op("company.available", { slug: "acme" })).rejects.toThrow(
      "Sanoma Cloud: cloud-available: its answer is not what it should be",
    );
  });

  it("makes a new company's repository at its address, once, while the token is for none", async () => {
    let made = false;
    workflows = {
      cloudList: () => ({
        output: made ? [row({ repository: { owner: "sanoma-work", name: "acme", ref: "main" } })] : [],
      }),
      cloudSignup: () => ((made = true), { output: {} }),
    };
    expect(await op("company.repository", { slug: "acme" })).toEqual({ owner: "sanoma-work", name: "acme" });
    expect(starts()).toEqual([
      ["cloudList.start", {}],
      ["cloudSignup.start", { slug: "acme", name: "acme", part: "repository" }],
      ["cloudList.start", {}],
    ]);
    // Again: the one there, with no sign-up.
    sent = [];
    expect(await op("company.repository", { slug: "acme" })).toEqual({ owner: "sanoma-work", name: "acme" });
    expect(sent.some((s) => s.name === "cloudSignup.start")).toBe(false);
  });

  it("makes the token's company's repository by its id, whatever address it is given", async () => {
    let made = false;
    workflows = {
      cloudList: () => ({
        output: [row(made ? { repository: { owner: "sanoma-work", name: "acme", ref: "main" } } : {})],
      }),
      cloudSignup: () => ((made = true), { output: {} }),
    };
    expect(await op("company.repository", { slug: "acme-co" })).toEqual({ owner: "sanoma-work", name: "acme" });
    expect(sent.find((s) => s.name === "cloudSignup.start")?.input).toEqual({ id: "c1", part: "repository" });
  });

  it("refuses a repository cloud-list does not show after the sign-up", async () => {
    workflows = { cloudList: () => ({ output: [] }), cloudSignup: () => ({ output: {} }) };
    await expect(op("company.repository", { slug: "acme" })).rejects.toMatchObject({ vendorCode: "not_made" });
  });

  it("answers cloud-invite's link for the token's company, and refuses one that is no web address", async () => {
    workflows = {
      cloudList: () => ({ output: [acme()] }),
      cloudInvite: () => ({ output: { url: "https://acme.sanoma.work/auth/invite/abc" } }),
    };
    expect(await op("company.invite", { email: "a@acme.test" })).toEqual({
      url: "https://acme.sanoma.work/auth/invite/abc",
    });
    expect(sent.find((s) => s.name === "cloudInvite.start")?.input).toEqual({ id: "c1", email: "a@acme.test" });
    workflows = { ...workflows, cloudInvite: () => ({ output: { url: "javascript:alert(1)" } }) };
    await expect(op("company.invite", { email: "a@acme.test" })).rejects.toThrow("its answer is not what it should be");
  });
});

/** The Cloud's API as the sandbox half makes it: the token from the company's secrets, no run id. */
const boxes = () => workflowsApi(async (name) => stored[name], { timeoutMs: 5_000 });

/** The company's secrets as the app gives a sandbox half them. */
const storedSecrets = async (names: readonly string[]) => new Map(names.map((name) => [name, stored[name]!]));

describe("cloud's agent boxes through the workflows", () => {
  const opened = {
    id: "i1",
    url: "https://i1-7700.agent37.app/?a37_token=t1",
    expiresAt: "2026-11-17T12:00:00.000Z",
    protocol: 2,
  };

  it("opens, exposes, stops and discards a box by its name alone, each a run of its own, with the token as a bearer", async () => {
    workflows = {
      cloudBoxOpen: () => ({ output: opened }),
      cloudBoxExpose: () => ({
        output: { url: "https://i1-3000.agent37.app/?a37_token=t2", expiresAt: opened.expiresAt },
      }),
      cloudBoxStop: () => ({ output: {} }),
      cloudBoxDiscard: () => ({ output: {} }),
    };
    const api = boxes();
    // The link's expiry is the Cloud's to keep: none of what the box is driven with.
    const { expiresAt: _, ...kept } = opened;
    expect(await api.boxOpen({ name: "sanoma-acme-ada", hosts: ["registry.npmjs.org"] })).toEqual(kept);
    expect(await api.boxExpose({ name: "sanoma-acme-ada", port: 3000 })).toEqual({
      url: "https://i1-3000.agent37.app/?a37_token=t2",
    });
    await api.boxStop({ name: "sanoma-acme-ada" });
    await api.boxDiscard({ name: "sanoma-acme-ada" });
    expect(starts()).toEqual([
      ["cloudBoxOpen.start", { name: "sanoma-acme-ada", hosts: ["registry.npmjs.org"] }],
      ["cloudBoxExpose.start", { name: "sanoma-acme-ada", port: 3000 }],
      ["cloudBoxStop.start", { name: "sanoma-acme-ada" }],
      ["cloudBoxDiscard.start", { name: "sanoma-acme-ada" }],
    ]);
    // Safe to start again: the Cloud finds the box the last run made.
    expect(sent.filter((s) => s.name.endsWith(".start")).map((s) => s.id)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(sent.filter((s) => s.headers.authorization !== `Bearer ${TOKEN}`)).toEqual([]);
  });

  it("refuses a box answer that is not one, and fails with the Cloud's refusal in its own words", async () => {
    workflows = { cloudBoxOpen: () => ({ output: { ...opened, url: "not a link" } }) };
    await expect(boxes().boxOpen({ name: "a", hosts: [] })).rejects.toThrow(
      "cloud-box-open: its answer is not what it should be",
    );
    const busy = "All of Sanoma Cloud's agent boxes are busy. Try again in a few minutes.";
    workflows = { cloudBoxOpen: () => ({ status: 422, body: { error: busy, code: "driver_failed", runId: "r1" } }) };
    await expect(boxes().boxOpen({ name: "a", hosts: [] })).rejects.toMatchObject({ retryable: false, message: busy });
  });

  it("is the connector's sandbox half, which reads the Cloud token from the company's secrets", async () => {
    workflows = { cloudBoxDiscard: () => ({ output: {} }) };
    const backend = await cloud[VENDOR].setup!.sandbox!({ secrets: storedSecrets, declared: {} });
    await backend.discard({ name: "sanoma-acme-ada" });
    expect(starts()).toEqual([["cloudBoxDiscard.start", { name: "sanoma-acme-ada" }]]);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("cloud's driver errors", () => {
  it("fails a call with a failed run's failure, in the workflow's own words as the api answers them (422), final", async () => {
    workflows = {
      cloudList: () => ({ output: [hostless()] }),
      cloudSignup: () => ({
        status: 422,
        body: { error: "acme.sanoma.work is taken: pick another address", code: "driver_failed", runId: "r1" },
      }),
    };
    await expect(op("host.create", { desired: declaredHost })).rejects.toMatchObject({
      message: "acme.sanoma.work is taken: pick another address",
      retryable: false,
      status: 422,
      vendorCode: "driver_failed",
    });
  });

  it("refuses a cloud-list answer that is not its companies, and a token that lists several", async () => {
    for (const output of [{ companies: [] }, null, [{ id: "c1" }]]) {
      workflows = { cloudList: () => ({ output }) };
      await expect(op("host.read", { id: "c1" })).rejects.toThrow("cloud-list: its answer is not what it should be");
    }
    workflows = { cloudList: () => ({ output: [acme(), { ...acme(), id: "c2" }] }) };
    await expect(op("host.plan", { desired: declaredHost })).rejects.toMatchObject({ vendorCode: "not_one" });
  });

  it("fails a call the api refuses with its refusal, final", async () => {
    workflows = {
      cloudList: () => ({ output: [hostless()] }),
      cloudSignup: () => ({ status: 400, body: { error: "The input: slug is not a slug", code: "invalid_input" } }),
    };
    await expect(op("host.create", { desired: declaredHost })).rejects.toMatchObject({
      message: "Sanoma Cloud: cloud-signup: The input: slug is not a slug",
      retryable: false,
      status: 400,
      vendorCode: "invalid_input",
    });
  });

  it("retries a 5xx, a 429, and no reply", async () => {
    workflows = { cloudList: () => ({ status: 500, body: { error: "Something went wrong" } }) };
    await expect(op("host.read", { id: "c1" })).rejects.toMatchObject({ retryable: true, status: 500 });
    workflows = { cloudList: () => ({ status: 429, body: { error: "Too many requests" } }) };
    await expect(op("host.read", { id: "c1" })).rejects.toMatchObject({ retryable: true, status: 429 });
    vi.stubEnv("SANOMA_CLOUD_URL", "http://127.0.0.1:1");
    await expect(op("host.read", { id: "c1" })).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("the request failed"),
    });
  });

  it("says a refused token is unknown or revoked, never its value", async () => {
    stored = { SANOMA_CLOUD_TOKEN: "sca_revoked" };
    const refused = op("host.read", { id: "c1" });
    await expect(refused).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(refused).rejects.toThrow("SANOMA_CLOUD_TOKEN was refused: it is unknown or revoked");
    await expect(refused).rejects.not.toThrow("sca_revoked");
  });

  it("reads the token from the call's secrets, never the environment, and refuses none or one that is no Cloud token", async () => {
    workflows = { cloudList: () => ({ output: [] }) };
    vi.stubEnv("SANOMA_CLOUD_TOKEN", TOKEN);
    stored = {};
    const none = op("host.read", { id: "c1" });
    await expect(none).rejects.toMatchObject({ retryable: false, vendorCode: "no_token" });
    await expect(none).rejects.toThrow("SANOMA_CLOUD_TOKEN is not stored: sign in to Sanoma on the Hosting page");
    stored = { SANOMA_CLOUD_TOKEN: "ghp_not-a-cloud-token" };
    const wrong = op("host.read", { id: "c1" });
    await expect(wrong).rejects.toMatchObject({ vendorCode: "no_token" });
    await expect(wrong).rejects.toThrow("SANOMA_CLOUD_TOKEN is not a Cloud token (sca_…)");
    await expect(wrong).rejects.not.toThrow("ghp_not-a-cloud-token");
    expect(sent).toEqual([]);
    stored = { SANOMA_CLOUD_TOKEN: TOKEN };
    expect(await op("host.read", { id: "c1" })).toEqual({ id: "c1", gone: true });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((s) => s.headers.authorization !== `Bearer ${TOKEN}`)).toEqual([]);
  });

  it("declares only SANOMA_CLOUD_URL, optional, so a computer with the token stored is not refused", () => {
    expect(Object.keys(driver.env!.shape)).toEqual(["SANOMA_CLOUD_URL"]);
    expect(driver.env!.safeParse({}).success).toBe(true);
  });

  it("gives up on a run that has not ended in its time, retryable", async () => {
    running = 1000;
    workflows = { cloudList: () => ({ output: [] }) };
    const quick = cloudDriver({ timeoutMs: 5_000, runTimeoutMs: 50 });
    await expect(quick.ops["host.read"]!({ id: "c1" }, call("cloud.host.read"))).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("has not ended in 50 ms"),
    });
  });
});
