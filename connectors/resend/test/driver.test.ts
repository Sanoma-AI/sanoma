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
/** `emails.send` as the run's call `seq`: each test its own key, since Resend refuses a key again with another email. */
const email = (input: Record<string, unknown>, seq: number) =>
  driver.ops["emails.send"]!(input, { ...call, idempotencyKey: `run-1:${seq}`, opId: "resend.emails.send" });
/** Resend's test inbox: it accepts the email and delivers it nowhere. */
const to = "delivered@resend.dev";
/** A draft to send, as Resend reads it, then `then`'s replies. */
const sending = (...then: Exchange[]) => [...fixture("get-draft"), ...then];
const read = (status: string): Exchange[] => [
  { method: "GET", path: "/broadcasts/bc_1", status: 200, body: { object: "broadcast", id: "bc_1", status } },
];

// The sending domain's calls, and Resend's replies about it.
const ID = "00000000-0000-4000-8000-000000000001";
const domain = (op: string, input: Record<string, unknown>) =>
  driver.ops[`domain.${op}`]!(input, { ...call, idempotencyKey: `run-1:${op}`, opId: `resend.domain.${op}` });
/** The domain as the fixtures' `GET` gives it, with `body`'s fields instead. */
const got = (body: Record<string, unknown> = {}): Exchange => {
  const [, , reply] = fixture("create-a-domain") as [Exchange, Exchange, Exchange & { body: object }];
  return { ...reply, body: { ...reply.body, ...body } };
};
const verify: Exchange = { method: "POST", path: `/domains/${ID}/verify`, status: 200, body: { id: ID } };
const notFound = (method: string): Exchange => ({
  method,
  path: `/domains/${ID}`,
  status: 404,
  body: { statusCode: 404, name: "not_found", message: "Domain not found" },
});

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

  it("takes the sender from the deprecated RESEND_FROM, read at the call, when the input has none, and warns once", async () => {
    // Two drafts: the second warns no more.
    play("sender-fallback", [...fixture("create"), ...fixture("create")]);
    vi.stubEnv("RESEND_FROM", from);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await create({ audience, subject: "s", html: "" });
    // An empty sender is none.
    await create({ audience, from: "", subject: "s", html: "" });
    expect(sent.map((r) => r.body)).toMatchObject([{ from }, { from }]);
    expect(warn.mock.calls.filter(([m]) => String(m).includes("RESEND_FROM"))).toHaveLength(1);
  });

  it("refuses a broadcast with no sender without calling Resend", async () => {
    vi.stubEnv("RESEND_FROM", undefined);
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

  describe("emails.send", () => {
    it("sends one email with the call's idempotency key, and returns its id", async () => {
      play("send-an-email");
      const reply = await email({ to, from, subject: "Following up", html: "<p>Hello</p>" }, 5);
      expect(reply).toEqual({ id: expect.any(String) });
      expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /emails"]);
      // No `text`: Resend makes it from the HTML.
      expect(sent[0]!.body).toEqual({ to, from, subject: "Following up", html: "<p>Hello</p>" });
      expect(sent[0]!.headers.get("idempotency-key")).toBe("run-1:5");
    });

    it("sends to a list, as text", async () => {
      play("send-an-email");
      await email({ to: [to, to], from, subject: "s", text: "Hello" }, 6);
      expect(sent[0]!.body).toEqual({ to: [to, to], from, subject: "s", text: "Hello" });
    });

    it("refuses an email with no sender, or an empty one, without calling Resend", async () => {
      vi.stubEnv("RESEND_FROM", undefined);
      for (const sender of [{}, { from: "" }]) {
        await expect(email({ to, ...sender, subject: "s", text: "Hello" }, 7)).rejects.toMatchObject({
          name: "DriverError",
          retryable: false,
          message: "resend: emails.send needs `from` in its input, or RESEND_FROM set",
        });
      }
      expect(sent).toEqual([]);
    });

    it.skipIf(live)("fails for good when the key was used for another email", async () => {
      const body = { statusCode: 409, name: "invalid_idempotent_request", message: "Same key, other payload" };
      play("other-payload", [{ method: "POST", path: "/emails", status: 409, body }]);
      await expect(email({ to, from, subject: "s", text: "Hello" }, 8)).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 409,
        vendorCode: "invalid_idempotent_request",
        message: "resend: emails.send failed (409): Same key, other payload",
      });
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
        message: "resend: broadcast.send replied 200 without an id",
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

  // Replayed only: live, the features make and delete a domain (README, "Testing the driver").
  describe.skipIf(live)("domain", () => {
    it("creates a domain, asks Resend to verify it at once, and reads its records as a zone holds them", async () => {
      play("create-a-domain");
      const made = await domain("create", { desired: { name: "example.com" } });
      expect(sent.slice(0, 3).map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /domains",
        `POST /domains/${ID}/verify`,
        `GET /domains/${ID}`,
      ]);
      // Only what was declared: Resend's defaults stand for the rest.
      expect(sent[0]!.body).toEqual({ name: "example.com" });
      // One call, several requests: none carries the call's key, which Resend would hold to one request.
      expect(sent.slice(0, 3).map((r) => r.headers.get("idempotency-key"))).toEqual([null, null, null]);
      expect(made).toMatchObject({
        id: ID,
        state: { name: "example.com", region: "us-east-1", custom_return_path: "send", id: ID, status: "pending" },
      });
      // Full names, the SPF text without the quotes Resend's read puts around it, "Auto" as 1.
      expect((made as { state: { dns_records: unknown } }).state.dns_records).toEqual([
        { type: "TXT", name: "resend._domainkey.example.com", content: "p=redacted", ttl: 1 },
        {
          type: "MX",
          name: "send.example.com",
          content: "feedback-smtp.us-east-1.amazonses.com",
          priority: 10,
          ttl: 1,
        },
        { type: "TXT", name: "send.example.com", content: "v=spf1 include:amazonses.com ~all", ttl: 1 },
      ]);
      await domain("delete", { id: ID });
    });

    it("sends the region and Return-Path declared", async () => {
      play("declared", [
        { method: "POST", path: "/domains", status: 201, body: { id: ID } },
        verify,
        got({ region: "eu-west-1" }),
      ]);
      await domain("create", { desired: { name: "example.com", region: "eu-west-1", custom_return_path: "bounce" } });
      expect(sent[0]!.body).toEqual({ name: "example.com", region: "eu-west-1", custom_return_path: "bounce" });
    });

    it("names a subdomain's records in full, whether Resend writes them relative to the zone or in full", async () => {
      const pending = { ttl: "Auto", status: "pending" };
      play("subdomain", [
        got({
          name: "mail.example.com",
          records: [
            { record: "DKIM", type: "TXT", value: "p=redacted", name: "resend._domainkey.mail", ...pending },
            {
              record: "SPF",
              type: "MX",
              value: "feedback-smtp.us-east-1.amazonses.com",
              priority: 10,
              name: "bounce.mail",
              ...pending,
            },
            {
              record: "SPF",
              type: "TXT",
              value: '"v=spf1 include:" "amazonses.com ~all"',
              name: "bounce.mail",
              ...pending,
            },
            {
              record: "Tracking",
              type: "CNAME",
              value: "links1.resend-dns.com",
              name: "links.mail.example.com.",
              ...pending,
            },
            // The subdomain itself, relative to the zone.
            {
              record: "Receiving",
              type: "MX",
              value: "inbound-smtp.us-east-1.amazonaws.com",
              priority: 10,
              name: "mail",
              ...pending,
            },
          ],
        }),
      ]);
      const { state } = (await domain("read", { id: ID })) as {
        state: { custom_return_path: string; dns_records: { name: string; content: string }[] };
      };
      expect(state.custom_return_path).toBe("bounce");
      // Split into two quoted strings, as a long TXT value may be: joined, unquoted.
      expect(state.dns_records[2]).toMatchObject({ content: "v=spf1 include:amazonses.com ~all" });
      expect(state.dns_records.map((r) => r.name)).toEqual([
        "resend._domainkey.mail.example.com",
        "bounce.mail.example.com",
        "bounce.mail.example.com",
        "links.mail.example.com",
        "mail.example.com",
      ]);
    });

    it("takes a Return-Path the records do not show to be Resend's default", async () => {
      const dkim = { record: "DKIM", type: "TXT", value: "p=redacted", name: "resend._domainkey", ttl: "Auto" };
      const verified = got({ status: "verified", records: [dkim] });
      play("no-spf", [verified, verified, verified]);
      const { state } = (await domain("read", { id: ID })) as { state: Record<string, unknown> };
      expect(state).not.toHaveProperty("custom_return_path");
      // Taken to be Resend's default: one declared otherwise is a change.
      expect(
        await domain("plan", { id: ID, desired: { name: "example.com", custom_return_path: "send" } }),
      ).toMatchObject({ action: "none", replace: [] });
      expect(
        await domain("plan", { id: ID, desired: { name: "example.com", custom_return_path: "bounce" } }),
      ).toMatchObject({ action: "replace", replace: ["custom_return_path"] });
    });

    it("takes the Return-Path from an SPF CNAME record, which newer domains have instead of the MX", async () => {
      const spf = { record: "SPF", type: "CNAME", ttl: "Auto", status: "pending" };
      play("cname-spf", [got({ records: [{ ...spf, name: "bounce", value: "send.resend-dns.com" }] })]);
      expect(await domain("read", { id: ID })).toMatchObject({
        state: {
          custom_return_path: "bounce",
          dns_records: [{ type: "CNAME", name: "bounce.example.com", content: "send.resend-dns.com", ttl: 1 }],
        },
      });
    });

    it("plans no change for a verified domain, and verifies an unverified one again", async () => {
      play("verified", [got({ status: "verified" })]);
      expect(await domain("plan", { id: ID, desired: { name: "example.com" } })).toMatchObject({
        action: "none",
        unknown: [],
        replace: [],
      });
      play("reverify", [got(), got(), verify, got({ status: "verified" })]);
      expect(await domain("plan", { id: ID, desired: { name: "example.com" } })).toMatchObject({ action: "update" });
      const updated = await domain("update", {
        id: ID,
        desired: { name: "example.com" },
        expect: { action: "update", replace: [] },
      });
      expect(updated).toMatchObject({ id: ID, state: { status: "verified" } });
    });

    it("refuses an update whose plan changed since it was approved", async () => {
      play("changed", [got({ status: "verified" })]);
      await expect(
        domain("update", { id: ID, desired: { name: "example.com" }, expect: { action: "update", replace: [] } }),
      ).rejects.toMatchObject({ name: "DriverError", retryable: false, vendorCode: "plan_changed" });
    });

    it("replaces a domain moved to another region: deletes it, then makes it anew", async () => {
      const NEW = "00000000-0000-4000-8000-000000000002";
      play("replace", [
        got(),
        { method: "DELETE", path: `/domains/${ID}`, status: 200, body: { id: ID, deleted: true } },
        { method: "POST", path: "/domains", status: 201, body: { id: NEW } },
        { ...verify, path: `/domains/${NEW}/verify` },
        { ...got({ id: NEW, region: "eu-west-1" }), path: `/domains/${NEW}` },
      ]);
      const replaced = await domain("update", {
        id: ID,
        desired: { name: "example.com", region: "eu-west-1" },
        expect: { action: "replace", replace: ["region"] },
      });
      expect(replaced).toMatchObject({ id: NEW, state: { region: "eu-west-1" } });
      expect(sent[2]!.body).toEqual({ name: "example.com", region: "eu-west-1" });
    });

    it("names the domain a replace deleted when making it anew fails", async () => {
      play("replace-fails", [
        got(),
        { method: "DELETE", path: `/domains/${ID}`, status: 200, body: { id: ID, deleted: true } },
        {
          method: "POST",
          path: "/domains",
          status: 422,
          body: { statusCode: 422, name: "validation_error", message: "Invalid region" },
        },
      ]);
      await expect(
        domain("update", {
          id: ID,
          desired: { name: "example.com", region: "eu-west-1" },
          expect: { action: "replace", replace: ["region"] },
        }),
      ).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        vendorCode: "replace_incomplete",
        message: expect.stringMatching(
          new RegExp(`deleted domain ${ID} \\(example\\.com, us-east-1\\).*Invalid region.*apply again`),
        ),
      });
    });

    it("leaves a verify that fails after a replace's create as it is: the new domain exists", async () => {
      const NEW = "00000000-0000-4000-8000-000000000002";
      play("replace-verify-fails", [
        got(),
        { method: "DELETE", path: `/domains/${ID}`, status: 200, body: { id: ID, deleted: true } },
        { method: "POST", path: "/domains", status: 201, body: { id: NEW } },
        {
          method: "POST",
          path: `/domains/${NEW}/verify`,
          status: 503,
          body: { statusCode: 503, name: "internal_server_error", message: "Unavailable" },
        },
      ]);
      await expect(
        domain("update", {
          id: ID,
          desired: { name: "example.com", region: "eu-west-1" },
          expect: { action: "replace", replace: ["region"] },
        }),
      ).rejects.toMatchObject({ name: "DriverError", retryable: true, status: 503 });
    });

    it("imports by name through every page of the account's domains", async () => {
      const other = { id: "00000000-0000-4000-8000-0000000000ff", name: "other.example" };
      play("import-pages", [
        {
          method: "GET",
          path: "/domains?limit=100",
          status: 200,
          body: { object: "list", has_more: true, data: [other] },
        },
        {
          method: "GET",
          path: `/domains?limit=100&after=${other.id}`,
          status: 200,
          body: { object: "list", has_more: false, data: [{ id: ID, name: "example.com" }] },
        },
        got(),
      ]);
      expect(await domain("import", { id: "example.com" })).toMatchObject({ id: ID, gone: false });
    });

    it("answers gone for a name the account has not, an id Resend has not, and a delete of one gone", async () => {
      play("gone", [
        { method: "GET", path: "/domains?limit=100", status: 200, body: { object: "list", has_more: false, data: [] } },
        notFound("GET"),
        notFound("GET"),
        notFound("DELETE"),
      ]);
      expect(await domain("import", { id: "example.com" })).toEqual({ id: "example.com", gone: true });
      expect(await domain("import", { id: ID })).toEqual({ id: ID, gone: true });
      expect(await domain("read", { id: ID })).toEqual({ id: ID, gone: true });
      expect(await domain("delete", { id: ID })).toEqual({ id: ID, gone: true });
    });

    it("refuses a name another account holds, saying so", async () => {
      const [registered] = (fixture("create-a-domain-twice") as Exchange[]).filter((e) => e.status === 403);
      play("another-account", [
        registered!,
        { method: "GET", path: "/domains?limit=100", status: 200, body: { object: "list", has_more: false, data: [] } },
      ]);
      await expect(domain("create", { desired: { name: "example.com" } })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        vendorCode: "registered",
        message: expect.stringContaining("another Resend account holds example.com"),
      });
    });

    it("says a sending-only key cannot manage domains", async () => {
      play("domain-restricted-key");
      await expect(domain("create", { desired: { name: "example.com" } })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 401,
        vendorCode: "restricted_api_key",
        message:
          "resend: domain.create needs a full-access API key in RESEND_API_KEY: This API key is restricted to only send emails.",
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
