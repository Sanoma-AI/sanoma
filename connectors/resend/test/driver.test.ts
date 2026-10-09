import { readFileSync, writeFileSync } from "node:fs";
import type { CallContext, DriverError } from "@sanoma/workflows";
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resendDriver } from "../src/driver.ts";

// Replays the responses in fixtures/. With SANOMA_LIVE=1 (ignored in CI), RESEND_API_KEY and
// RESEND_TEST_AUDIENCE, the same tests call Resend, creating and sending broadcasts to that segment;
// SANOMA_RECORD=1 then rewrites the fixtures from Resend's replies, scrubbed.
const live = process.env.SANOMA_LIVE === "1" && !process.env.CI;
const record = live && process.env.SANOMA_RECORD === "1";

const API = "https://api.resend.com";
const audience = live ? (process.env.RESEND_TEST_AUDIENCE ?? "") : "00000000-0000-4000-8000-0000000000aa";
const from = process.env.RESEND_TEST_FROM ?? "Sanoma test <onboarding@resend.dev>";
const call: CallContext = { idempotencyKey: "run-1:3", runId: "run-1", opId: "resend.broadcast.create", attempt: 1 };

interface Fixture {
  status: number;
  body: unknown;
}
const fixtureUrl = (name: string) => new URL(`fixtures/${name}.json`, import.meta.url);
const fixture = (name: string): Fixture => JSON.parse(readFileSync(fixtureUrl(name), "utf8"));

/** Ids, addresses and keys out of a recorded reply, so the repo never holds an account's. */
const scrub = (json: string) =>
  json
    .replaceAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "00000000-0000-4000-8000-000000000001",
    )
    .replaceAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "someone@example.com")
    .replaceAll(/re_\w+/g, "re_redacted");

const server = setupServer();
const requests: Request[] = [];
/** The fixture each request (`<method> <path>`) is recorded as, live. */
const recordAs = new Map<string, string>();
const recordings: Promise<void>[] = [];
const requestKey = (method: string, url: string) => `${method.toUpperCase()} ${new URL(url).pathname}`;
server.events.on("request:start", ({ request }) => void requests.push(request.clone()));
server.events.on("response:bypass", ({ request, response }) => {
  const name = recordAs.get(requestKey(request.method, request.url));
  if (!record || !name) return;
  recordings.push(
    response
      .clone()
      .text()
      .then((text) => {
        const body: Fixture = { status: response.status, body: text ? JSON.parse(text) : null };
        writeFileSync(fixtureUrl(name), `${scrub(JSON.stringify(body, null, 2))}\n`);
      }),
  );
});

/**
 * The next `method` request to `path` gets the fixture `name` (or `given`); live, its reply is
 * recorded as `name`.
 */
function reply(
  name: string,
  path: string,
  { method = "post", given }: { method?: "get" | "post"; given?: Fixture } = {},
) {
  recordAs.set(requestKey(method, `${API}${path}`), name);
  if (live) return;
  const { status, body } = given ?? fixture(name);
  server.use(http[method](`${API}${path}`, () => HttpResponse.json(body as any, { status }), { once: true }));
}
/** The broadcast `id` is read before it is sent: as a draft unless `given` says otherwise. */
const read = (id: string, given?: Fixture) => reply("get-draft", `/broadcasts/${id}`, { method: "get", given });

// Read before any test can re-record it: live, Resend's reply must still match it.
const invalidFrom = fixture("create-invalid-from") as Fixture & { body: { name: string } };

const driver = resendDriver({ timeoutMs: live ? 15_000 : 200 });
const create = (input: Record<string, unknown>) => driver.ops["broadcast.create"]!(input, call);
const send = (id: string) => driver.ops["broadcast.send"]!({ id }, { ...call, opId: "resend.broadcast.send" });
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable(),
    (err: DriverError) => err,
  );

beforeAll(() => {
  if (live && (!process.env.RESEND_API_KEY || !process.env.RESEND_TEST_AUDIENCE)) {
    throw new Error("SANOMA_LIVE=1 needs RESEND_API_KEY and RESEND_TEST_AUDIENCE");
  }
  server.listen({ onUnhandledFrame: live ? "bypass" : "error" });
});
beforeEach(() => {
  requests.length = 0;
  if (!live) vi.stubEnv("RESEND_API_KEY", "re_test_key");
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await Promise.all(recordings);
  server.close();
});

