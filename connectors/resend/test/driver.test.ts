import { type Exchange, live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { resendDriver } from "../src/driver.ts";
import { audience, from, replayOptions } from "./replay.ts";

// Replays test/fixtures; the README says how to run these tests against Resend.

const { server, play, fixture, sent } = replay(replayOptions);

const call: CallContext = {
  idempotencyKey: "run-1:3",
  runId: "run-1",
  opId: "resend.broadcast.create",
  attempt: 1,
  secrets: memorySecrets(),
};
/** The run's next call: its own idempotency key. */
const sendCall: CallContext = {
  idempotencyKey: "run-1:4",
  runId: "run-1",
  opId: "resend.broadcast.send",
  attempt: 1,
  secrets: memorySecrets(),
};
const driver = resendDriver({ timeoutMs: live ? 15_000 : 200 });
const create = (input: Record<string, unknown>) => driver.ops["broadcast.create"]!(input, call);
const send = (id: string) => driver.ops["broadcast.send"]!({ id }, sendCall);
/** A draft to send, as Resend reads it, then `then`'s replies. */
const sending = (...then: Exchange[]) => [...fixture("get-draft"), ...then];
const read = (status: string): Exchange[] => [
  { method: "GET", path: "/broadcasts/bc_1", status: 200, body: { object: "broadcast", id: "bc_1", status } },
];

describe("resendDriver", () => {
  it("creates a broadcast as a draft, then reads it and sends it", async () => {
    play("create-and-send");
    const { id } = (await create({ audience, from, subject: "Sanoma driver test", html: "<p>Hello</p>" })) as {
      id: string;
    };
    expect(id).toEqual(expect.any(String));
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: { segment_id: audience, from, subject: "Sanoma driver test", html: "<p>Hello</p>", name: "run-1:3" },
    });
    expect(sent[0]!.headers.get("idempotency-key")).toBe("run-1:3");
    // Compared, not printed: a failure must not show a live key.
    expect(sent[0]!.headers.get("authorization") === `Bearer ${process.env.RESEND_API_KEY}`).toBe(true);

    expect(await send(id)).toEqual({ id, status: "queued" });
    expect(sent.slice(1).map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /broadcasts/${id}`,
      `POST /broadcasts/${id}/send`,
    ]);
    expect(sent.slice(1).map((r) => r.headers.get("idempotency-key"))).toEqual(["run-1:4", "run-1:4"]);
  });

  it("takes the sender from RESEND_FROM, read at the call, when the input has none", async () => {
    play("create");
    vi.stubEnv("RESEND_FROM", from);
    await create({ audience, subject: "s", html: "" });
    expect(sent[0]!.body).toMatchObject({ from });
  });

  it("refuses a broadcast with no sender without calling Resend", async () => {
    await expect(create({ audience, subject: "s", html: "" })).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      message: expect.stringContaining("`from`"),
    });
    expect(sent).toEqual([]);
  });

  it("fails a 422 for good, with Resend's status and error name", async () => {
    // Read before the test can re-record it: live, Resend's reply must still match it.
    const [invalid] = fixture("create-invalid-from") as [Exchange & { body: { name: string } }];
    play("create-invalid-from");
    await expect(create({ audience, from: "not an address", subject: "s", html: "" })).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      status: 422,
      vendorCode: invalid.body.name,
      message: expect.stringContaining("resend: broadcast.create failed (422)"),
    });
  });

  describe.skipIf(live)("when the broadcast is not a draft", () => {
    it("does not send one already sent, so a replay sends nothing", async () => {
      play("get-sent");
      expect(await send("bc_1")).toEqual({ id: "bc_1", status: "sent" });
      expect(sent.map((r) => r.method)).toEqual(["GET"]);
    });

    it("does not send one queued, and says it is", async () => {
      play("queued", read("queued"));
      expect(await send("bc_1")).toEqual({ id: "bc_1", status: "queued" });
    });

    it("fails for good to send one canceled", async () => {
      play("canceled", read("canceled"));
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: "resend: broadcast.send: broadcast bc_1 is canceled, not sendable",
      });
    });
  });

  describe.skipIf(live)("when Resend misbehaves", () => {
    it.each([
      ["rate-limit", true, "rate_limit_exceeded"],
      ["server-error", true, "application_error"],
      ["daily-quota", false, "daily_quota_exceeded"],
    ])("a %s reply is retryable: %s", async (name, retryable, vendorCode) => {
      const [reply] = fixture(name) as [Exchange];
      play(name, sending(reply));
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable,
        status: reply.status,
        vendorCode,
      });
    });

    it.each([
      [408, "request_timeout", true],
      [409, "concurrent_idempotent_requests", true],
      [409, "invalid_idempotent_request", false],
    ])("a %i %s is retryable: %s", async (status, name, retryable) => {
      const body = { statusCode: status, name, message: name };
      play(name, sending({ method: "POST", path: "/broadcasts/bc_1/send", status, body }));
      await expect(send("bc_1")).rejects.toMatchObject({ name: "DriverError", retryable, status, vendorCode: name });
    });

    it("fails for good on a 2xx whose body is not JSON", async () => {
      server.use(
        http.get(
          "*/broadcasts/bc_1",
          () => new Response("<html>ok</html>", { headers: { "Content-Type": "application/json" } }),
        ),
      );
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 200,
        message: "resend: broadcast.send replied 200 with a body that is not JSON",
      });
    });

    it("fails for good when the read is no broadcast, without sending", async () => {
      play("read-empty", [{ method: "GET", path: "/broadcasts/bc_1", status: 200, body: {} }]);
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: "resend: broadcast.send replied 200 without a broadcast id",
      });
      expect(sent.map((r) => r.method)).toEqual(["GET"]);
    });

    it("fails for good when the request cannot be built, without retrying a key that will never work", async () => {
      vi.stubEnv("RESEND_API_KEY", "re_key\nwith a newline");
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: "resend: broadcast.send could not build its request",
      });
      expect(sent).toEqual([]);
    });

    it("fails retryable when the connection drops", async () => {
      server.use(http.get("*/broadcasts/bc_1", () => HttpResponse.error()));
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        status: undefined,
        message: "resend: broadcast.send got no reply",
      });
    });

    it("keeps a 4xx final when its body fails while it is read", async () => {
      // Headers arrive, then the body fails as the timeout would while it is read.
      const body = new ReadableStream({
        start: (c) => {
          c.enqueue(new TextEncoder().encode('{"name":'));
          setTimeout(() => c.error(new DOMException("The operation timed out.", "TimeoutError")), 10);
        },
      });
      server.use(http.get("*/broadcasts/bc_1", () => new HttpResponse(body, { status: 422 })));
      await expect(send("bc_1")).rejects.toMatchObject({ name: "DriverError", retryable: false, status: 422 });
    });

    it("fails retryable when Resend does not answer in time", async () => {
      server.use(http.all("*", () => delay("infinite")));
      await expect(send("bc_1")).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        status: undefined,
        message: "resend: broadcast.send timed out after 200 ms",
      });
    });
  });

  it("names the variable when the API key is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    await expect(send("bc_1")).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      message: "resend: RESEND_API_KEY is not set",
    });
    expect(sent).toEqual([]);
  });
});
