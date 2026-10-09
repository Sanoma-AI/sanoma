import { DriverError, defineDriver, retryableStatus } from "@sanoma/workflows";
import { SignJWT } from "jose";
import { z } from "zod";
import { ghost, Post } from "./index.ts";

/*
 * The Ghost Admin API driver: https://docs.ghost.org/admin-api/
 *
 * Plain `fetch` with a JWT signed by `jose`. The official `@tryghost/admin-api` client ships
 * no types, depends on axios and jsonwebtoken, takes no abort signal, and drops the HTTP
 * status from the errors it throws, which is what decides whether a call may be retried.
 */

export interface GhostDriverOptions {
  /** How long one request to Ghost may take, in milliseconds. Default 10 000. */
  timeoutMs?: number;
}

/** The minimum API version the driver needs: Ghost 5 and later answer it. */
const ACCEPT_VERSION = "v5.0";

/** Ghost's post object, as far as the driver reads it: the connector's `Post`, in Ghost's names. */
const GhostPost = Post.omit({ publishedAt: true }).extend({
  published_at: z.string().nullable(),
  updated_at: z.string(),
});
type GhostPost = z.infer<typeof GhostPost>;

/** Ghost wraps the post it creates, reads or saves in a list of one. */
const GhostPosts = z.object({ posts: z.tuple([GhostPost]) });

/** Ghost's error body, `{ errors: [{ message, type, code, context, ... }] }`: the driver reads the first. */
const GhostErrors = z.object({
  errors: z.array(
    z.object({
      message: z.string(),
      type: z.string().optional(),
      code: z.string().nullish(),
      // Which field failed, and sometimes the message again.
      context: z.string().nullish(),
    }),
  ),
});

const out = (post: GhostPost) => ({
  id: post.id,
  url: post.url,
  slug: post.slug,
  status: post.status,
  publishedAt: post.published_at,
});

const misconfigured = (message: string) => new DriverError(`ghost: ${message}`, { retryable: false });

const ADMIN_API_KEY = /^([0-9a-f]{24}):([0-9a-f]{64})$/i;

/**
 * A token for the Admin API, signed with an Admin API key (`<id>:<secret>`), as Ghost asks:
 * HS256, for `/admin/`, valid five minutes, the longest Ghost accepts.
 */
export async function adminToken(key: string): Promise<string> {
  const [, id, secret] = ADMIN_API_KEY.exec(key) ?? [];
  if (!id || !secret) {
    throw misconfigured("GHOST_ADMIN_API_KEY is not an Admin API key (<24 hex digits>:<64 hex digits>)");
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: id, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setAudience("/admin/")
    .sign(Buffer.from(secret, "hex"));
}

/** Reads the credentials, when an operation is called, and returns a function that sends one request. */
function connect(timeoutMs: number) {
  const url = process.env.GHOST_ADMIN_URL;
  const key = process.env.GHOST_ADMIN_API_KEY;
  if (!url) throw misconfigured("GHOST_ADMIN_URL is not set (the site's admin URL, such as https://example.ghost.io)");
  if (!URL.canParse(url)) throw misconfigured("GHOST_ADMIN_URL is not a URL");
  if (!key) throw misconfigured("GHOST_ADMIN_API_KEY is not set (a custom integration's Admin API key)");
  const base = `${url.replace(/\/+$/, "")}/ghost/api/admin`;

  return async (method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<GhostPost> => {
    // Each request gets its own token: one lasts at most five minutes.
    const token = await adminToken(key);
    const where = `${method} ${path}`;
    let status: number;
    let json: unknown;
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Ghost ${token}`,
          "Accept-Version": ACCEPT_VERSION,
          "Content-Type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      status = res.status;
      // A body that is not JSON (a proxy's HTML error page) is no answer to read; a body cut off is.
      json = await res.json().catch((err: unknown) => {
        if (err instanceof SyntaxError) return undefined;
        throw err;
      });
    } catch (cause) {
      // No answer: the request may or may not have reached Ghost.
      const why = (cause as Error).name === "TimeoutError" ? `no reply in ${timeoutMs} ms` : "the request failed";
      throw new DriverError(`ghost: ${where}: ${why}`, { retryable: true, cause });
    }
    if (status < 200 || status >= 300) {
      const err = GhostErrors.safeParse(json).data?.errors[0];
      const detail = err?.context && err.context !== err.message ? ` ${err.context}` : "";
      const message = err ? `${err.message}${detail}` : `HTTP ${status}`;
      throw new DriverError(`ghost: ${where}: ${message}`, {
        retryable: retryableStatus(status),
        status,
        vendorCode: err?.code ?? err?.type,
      });
    }
    const parsed = GhostPosts.safeParse(json);
    if (!parsed.success) {
      throw new DriverError(`ghost: ${where}: the reply is not a post; is GHOST_ADMIN_URL the site's admin URL?`, {
        retryable: false,
        status,
        cause: parsed.error,
      });
    }
    return parsed.data.posts[0];
  };
}

/** The real Ghost, through the Admin API, with `GHOST_ADMIN_URL` and `GHOST_ADMIN_API_KEY`. See the README. */
export function ghostDriver(options: GhostDriverOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return defineDriver(ghost, {
    post: {
      create: async ({ title, html, status }) => {
        const send = connect(timeoutMs);
        return out(await send("POST", "/posts/?source=html", { posts: [{ title, html, status }] }));
      },
      publish: async ({ id }) => {
        const send = connect(timeoutMs);
        const path = `/posts/${encodeURIComponent(id)}/`;
        const save = async () => {
          const post = await send("GET", path);
          // Published already, or sent as an email only: it is no draft to publish.
          if (post.status === "published" || post.status === "sent") return post;
          return send("PUT", path, { posts: [{ status: "published", updated_at: post.updated_at }] });
        };
        // Ghost refuses a save whose `updated_at` is not the post's latest (UPDATE_COLLISION):
        // someone saved it in between. Read it again and save once more.
        const post = await save().catch((err: unknown) => {
          if (err instanceof DriverError && err.vendorCode === "UPDATE_COLLISION") return save();
          throw err;
        });
        return out(post);
      },
    },
  });
}
