import { live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, DriverError, memorySecrets, type Secrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { sanomaOpsDriver } from "../src/driver.ts";
import { replayOptions, TEST_ACCOUNT_TOKEN } from "./replay.ts";

// Replays test/fixtures (recorded against a local `sanoma wakeup`); the README says how to record them.

const { server, play, sent } = replay(replayOptions);

const ID = "00000000-0000-4000-8000-000000000001";
const HOST = "https://company.example.test";
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
  it("creates an instance with the account's token, storing the instance's as SANOMA_WAKEUP_TOKEN, never returned", async () => {
    play("create");
    const secrets = memorySecrets();
    const made = await op("create", { desired: { host: `${HOST}/` } }, callWith(secrets));
    expect(made).toEqual({ id: ID, state: { id: ID, host: HOST, at: null, generation: 0, lastError: null } });
    expect(JSON.stringify(made)).not.toContain("swi_");
    expect(await secrets.get("SANOMA_WAKEUP_TOKEN")).toBe("swi_recorded0001");
    expect(sent[0]).toMatchObject({ method: "POST", path: "/wakeup/instances", body: { url: HOST } });
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_ACCOUNT_TOKEN}`);
  });

  it("registers a wake with the instance's own token", async () => {
    play("register");
    const call = callWith();
    const { id } = (await op("create", { desired: { host: HOST } }, call)) as { id: string };
    await op("register", { id, at: "2099-01-01T00:00:00Z", generation: 1 }, call);
    expect(sent[1]).toMatchObject({
      method: "PUT",
      path: `/wakeup/instances/${id}/wake`,
      body: { at: "2099-01-01T00:00:00Z", generation: 1 },
    });
    expect(sent[1]!.headers.get("authorization")).toBe("Bearer swi_recorded0001");
    expect(await op("read", { id }, call)).toMatchObject({ state: { at: "2099-01-01T00:00:00.000Z", generation: 1 } });
  });

  it("removes a new instance again, and refuses, when another's token is stored", async () => {
    play("stale", [
      { method: "POST", path: "/wakeup/instances", status: 201, body: { id: ID, token: "swi_new" } },
      { method: "DELETE", path: `/wakeup/instances/${ID}`, status: 204, body: null },
    ]);
    const secrets = memorySecrets({ SANOMA_WAKEUP_TOKEN: "swi_old" });
    const err = await failure(op("create", { desired: { host: HOST } }, callWith(secrets)));
    expect(err).toMatchObject({ retryable: false, vendorCode: "stale" });
    expect(err.message).toContain("SANOMA_WAKEUP_TOKEN holds another instance's token");
    expect(await secrets.get("SANOMA_WAKEUP_TOKEN")).toBe("swi_old");
  });

  it("refuses a new host while a token is stored, before it deletes the instance", async () => {
    play("new-host", [{ method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown }]);
    const secrets = memorySecrets({ SANOMA_WAKEUP_TOKEN: "swi_old" });
    const update = op("update", { id: ID, desired: { host: "https://elsewhere.example.test" } }, callWith(secrets));
    expect(await failure(update)).toMatchObject({ retryable: false, vendorCode: "stale" });
  });

  it("plans no change for the same host written another way, as the service keeps URLs", async () => {
    play("same-host", [{ method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown }]);
    const plan = await op("plan", { id: ID, desired: { host: "https://COMPANY.example.test:443/" } });
    expect(plan).toMatchObject({ action: "none", replace: [] });
  });

  it("replaces an instance for a new host once no token is stored: the new one first, then the old one", async () => {
    const NEW = "00000000-0000-4000-8000-000000000002";
    play("replace", [
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown },
      { method: "POST", path: "/wakeup/instances", status: 201, body: { id: NEW, token: "swi_new" } },
      { method: "DELETE", path: `/wakeup/instances/${ID}`, status: 204, body: null },
    ]);
    const secrets = memorySecrets();
    const desired = { host: "https://elsewhere.example.test" };
    const made = await op(
      "update",
      { id: ID, desired, expect: { action: "replace", replace: ["host"] } },
      callWith(secrets),
    );
    expect(made).toMatchObject({ id: NEW, state: { host: "https://elsewhere.example.test" } });
    expect(await secrets.get("SANOMA_WAKEUP_TOKEN")).toBe("swi_new");
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
    await expect(op("register", { id: ID, at: "2099-01-01T00:00:00Z", generation: 1 })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("SANOMA_WAKEUP_TOKEN is not set"),
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