describe("resendDriver", () => {
  it("creates a broadcast as a draft, then sends it", async () => {
    reply("create", "/broadcasts");
    const { id } = (await create({ audience, from, subject: "Sanoma driver test", html: "<p>Hello</p>" })) as {
      id: string;
    };
    expect(id).toEqual(expect.any(String));
    const sent = requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("idempotency-key")).toBe("run-1:3");
    expect(await sent.json()).toEqual({
      segment_id: audience,
      from,
      subject: "Sanoma driver test",
      html: "<p>Hello</p>",
      name: "run-1:3",
    });
    // Compared, not printed: a failure must not show a live key.
    expect(sent.headers.get("authorization") === `Bearer ${process.env.RESEND_API_KEY}`).toBe(true);

    read(id);
    reply("send", `/broadcasts/${id}/send`);
    expect(await send(id)).toEqual({ id, status: "queued" });
    expect(requests.slice(1).map((r) => requestKey(r.method, r.url))).toEqual([
      `GET /broadcasts/${id}`,
      `POST /broadcasts/${id}/send`,
    ]);
    expect(requests[2]!.headers.get("idempotency-key")).toBe("run-1:3");
  });

  it.skipIf(live)("does not send a broadcast that is already sent, so a replay sends nothing", async () => {
    read("bc_1", fixture("get-sent"));
    expect(await send("bc_1")).toEqual({ id: "bc_1", status: "sent" });
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it.skipIf(live)("does not send a broadcast that is queued, and says it is", async () => {
    read("bc_1", { status: 200, body: { object: "broadcast", id: "bc_1", status: "queued" } });
    expect(await send("bc_1")).toEqual({ id: "bc_1", status: "queued" });
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it.skipIf(live)("fails for good to send a canceled broadcast", async () => {
    read("bc_1", { status: 200, body: { object: "broadcast", id: "bc_1", status: "canceled" } });
    const err = await failure(send("bc_1"));
    expect(err).toMatchObject({
      retryable: false,
      message: "resend: broadcast.send: broadcast bc_1 is canceled, not sendable",
    });
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("takes the sender from the driver's options when the input has none", async () => {
    reply("create", "/broadcasts");
    await resendDriver({ from }).ops["broadcast.create"]!({ audience, subject: "s", html: "" }, call);
    expect(await requests[0]!.json()).toMatchObject({ from });
  });

  it("refuses a broadcast with no sender without calling Resend", async () => {
    const err = await failure(create({ audience, subject: "s", html: "" }));
    expect(err).toMatchObject({ name: "DriverError", retryable: false, message: expect.stringContaining("`from`") });
    expect(requests).toEqual([]);
  });

  it("fails a 422 for good, with Resend's status and error name", async () => {
    reply("create-invalid-from", "/broadcasts");
    const err = await failure(create({ audience, from: "not an address", subject: "s", html: "" }));
    expect(err).toMatchObject({
      name: "DriverError",
      retryable: false,
      status: 422,
      vendorCode: invalidFrom.body.name,
      message: expect.stringContaining("resend: broadcast.create failed (422)"),
    });
  });

  it.skipIf(live).each([
    ["rate-limit", true, "rate_limit_exceeded"],
    ["server-error", true, "application_error"],
    ["daily-quota", false, "daily_quota_exceeded"],
  ])("a %s reply is retryable: %s", async (name, retryable, vendorCode) => {
    read("bc_1");
    reply(name, "/broadcasts/bc_1/send");
    const err = await failure(send("bc_1"));
    expect(err).toMatchObject({ retryable, status: fixture(name).status, vendorCode });
  });

  it.skipIf(live).each([
    [408, "request_timeout", true],
    [409, "concurrent_idempotent_requests", true],
    [409, "invalid_idempotent_request", false],
  ])("a %i %s is retryable: %s", async (status, name, retryable) => {
    read("bc_1");
    reply(name, "/broadcasts/bc_1/send", { given: { status, body: { statusCode: status, name, message: name } } });
    const err = await failure(send("bc_1"));
    expect(err).toMatchObject({ retryable, status, vendorCode: name });
  });

  it.skipIf(live)("fails retryable when Resend does not answer in time", async () => {
    server.use(http.all(`${API}/*`, () => delay("infinite")));
    const err = await failure(send("bc_1"));
    expect(err).toMatchObject({ retryable: true, message: "resend: broadcast.send timed out after 200 ms" });
    expect(err.status).toBeUndefined();
  });

  it("names the variable when the API key is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    const err = await failure(send("bc_1"));
    expect(err).toMatchObject({ retryable: false, message: "resend: RESEND_API_KEY is not set" });
    expect(requests).toEqual([]);
  });
});
