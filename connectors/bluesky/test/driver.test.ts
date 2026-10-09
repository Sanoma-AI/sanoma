import { type Exchange, live, replay, type Sent } from "@sanoma/testing/replay";
import type { CallContext } from "@sanoma/workflows";
import { delay, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { blueskyDriver, type BlueskyDriverOptions } from "../src/driver.ts";

// Replays test/fixtures; the README says how to run these tests against an account.

/** Strings of a kind a recording must not keep, whatever the account, and their placeholders. */
const patterns: [RegExp, string][] = [
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "example.jwt"],
  [/did:plc:[a-z2-7]{24}/g, "did:plc:example"],
  [/\bbafy[a-z2-7]{50,}/g, "bafyreihclbg5r7bdqu5lq3ulxnjalvh3a6nztvr7gp7u56xr4yn6qahpme"],
  [/https:\/\/[\w.-]+\.host\.bsky\.network/g, "https://pds.example.test"],
  // A post's record key, which differs on every live run: replaying, it is the request's.
  [/(?<=app\.bsky\.feed\.post\/|rkey=)[a-z2-7]{13}\b/g, "{rkey}"],
];
/** The fields of a successful reply the driver reads; the rest (the DID document, the email) is not kept. */
const keep: Record<string, string[]> = {
  "com.atproto.server.createSession": ["did", "handle", "accessJwt", "refreshJwt", "active"],
};
const nsidOf = (path: string) => path.slice("/xrpc/".length).split("?")[0]!;

/** The account's identifiers and hosts, the fields the driver does not read, and every string of a kind above. */
function scrub(exchanges: Exchange[]): Exchange[] {
  const { BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD, BLUESKY_SERVICE } = process.env;
  const secrets = new Map([
    [BLUESKY_IDENTIFIER!, "alice.example.test"],
    [BLUESKY_APP_PASSWORD!, "example-app-password"],
    ...(BLUESKY_SERVICE && URL.canParse(BLUESKY_SERVICE) ? [[new URL(BLUESKY_SERVICE).host, "bsky.example.test"]] : []),
  ] as [string, string][]);
  const kept = exchanges.map((e) => {
    const body = e.body as any;
    if (body?.did) secrets.set(body.did, "did:plc:example");
    if (body?.handle) secrets.set(body.handle, "alice.example.test");
    if (body?.email) secrets.set(body.email, "alice@example.test");
    for (const { serviceEndpoint } of body?.didDoc?.service ?? []) {
      if (URL.canParse(serviceEndpoint)) secrets.set(new URL(serviceEndpoint).host, "pds.example.test");
    }
    const fields = e.status < 300 ? keep[nsidOf(e.path)] : undefined;
    return fields ? { ...e, body: Object.fromEntries(fields.filter((k) => k in body).map((k) => [k, body[k]])) } : e;
  });
  let text = JSON.stringify(kept);
  // Longest first: a host inside a handle must not break the handle up before it is replaced.
  for (const [secret, placeholder] of [...secrets].toSorted(([a], [b]) => b.length - a.length)) {
    text = text.replaceAll(secret, placeholder);
  }
  for (const [pattern, placeholder] of patterns) text = text.replace(pattern, placeholder);
  const left = [
    ...[...secrets.keys()].filter((secret) => text.includes(secret)),
    ...patterns.flatMap(([pattern, placeholder]) => (text.match(pattern) ?? []).filter((m) => m !== placeholder)),
  ];
  if (left.length) throw new Error(`scrubbing left ${left.length} secret(s) in the recording`);
  return JSON.parse(text);
}

/** `{rkey}` in a fixture is the record key the request names. */
function fill(exchange: Exchange, sent: Sent): Exchange {
  const rkey: string | null = sent.body?.rkey ?? new URLSearchParams(sent.path.split("?")[1]).get("rkey");
  return rkey ? JSON.parse(JSON.stringify(exchange).replaceAll("{rkey}", rkey)) : exchange;
}

const { server, play, fixture, sent } = replay({
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"],
  env: {
    BLUESKY_IDENTIFIER: "alice.example.test",
    BLUESKY_APP_PASSWORD: "example-app-password",
    BLUESKY_SERVICE: "https://bsky.example.test",
  },
  scrub,
  fill,
});

