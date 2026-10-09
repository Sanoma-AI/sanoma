import { readFileSync, writeFileSync } from "node:fs";
import type { CallContext, DriverError } from "@sanoma/workflows";
import { bypass, delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blueskyDriver, type BlueskyDriverOptions } from "../src/driver.ts";

/*
 * Replays the XRPC replies in fixtures/ by default. With SANOMA_LIVE=1 (ignored in CI), BLUESKY_IDENTIFIER
 * and BLUESKY_APP_PASSWORD set, the tests that Bluesky can reproduce post to that account instead,
 * and SANOMA_RECORD=1 rewrites their fixtures from the replies, scrubbed of the account.
 */
const live = process.env.SANOMA_LIVE === "1" && !process.env.CI;
const recording = live && process.env.SANOMA_RECORD === "1";
const fixtures = new URL("./fixtures/", import.meta.url);

interface Fixture {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** The XRPC calls the driver made in this test, with the JSON body of each procedure. */
const sent: { nsid: string; body?: any }[] = [];

/**
 * Answers `nsid` with the named fixtures, one per request (the last repeats). `{rkey}` in a
 * fixture is the record key the request named. Live, forwards to Bluesky instead, and when
 * recording, saves each reply under the name it would be replayed from.
 */
function xrpc(nsid: string, ...names: string[]) {
  let count = 0;
  return http.all(`*/xrpc/${nsid}`, async ({ request }) => {
    const name = names[Math.min(count++, names.length - 1)]!;
    const body = request.method === "POST" ? ((await request.clone().json()) as any) : undefined;
    sent.push({ nsid, body });
    const rkey: string = body?.rkey ?? new URL(request.url).searchParams.get("rkey") ?? "";
    if (live) {
      const res = await fetch(bypass(request));
      if (recording) await save(name, res.clone(), rkey);
      return res;
    }
    const fixture: Fixture = JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8"));
    const reply = JSON.parse(JSON.stringify(fixture.body).replaceAll("{rkey}", rkey));
    return HttpResponse.json(reply, { status: fixture.status, headers: fixture.headers });
  });
}

/** What a recorded reply must not keep, and what replaces it. Filled from the live account. */
const scrubs = new Map<string, string>();

async function save(name: string, res: Response, rkey: string) {
  const body = (await res.json()) as any;
  if (body.did) scrubs.set(body.did, "did:plc:example");
  if (body.handle) scrubs.set(body.handle, "alice.example.test");
  if (body.email) scrubs.set(body.email, "alice@example.test");
  if (rkey) scrubs.set(rkey, "{rkey}");
  const headers = Object.fromEntries([...res.headers].filter(([k]) => k.startsWith("ratelimit-")));
  let text = JSON.stringify({ status: res.status, ...(Object.keys(headers).length ? { headers } : {}), body }, null, 2);
  for (const [secret, placeholder] of scrubs) text = text.replaceAll(secret, placeholder);
  text = text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "example.jwt")
    .replace(/did:plc:[a-z2-7]{24}/g, "did:plc:example")
    .replace(/\bbafy[a-z2-7]{50,}/g, "bafyreihclbg5r7bdqu5lq3ulxnjalvh3a6nztvr7gp7u56xr4yn6qahpme")
    .replace(/https:\/\/[\w.-]+\.host\.bsky\.network/g, "https://pds.example.test")
    .replace(/"publicKeyMultibase": "[^"]+"/g, '"publicKeyMultibase": "zExamplePublicKey"');
  for (const secret of scrubs.keys()) if (text.includes(secret)) throw new Error(`${name}: scrubbing left a secret`);
  writeFileSync(new URL(`${name}.json`, fixtures), `${text}\n`);
}

