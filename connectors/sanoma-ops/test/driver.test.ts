import { live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, DriverError, memorySecrets, type Secrets } from "@sanoma-ai/workflows";
import { mintInstanceToken } from "@sanoma-ai/workflows/wakeup-service";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { sanomaOpsDriver } from "../src/driver.ts";
import { replayOptions, TEST_ACCOUNT_TOKEN } from "./replay.ts";

// Replays test/fixtures (recorded against a local `sanoma wakeup`); the README says how to record them.

const { server, play, sent } = replay(replayOptions);

const ID = "00000000-0000-4000-8000-000000000001";
const HOST = "https://company.example.test";
/** An instance token as /setup mints one: a new one per test, so a live recording makes a new instance for each. */
const newToken = mintInstanceToken;
/** An instance as `GET /wakeup/instances/{id}` shows it. */
const shown = { id: ID, url: HOST, at: null, generation: 0, calledAt: null, attempts: 0, lastError: null };
const callWith = (secrets: Secrets = memorySecrets()): CallContext => ({
  idempotencyKey: "run-1:1",
  runId: "run-1",
  opId: "sanomaOps.wakeup",
  attempt: 1,
  secrets,
});
const op = (name: string, input: object, call = callWith(), driver = sanomaOpsDriver()) =>
  driver.ops[`wakeup.${name}`]!(input, call);
/** The `DriverError` `promise` fails with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable(),
    (err: DriverError) => err,
  );

describe.skipIf(live)("sanomaOpsDriver", () => {
  it("creates an instance with the account's token and the stored instance token, which it never returns", async () => {
    play("create");
    const token = newToken();
    const secrets = memorySecrets({ SANOMA_WAKEUP_TOKEN: token });
    const made = await op("create", { desired: { host: `${HOST}/` } }, callWith(secrets));
    expect(made).toEqual({ id: ID, state: { id: ID, host: HOST, at: null, generation: 0, lastError: null } });
    expect(JSON.stringify(made)).not.toContain("swi_");
    expect(sent[0]).toMatchObject({ method: "POST", path: "/wakeup/instances", body: { url: HOST, token } });
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_ACCOUNT_TOKEN}`);
  });

  it("mints and stores an instance token when none is, for a data file written without /setup", async () => {
    play("mint", [{ method: "POST", path: "/wakeup/instances", status: 201, body: { id: ID } }]);
    const secrets = memorySecrets();
    await op("create", { desired: { host: HOST } }, callWith(secrets));
    const token = await secrets.get("SANOMA_WAKEUP_TOKEN");
    expect(token).toMatch(/^swi_[\w-]{43}$/);
    expect(sent[0]).toMatchObject({ body: { url: HOST, token } });
  });

  it("registers a wake with the instance's own token", async () => {
    play("register");
    const token = newToken();
    const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: token }));
    const { id } = (await op("create", { desired: { host: HOST } }, call)) as { id: string };
    await op("register", { at: "2099-01-01T00:00:00Z", generation: 1 }, call);
    expect(sent[1]).toMatchObject({
      method: "PUT",
      path: "/wakeup/wake",
      body: { at: "2099-01-01T00:00:00Z", generation: 1 },
    });
    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(await op("read", { id }, call)).toMatchObject({ state: { at: "2099-01-01T00:00:00.000Z", generation: 1 } });
  });

  it("plans no change for the same host written another way, as the service keeps URLs", async () => {
    play("same-host", [{ method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown }]);
    const plan = await op("plan", { id: ID, desired: { host: "https://COMPANY.example.test:443/" } });
    expect(plan).toMatchObject({ action: "none", replace: [] });
  });

  it("moves the instance to a new host by posting its token again: an update, never a replace", async () => {
    play("new-host", [
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown },
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown },
      { method: "POST", path: "/wakeup/instances", status: 200, body: { id: ID } },
    ]);
    const desired = { host: "https://elsewhere.example.test" };
    const plan = await op("plan", { id: ID, desired });
    expect(plan).toMatchObject({
      action: "update",
      replace: [],
      planned: { host: desired.host, at: null, generation: 0, lastError: null },
    });
    const token = newToken();
    const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: token }));
    const moved = await op("update", { id: ID, desired, expect: { action: "update", replace: [] } }, call);
    expect(moved).toMatchObject({ id: ID, state: { host: desired.host } });
    expect(sent[2]).toMatchObject({ method: "POST", body: { url: desired.host, token } });
  });

  it("reads a 404 that is not the service's as a failure, not as gone", async () => {
    play("not-the-service", [
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 404, body: "<html>Not found</html>" },
    ]);
    expect(await failure(op("read", { id: ID }))).toMatchObject({ status: 404, retryable: false });
  });

  it("reads an instance the service does not have as gone, and deletes it as done", async () => {
    const missing = { status: 404, body: { error: "no such instance" } };
    play("gone", [
      { method: "GET", path: `/wakeup/instances/${ID}`, ...missing },
      { method: "DELETE", path: `/wakeup/instances/${ID}`, ...missing },
    ]);
    expect(await op("read", { id: ID })).toEqual({ id: ID, gone: true });
    expect(await op("delete", { id: ID })).toEqual({ id: ID, gone: true });
  });

  it("refuses without its tokens, before any request", async () => {
    vi.stubEnv("SANOMA_OPS_TOKEN", "");
    await expect(op("read", { id: ID })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("SANOMA_OPS_TOKEN is not set"),
    });
    await expect(op("register", { at: "2099-01-01T00:00:00Z", generation: 1 })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("SANOMA_WAKEUP_TOKEN is not set: connect sanoma-ops in /setup"),
    });
    expect(sent).toEqual([]);
  });

  it.each([
    [401, false],
    [403, false],
    [400, false],
    [408, true],
    [429, true],
    [503, true],
  ])("maps a %i to a DriverError, retryable %s, keeping its status", async (status, retryable) => {
    play("status", [{ method: "GET", path: `/wakeup/instances/${ID}`, status, body: { error: "said the service" } }]);
    const err = await failure(op("read", { id: ID }));
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({
      status,
      retryable,
      message: `sanomaOps: GET /wakeup/instances/${ID}: said the service`,
    });
  });

  it("retries no reply and a timeout", async () => {
    server.use(http.all("*", () => HttpResponse.error()));
    expect(await failure(op("read", { id: ID }))).toMatchObject({ retryable: true });
    server.use(http.all("*", () => delay("infinite")));
    const slow = op("read", { id: ID }, callWith(), sanomaOpsDriver({ timeoutMs: 50 }));
    expect(await failure(slow)).toMatchObject({
      retryable: true,
      message: expect.stringContaining("no reply in 50 ms"),
    });
  });
});