const runId = live ? `live-${Date.now()}` : "run-1";
const call = (seq: number): CallContext => ({
  idempotencyKey: `${runId}:${seq}`,
  runId,
  opId: "bluesky.post.create",
  attempt: 1,
});
const at = live ? new Date().toISOString() : "2026-10-08T00:00:00.000Z";
const text = `Sanoma driver test ${at} https://example.com`;

const postCreate = (options?: BlueskyDriverOptions) => blueskyDriver(options).ops["post.create"]!;
const sentTo = (nsid: string) => sent.filter((r) => nsidOf(r.path) === nsid);
/** Exchanges recorded by the tests that run live, to compose the ones that only replay. */
const session = () => fixture("post")[0]!;
const repeated = () => fixture("repeat").slice(2) as [Exchange, Exchange];

describe("blueskyDriver", () => {
  it("logs in, posts the text with a facet for its link, and returns the post", async () => {
    play("post");
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
    play("two-posts");
    const create = postCreate();
    await create({ text: `${text} (1)` }, call(1));
    await create({ text: `${text} (2)` }, call(2));
    expect(sentTo("com.atproto.server.createSession")).toHaveLength(1);
    expect(sentTo("com.atproto.repo.createRecord")).toHaveLength(2);
  });

  it("posts once for one idempotency key: a repeat returns the post the first made", async () => {
    play("repeat");
    const create = postCreate();
    const first = await create({ text }, call(3));
    // A worker that crashed before checkpointing the reply runs the call again.
    const again = await create({ text }, call(3));
    expect(again).toEqual(first);
    const [one, two] = sentTo("com.atproto.repo.createRecord");
    expect(two?.body.rkey).toBe(one?.body.rkey);
  });

  describe.skipIf(live)("when Bluesky refuses or fails", () => {
    it("refuses a reused key that holds a different post, without retrying", async () => {
      play("different", [session(), ...repeated()]);
      await expect(postCreate()({ text: "Something else" }, call(4))).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: expect.stringMatching(/already has a different post/),
      });
    });

    it("drops a mention whose handle does not resolve", async () => {
      play("mention", [session(), ...fixture("resolveHandle-not-found"), fixture("post")[1]!]);
      await postCreate()({ text: "Hello @nobody.example.test" }, call(5));
      expect(sentTo("com.atproto.repo.createRecord")[0]?.body.record.facets).toEqual([]);
    });

    it.each([
      ["createRecord-invalid", false, 400, "InvalidRequest", /must not be longer than 300 graphemes/],
      ["createRecord-rate-limited", true, 429, "RateLimitExceeded", /the limit resets at 2026-10-09T00:00:00.000Z/],
      ["createRecord-bad-gateway", true, 502, "UpstreamFailure", /Upstream Failure/],
    ])("fails %s, retryable: %s", async (name, retryable, status, vendorCode, message) => {
      // A refused create (4xx but 429) made no record, so the driver does not look for one.
      const lookup = retryable ? fixture("getRecord-not-found") : [];
      play(name, [session(), ...fixture(name), ...lookup]);
      await expect(postCreate()({ text }, call(6))).rejects.toMatchObject({
        name: "DriverError",
        retryable,
        status,
        vendorCode,
        message: expect.stringMatching(message),
      });
    });

    it("fails without retrying when the app password is wrong (401)", async () => {
      play("createSession-invalid-password");
      await expect(postCreate()({ text }, call(10))).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 401,
        vendorCode: "AuthenticationRequired",
      });
    });

    it("fails retryable, with the read-back's error, when a failed post cannot be read back", async () => {
      const [failed, read] = repeated();
      const body = { error: "UpstreamFailure", message: "Upstream Failure" };
      play("unreadable", [session(), failed, { ...read, status: 502, body }]);
      await expect(postCreate()({ text }, call(12))).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        message: "Bluesky post failed, and reading it back failed too: Upstream Failure",
        cause: { status: 502, error: "UpstreamFailure" },
      });
    });

    it("fails retryable when Bluesky does not answer in time", async () => {
      play("timeout", [session(), ...fixture("getRecord-not-found")]);
      server.use(http.post("*/xrpc/com.atproto.repo.createRecord", () => delay("infinite")));
      await expect(postCreate({ timeoutMs: 100 })({ text }, call(9))).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        status: undefined,
        message: "Bluesky post timed out after 100 ms",
      });
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