const server = setupServer();
beforeAll(() => {
  if (live && (!process.env.BLUESKY_IDENTIFIER || !process.env.BLUESKY_APP_PASSWORD)) {
    throw new Error("SANOMA_LIVE=1 needs BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD");
  }
  // Live, the credentials are scrubbed from recordings too.
  if (recording) {
    scrubs.set(process.env.BLUESKY_IDENTIFIER!, "alice.example.test");
    scrubs.set(process.env.BLUESKY_APP_PASSWORD!, "example-app-password");
  }
  server.listen({ onUnhandledFrame: live ? "bypass" : "error" });
});
beforeEach(() => {
  if (live) return;
  vi.stubEnv("BLUESKY_IDENTIFIER", "alice.example.test");
  vi.stubEnv("BLUESKY_APP_PASSWORD", "example-app-password");
  vi.stubEnv("BLUESKY_SERVICE", "https://bsky.example.test");
});
afterEach(() => {
  server.resetHandlers();
  sent.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

const runId = live ? `live-${Date.now()}` : "run-1";
const call = (seq: number): CallContext => ({
  idempotencyKey: `${runId}:${seq}`,
  runId,
  opId: "bluesky.post.create",
  attempt: 1,
});
const at = live ? new Date().toISOString() : "2026-10-08T00:00:00.000Z";
const text = `Sanoma driver test ${at} https://example.com`;

function postCreate(options?: BlueskyDriverOptions) {
  return blueskyDriver(options).ops["post.create"]!;
}
const sentTo = (nsid: string) => sent.filter((s) => s.nsid === nsid);

describe("blueskyDriver", () => {
  it("logs in, posts the text with a facet for its link, and returns the post", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord"),
    );
    const out = await postCreate()({ text }, call(0));

    const req = sentTo("com.atproto.repo.createRecord")[0]?.body;
    expect(req).toMatchObject({ collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text } });
    const byteStart = Buffer.byteLength(text.slice(0, text.indexOf("https://")));
    expect(req.record.facets).toMatchObject([
      {
        index: { byteStart, byteEnd: byteStart + "https://example.com".length },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
      },
    ]);
    // A TID: 13 base32-sortable characters, the first with its top bit clear.
    expect(req.rkey).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    expect(out).toEqual({
      uri: `at://${req.repo}/app.bsky.feed.post/${req.rkey}`,
      cid: expect.stringMatching(/^bafy[a-z2-7]+$/),
      url: expect.stringMatching(new RegExp(`^https://bsky\\.app/profile/[^/]+/post/${req.rkey}$`)),
    });
  });

  it("keeps one session across calls", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord"),
    );
    const create = postCreate();
    await create({ text: `${text} (1)` }, call(1));
    await create({ text: `${text} (2)` }, call(2));
    expect(sentTo("com.atproto.server.createSession")).toHaveLength(1);
    expect(sentTo("com.atproto.repo.createRecord")).toHaveLength(2);
  });

  it("posts once for one idempotency key: a repeat returns the post the first made", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord", "createRecord-repeated"),
      xrpc("com.atproto.repo.getRecord", "getRecord"),
    );
    const create = postCreate();
    const first = await create({ text }, call(3));
    // A worker that crashed before checkpointing the reply runs the call again.
    const again = await create({ text }, call(3));
    expect(again).toEqual(first);
    const [one, two] = sentTo("com.atproto.repo.createRecord");
    expect(two?.body.rkey).toBe(one?.body.rkey);
  });

  it.skipIf(live)("refuses a reused key that holds a different post, without retrying", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord-repeated"),
      xrpc("com.atproto.repo.getRecord", "getRecord"),
    );
    await expect(postCreate()({ text: "Something else" }, call(4))).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      message: expect.stringMatching(/already has a different post/),
    });
  });

  it.skipIf(live)("drops a mention whose handle does not resolve", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.identity.resolveHandle", "resolveHandle-not-found"),
      xrpc("com.atproto.repo.createRecord", "createRecord"),
    );
    await postCreate()({ text: "Hello @nobody.example.test" }, call(5));
    expect(sentTo("com.atproto.repo.createRecord")[0]?.body.record.facets).toEqual([]);
  });

  it.skipIf(live)("fails without retrying when Bluesky refuses the post (400), and does not look for it", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord-invalid"),
    );
    await expect(postCreate()({ text }, call(6))).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      status: 400,
      vendorCode: "InvalidRequest",
      message: expect.stringMatching(/must not be longer than 300 graphemes/),
    });
    expect(sentTo("com.atproto.repo.getRecord")).toEqual([]);
  });

  it.skipIf(live)(
    "fails as retryable, with the read-back's error, when a failed post cannot be read back",
    async () => {
      server.use(
        xrpc("com.atproto.server.createSession", "createSession"),
        xrpc("com.atproto.repo.createRecord", "createRecord-repeated"),
        http.get("*/xrpc/com.atproto.repo.getRecord", () =>
          HttpResponse.json({ error: "UpstreamFailure", message: "Upstream Failure" }, { status: 502 }),
        ),
      );
      const err = (await postCreate()({ text }, call(12)).catch((e) => e)) as DriverError;
      expect(err).toMatchObject({
        name: "DriverError",
        retryable: true,
        message: "Bluesky post failed, and reading it back failed too: Upstream Failure",
        cause: { status: 502, error: "UpstreamFailure" },
      });
    },
  );

  it.skipIf(live)("fails as retryable when rate limited (429), saying when the limit resets", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord-rate-limited"),
      xrpc("com.atproto.repo.getRecord", "getRecord-not-found"),
    );
    await expect(postCreate()({ text }, call(7))).rejects.toMatchObject({
      name: "DriverError",
      retryable: true,
      status: 429,
      vendorCode: "RateLimitExceeded",
      message: expect.stringMatching(/the limit resets at 2026-10-09T00:00:00.000Z/),
    });
  });

  it.skipIf(live)("fails as retryable on a 5xx (502)", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      xrpc("com.atproto.repo.createRecord", "createRecord-bad-gateway"),
      xrpc("com.atproto.repo.getRecord", "getRecord-not-found"),
    );
    await expect(postCreate()({ text }, call(8))).rejects.toMatchObject({
      name: "DriverError",
      retryable: true,
      status: 502,
      vendorCode: "UpstreamFailure",
    });
  });

  it.skipIf(live)("fails as retryable when Bluesky does not answer in time", async () => {
    server.use(
      xrpc("com.atproto.server.createSession", "createSession"),
      http.post("*/xrpc/com.atproto.repo.createRecord", () => delay("infinite")),
      xrpc("com.atproto.repo.getRecord", "getRecord-not-found"),
    );
    const err = (await postCreate({ timeoutMs: 100 })({ text }, call(9)).catch((e) => e)) as DriverError;
    expect(err).toMatchObject({ name: "DriverError", retryable: true, message: "Bluesky post timed out after 100 ms" });
    expect(err.status).toBeUndefined();
  });

  it.skipIf(live)("fails without retrying when the app password is wrong (401)", async () => {
    server.use(xrpc("com.atproto.server.createSession", "createSession-invalid-password"));
    await expect(postCreate()({ text }, call(10))).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      status: 401,
      vendorCode: "AuthenticationRequired",
    });
  });

  it("names a missing environment variable, without calling Bluesky", async () => {
    vi.stubEnv("BLUESKY_APP_PASSWORD", "");
    await expect(postCreate()({ text }, call(11))).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      message: "BLUESKY_APP_PASSWORD is not set: the Bluesky driver needs it",
    });
    expect(sent).toEqual([]);
  });
});
