import { type Exchange, live, replay } from "@sanoma/testing/replay";
import type { CallContext } from "@sanoma/workflows";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { delay, http } from "msw";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { adminToken, ghostDriver } from "../src/driver.ts";
import type { ghost } from "../src/index.ts";

// Replays test/fixtures; the README says how to run these tests against a site.

const SITE = "https://blog.example.test";
const ADMIN = "/ghost/api/admin";
/** A made-up key: the recorded replies need none, but it signs the tokens the tests check. */
const TEST_KEY = `${"a1".repeat(12)}:${"b2".repeat(32)}`;

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

const { server, play, fixture, sent, exchanges } = replay({
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["GHOST_ADMIN_URL", "GHOST_ADMIN_API_KEY"],
  env: { GHOST_ADMIN_URL: SITE, GHOST_ADMIN_API_KEY: TEST_KEY },
  scrub,
});

type Post = z.output<typeof ghost.post.publish.output>;
const call: CallContext = { idempotencyKey: "run-1:1", runId: "run-1", opId: "ghost.post", attempt: 1 };
const created: string[] = [];
const create = async (title: string, driver = ghostDriver()) => {
  const post = (await driver.ops["post.create"]!(
    { title, html: "<p>Written by a test.</p>", status: "draft" },
    call,
  )) as Post;
  created.push(post.id);
  return post;
};
const publish = async (id: string) => (await ghostDriver().ops["post.publish"]!({ id }, call)) as Post;
const title = () => `sanoma test ${Date.now()}`;

afterAll(async () => {
  // Live, delete the posts the tests made, with a token signed as the driver signs one.
  if (!live || !created.length) return;
  const token = await adminToken(process.env.GHOST_ADMIN_API_KEY!);
  const api = `${process.env.GHOST_ADMIN_URL!.replace(/\/+$/, "")}${ADMIN}`;
  for (const id of new Set(created)) {
    await fetch(`${api}/posts/${id}/`, { method: "DELETE", headers: { Authorization: `Ghost ${token}` } });
  }
});

/** A draft's read and save, from publish-draft, and Ghost's answer to a save that collides. */
function publishing() {
  const [, read, saved] = fixture("publish-draft") as [Exchange, Exchange, Exchange];
  const [conflict] = fixture("update-collision") as [Exchange];
  const draft = (read.body as { posts: [{ id: string; updated_at: string }] }).posts[0];
  return { read, saved, conflict, draft };
}

describe("ghostDriver", () => {
  it("creates a draft from HTML, with a five-minute HS256 token for /admin/", async () => {
    play("create");
    const name = title();
    const post = await create(name);
    expect(post).toMatchObject({ status: "draft", publishedAt: null });
    expect(URL.canParse(post.url)).toBe(true);

    const [req] = sent;
    expect(req).toMatchObject({
      method: "POST",
      path: `${ADMIN}/posts/?source=html`,
      body: { posts: [{ title: name, html: "<p>Written by a test.</p>", status: "draft" }] },
    });
    expect(req!.headers.get("accept-version")).toBe("v5.0");
    const token = req!.headers.get("authorization")!.replace(/^Ghost /, "");
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

    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${ADMIN}/posts/?source=html`,
      `GET ${ADMIN}/posts/${draft.id}/`,
      `PUT ${ADMIN}/posts/${draft.id}/`,
    ]);
    const read = exchanges[1]!.body as { posts: [{ updated_at: string }] };
    expect(sent[2]!.body).toEqual({ posts: [{ status: "published", updated_at: read.posts[0].updated_at }] });
  });

  it("returns a post that is already published as it is, without saving it", async () => {
    play("publish-again");
    const { id } = await create(title());
    const first = await publish(id);
    expect(await publish(id)).toEqual(first);
    expect(sent.map((r) => r.method)).toEqual(["POST", "GET", "PUT", "GET"]);
  });

  it("does not retry a post Ghost refuses, and keeps its status and error type", async () => {
    play("invalid");
    await expect(create("x".repeat(300))).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      status: 422,
      vendorCode: "ValidationError",
      message: expect.stringContaining("posts.title"),
    });
  });

  it("does not retry a key Ghost does not know", async () => {
    play("unauthorized");
    vi.stubEnv("GHOST_ADMIN_API_KEY", TEST_KEY);
    await expect(create(title())).rejects.toMatchObject({ name: "DriverError", retryable: false, status: 401 });
  });

  it.each([
    ["GHOST_ADMIN_URL", "", "GHOST_ADMIN_URL is not set"],
    ["GHOST_ADMIN_URL", "example.ghost.io", "GHOST_ADMIN_URL is not a URL"],
    ["GHOST_ADMIN_API_KEY", "", "GHOST_ADMIN_API_KEY is not set"],
    ["GHOST_ADMIN_API_KEY", "abc:def", "GHOST_ADMIN_API_KEY is not an Admin API key"],
  ])("says %s is wrong when it is %j, and sends nothing", async (name, value, says) => {
    vi.stubEnv(name, value);
    await expect(create(title())).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      message: expect.stringContaining(says),
    });
    expect(sent).toEqual([]);
  });

  describe.skipIf(live)("when Ghost misbehaves", () => {
    it.each([
      [408, "<html><body>408 Request Timeout</body></html>"],
      [429, { errors: [{ message: "Too many requests.", type: "TooManyRequestsError" }] }],
      [503, "<html><body>503 Service Unavailable</body></html>"],
    ])("retries a %i", async (status, body) => {
      play("misbehaves", [{ method: "POST", path: `${ADMIN}/posts/?source=html`, status, body }]);
      await expect(create(title())).rejects.toMatchObject({ name: "DriverError", retryable: true, status });
    });

    it("retries a request Ghost does not answer in time", async () => {
      server.use(http.all("*", () => delay("infinite")));
      await expect(create(title(), ghostDriver({ timeoutMs: 20 }))).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        message: expect.stringContaining("no reply in 20 ms"),
      });
    });

    it("returns a post sent as an email only as it is, without saving it", async () => {
      const { read, draft } = publishing();
      play("sent", [{ ...read, body: { posts: [{ ...draft, status: "sent" }] } }]);
      expect(await publish(draft.id)).toMatchObject({ id: draft.id, status: "sent" });
      expect(sent.map((r) => r.method)).toEqual(["GET"]);
    });

    it("reads the post again after an update collision, and saves it with the newer updated_at", async () => {
      const { read, saved, conflict, draft } = publishing();
      const later = "2030-01-01T00:00:00.000Z";
      const reread = { ...read, body: { posts: [{ ...draft, updated_at: later }] } };
      play("collision", [read, conflict, reread, saved]);
      expect(await publish(draft.id)).toMatchObject({ status: "published" });
      expect(sent.map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
      expect(sent[3]!.body).toEqual({ posts: [{ status: "published", updated_at: later }] });
    });

    it("gives up after a second collision, without a retry", async () => {
      const { read, conflict, draft } = publishing();
      play("collisions", [read, conflict, read, conflict]);
      await expect(publish(draft.id)).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 409,
        vendorCode: "UPDATE_COLLISION",
      });
    });
  });
});
