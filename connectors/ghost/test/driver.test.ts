import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { type CallContext, DriverError } from "@sanoma/workflows";
import { ghostDriver } from "../src/driver.ts";
import type { ghost } from "../src/index.ts";

/*
 * Replays Ghost's recorded replies (test/fixtures/<name>.json) with msw. To run the same
 * tests against a real site, set GHOST_ADMIN_URL, GHOST_ADMIN_API_KEY and SANOMA_LIVE=1 (ignored in CI);
 * add SANOMA_RECORD=1 to rewrite the fixtures from its replies, scrubbed. The tests that
 * need Ghost to misbehave (429, 503, a timeout, a collision) only replay.
 */
const LIVE = process.env.SANOMA_LIVE === "1" && !process.env.CI;
const RECORD = LIVE && process.env.SANOMA_RECORD === "1";
const FIXTURES = new URL("./fixtures/", import.meta.url);
const SITE = "https://blog.example.test";
/** A made-up key: the recorded replies need none, but it signs the tokens the tests check. */
const TEST_KEY = `${"a1".repeat(12)}:${"b2".repeat(32)}`;
const ADMIN_URL = LIVE ? process.env.GHOST_ADMIN_URL : SITE;
const API = `${ADMIN_URL?.replace(/\/+$/, "")}/ghost/api/admin`;

type Post = z.output<typeof ghost.post.publish.output>;
/** One request and Ghost's reply; a fixture is a list of them, without `sent`. */
interface Exchange {
  method: string;
  /** After `/ghost/api/admin`, with the query. */
  path: string;
  status: number;
  body: unknown;
}
interface Sent {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  acceptVersion: string | null;
}

const call: CallContext = { idempotencyKey: "run-1:1", runId: "run-1", opId: "ghost.post", attempt: 1 };
const driver = ghostDriver();
const create = async (title: string, d = driver) =>
  (await d.ops["post.create"]!({ title, html: "<p>Written by a test.</p>", status: "draft" }, call)) as Post;
const publish = async (id: string, d = driver) => (await d.ops["post.publish"]!({ id }, call)) as Post;
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.fail("expected a DriverError"),
    (e: unknown) => e,
  );
const title = () => `sanoma test ${Date.now()}`;

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
};
const pathOf = (url: string) => url.slice(API.length);

// Every request the driver makes, and Ghost's replies (recorded or real), in order.
const server = setupServer();
let sent: Promise<Sent>[] = [];
let replies: Promise<Exchange>[] = [];
server.events.on("request:start", ({ request }) => {
  const r = request.clone();
  sent.push(
    r.text().then((text) => ({
      method: r.method,
      path: pathOf(r.url),
      body: parse(text),
      authorization: r.headers.get("authorization"),
      acceptVersion: r.headers.get("accept-version"),
    })),
  );
});
// A real reply reaches the listener as it came over the wire, compressed.
const unzip = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync } as Record<
  string,
  (b: Buffer) => Buffer
>;
for (const type of ["response:mocked", "response:bypass"] as const) {
  server.events.on(type, ({ request, response }) => {
    const res = response.clone();
    const decode = unzip[res.headers.get("content-encoding") ?? ""] ?? ((b: Buffer) => b);
    replies.push(
      res.arrayBuffer().then((raw) => ({
        method: request.method,
        path: pathOf(request.url),
        status: res.status,
        body: parse(decode(Buffer.from(raw)).toString("utf8")),
      })),
    );
  });
}
/** The requests sent so far, once each has its reply. */
const requests = async () => {
  await vi.waitFor(() => expect(replies).toHaveLength(sent.length));
  return Promise.all(sent);
};

let cassette: Exchange[] | undefined;
let recording: string | undefined;
let unexpected: string[] = [];
const fixture = (name: string): Exchange[] => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));

/** Serves `exchanges` (by default the fixture `name`) in order, or, live, records the test's exchanges as `name`. */
function play(name: string, exchanges?: Exchange[]) {
  if (LIVE) {
    if (RECORD) recording = name;
    return;
  }
  const queue = (cassette = [...(exchanges ?? fixture(name))]);
  server.use(
    http.all(`${API}/*`, ({ request }) => {
      const got = `${request.method} ${pathOf(request.url)}`;
      const next = queue[0];
      if (!next || `${next.method} ${next.path}` !== got) {
        unexpected.push(got);
        return HttpResponse.json({ errors: [{ message: `not in the fixture: ${got}` }] }, { status: 400 });
      }
      queue.shift();
      return typeof next.body === "string"
        ? new HttpResponse(next.body, { status: next.status, headers: { "Content-Type": "text/html" } })
        : HttpResponse.json(next.body as any, { status: next.status });
    }),
  );
}

