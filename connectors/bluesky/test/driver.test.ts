import { type Exchange, live, replay } from "@sanoma/testing/replay";
import type { CallContext } from "@sanoma/workflows";
import { delay, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { blueskyDriver, type BlueskyDriverOptions } from "../src/driver.ts";
import { nsidOf, replayOptions } from "./replay.ts";

// Replays test/fixtures; the README says how to run these tests against an account.

const { server, play, fixture, sent } = replay(replayOptions);

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