// What a fixture keeps of Ghost's replies: no authors, emails, tiers or settings.
const POST_FIELDS = [
  "id",
  "uuid",
  "title",
  "slug",
  "html",
  "status",
  "url",
  "created_at",
  "updated_at",
  "published_at",
];
const ERROR_FIELDS = ["message", "context", "type", "code", "id"];
const pick = (o: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));

/** Replaces each distinct string it is given with `make(1)`, `make(2)`, ... in order of appearance. */
const renumber = (make: (n: number) => string) => {
  const seen = new Map<string, string>();
  return (real: string) => {
    if (!seen.has(real)) seen.set(real, make(seen.size + 1));
    return seen.get(real)!;
  };
};

/** Keeps the fields above, puts every URL on SITE, and numbers the ids and uuids in order of appearance. */
function scrub(exchanges: Exchange[]): Exchange[] {
  const trimmed = exchanges.map((e) => {
    const body = e.body as { posts?: Record<string, unknown>[]; errors?: Record<string, unknown>[] } | null;
    if (body?.posts) return { ...e, body: { posts: body.posts.map((p) => pick(p, POST_FIELDS)) } };
    if (body?.errors) return { ...e, body: { errors: body.errors.map((x) => pick(x, ERROR_FIELDS)) } };
    return e;
  });
  return JSON.parse(
    JSON.stringify(trimmed)
      .replace(/https?:\/\/[^/"\s]+/g, SITE)
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        renumber((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
      )
      .replace(
        /\b[0-9a-f]{24}\b/g,
        renumber((n) => String(n).padStart(24, "0")),
      ),
  );
}

beforeAll(() => {
  if (LIVE && (!process.env.GHOST_ADMIN_URL || !process.env.GHOST_ADMIN_API_KEY)) {
    throw new Error("SANOMA_LIVE=1 needs GHOST_ADMIN_URL and GHOST_ADMIN_API_KEY");
  }
  server.listen({ onUnhandledFrame: LIVE ? "bypass" : "error" });
});

beforeEach(() => {
  if (!LIVE) {
    vi.stubEnv("GHOST_ADMIN_URL", SITE);
    vi.stubEnv("GHOST_ADMIN_API_KEY", TEST_KEY);
  }
});

const created: string[] = [];
afterEach(async () => {
  const done = await Promise.all(replies);
  for (const r of done) {
    const id = (r.body as { posts?: { id: string }[] } | null)?.posts?.[0]?.id;
    if (r.method === "POST" && id) created.push(id);
  }
  if (recording) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(new URL(`${recording}.json`, FIXTURES), `${JSON.stringify(scrub(done), null, 2)}\n`);
  }
  const [unused, extra] = [cassette ?? [], unexpected];
  [sent, replies, unexpected, cassette, recording] = [[], [], [], undefined, undefined];
  server.resetHandlers();
  vi.unstubAllEnvs();
  const stray = [
    ...unused.map((e) => `not made: ${e.method} ${e.path}`),
    ...extra.map((r) => `not in the fixture: ${r}`),
  ];
  if (stray.length) throw new Error(`the requests differ from the fixture:\n${stray.join("\n")}`);
});

afterAll(async () => {
  // Live, delete the posts the tests made, with a token signed as the driver signs one.
  if (LIVE && created.length) {
    const [id, secret] = process.env.GHOST_ADMIN_API_KEY!.split(":") as [string, string];
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: id, typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setAudience("/admin/")
      .sign(Buffer.from(secret, "hex"));
    for (const post of new Set(created)) {
      await fetch(`${API}/posts/${post}/`, { method: "DELETE", headers: { Authorization: `Ghost ${token}` } });
    }
  }
  server.close();
});

describe("ghostDriver", () => {
  it("creates a draft from HTML, with a five-minute HS256 token for /admin/", async () => {
    play("create");
    const name = title();
    const post = await create(name);
    expect(post).toMatchObject({ status: "draft", publishedAt: null });
    expect(URL.canParse(post.url)).toBe(true);

    const [req] = await requests();
    expect(req).toMatchObject({
      method: "POST",
      path: "/posts/?source=html",
      acceptVersion: "v5.0",
      body: { posts: [{ title: name, html: "<p>Written by a test.</p>", status: "draft" }] },
    });
    const token = req!.authorization!.replace(/^Ghost /, "");
    const [kid, secret] = process.env.GHOST_ADMIN_API_KEY!.split(":") as [string, string];
    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", kid, typ: "JWT" });
    const { payload } = await jwtVerify(token, Buffer.from(secret, "hex"), {
      algorithms: ["HS256"],
      audience: "/admin/",
    });
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("publishes a draft: reads it, then saves it with the updated_at it read", async () => {
    play("publish-draft");
    const draft = await create(title());
    const post = await publish(draft.id);
    expect(post).toMatchObject({ id: draft.id, status: "published", slug: draft.slug });
    expect(post.publishedAt).toEqual(expect.any(String));

    const reqs = await requests();
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /posts/?source=html",
      `GET /posts/${draft.id}/`,
      `PUT /posts/${draft.id}/`,
    ]);
    const read = (await replies[1]!).body as { posts: [{ updated_at: string }] };
    expect(reqs[2]!.body).toEqual({ posts: [{ status: "published", updated_at: read.posts[0].updated_at }] });
  });

  it("returns a post that is already published as it is, without saving it", async () => {
    play("publish-again");
    const { id } = await create(title());
    const first = await publish(id);
    expect(await publish(id)).toEqual(first);
    expect((await requests()).map((r) => r.method)).toEqual(["POST", "GET", "PUT", "GET"]);
  });

  it("does not retry a post Ghost refuses, and keeps its status and error type", async () => {
    play("invalid");
    const err = await failure(create("x".repeat(300)));
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ retryable: false, status: 422, vendorCode: "ValidationError" });
    expect((err as Error).message).toContain("posts.title");
  });

  it("does not retry a key Ghost does not know", async () => {
    play("unauthorized");
    vi.stubEnv("GHOST_ADMIN_API_KEY", TEST_KEY);
    const err = await failure(create(title()));
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ retryable: false, status: 401 });
  });

  it("names the variable that is missing or malformed, and sends nothing", async () => {
    for (const [name, value, says] of [
      ["GHOST_ADMIN_URL", "", "GHOST_ADMIN_URL is not set"],
      ["GHOST_ADMIN_URL", "example.ghost.io", "GHOST_ADMIN_URL is not a URL"],
      ["GHOST_ADMIN_API_KEY", "", "GHOST_ADMIN_API_KEY is not set"],
      ["GHOST_ADMIN_API_KEY", "abc:def", "GHOST_ADMIN_API_KEY is not an Admin API key"],
    ] as const) {
      vi.stubEnv(name, value);
      const err = await failure(create(title()));
      expect(err).toBeInstanceOf(DriverError);
      expect(err).toMatchObject({ retryable: false, message: expect.stringContaining(says) });
      vi.unstubAllEnvs();
      if (!LIVE) {
        vi.stubEnv("GHOST_ADMIN_URL", SITE);
        vi.stubEnv("GHOST_ADMIN_API_KEY", TEST_KEY);
      }
    }
    expect(sent).toEqual([]);
  });

  describe.skipIf(LIVE)("when Ghost misbehaves", () => {
    const [, read, saved] = LIVE ? [] : fixture("publish-draft");
    const conflict = LIVE ? undefined : fixture("update-collision")[0];
    const draft = (read?.body as { posts: [{ id: string; updated_at: string }] } | undefined)?.posts[0];

    it.each([
      [429, { errors: [{ message: "Too many requests.", type: "TooManyRequestsError" }] }],
      [503, "<html><body>503 Service Unavailable</body></html>"],
    ])("retries a %i", async (status, body) => {
      play("misbehaves", [{ method: "POST", path: "/posts/?source=html", status, body }]);
      const err = await failure(create(title()));
      expect(err).toBeInstanceOf(DriverError);
      expect(err).toMatchObject({ retryable: true, status });
    });

    it("retries a request Ghost does not answer in time", async () => {
      server.use(http.all(`${API}/*`, () => delay("infinite")));
      const err = await failure(create(title(), ghostDriver({ timeoutMs: 20 })));
      expect(err).toBeInstanceOf(DriverError);
      expect(err).toMatchObject({ retryable: true, message: expect.stringContaining("no reply in 20 ms") });
    });

    it("reads the post again after an update collision, and saves it with the newer updated_at", async () => {
      const later = "2030-01-01T00:00:00.000Z";
      const reread = { ...read!, body: { posts: [{ ...draft!, updated_at: later }] } };
      play("collision", [read!, { ...conflict!, path: saved!.path }, reread, saved!]);
      expect(await publish(draft!.id)).toMatchObject({ status: "published" });
      const reqs = await requests();
      expect(reqs.map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
      expect(reqs[3]!.body).toEqual({ posts: [{ status: "published", updated_at: later }] });
    });

    it("gives up after a second collision, without a retry", async () => {
      play("collisions", [read!, { ...conflict!, path: saved!.path }, read!, { ...conflict!, path: saved!.path }]);
      const err = await failure(publish(draft!.id));
      expect(err).toBeInstanceOf(DriverError);
      expect(err).toMatchObject({ retryable: false, status: 409, vendorCode: "UPDATE_COLLISION" });
    });
  });
});
