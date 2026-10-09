import { createHash } from "node:crypto";
import { Agent, AppBskyRichtextFacet, CredentialSession, RichText, XRPCError } from "@atproto/api";
import { TID } from "@atproto/common-web";
import { ResponseType } from "@atproto/xrpc";
import { defineDriver, DriverError, retryableStatus } from "@sanoma/workflows";
import { bluesky } from "./index.ts";

export interface BlueskyDriverOptions {
  /** How long one request to Bluesky may take, in ms, before the call fails as retryable. Default 10 000. */
  timeoutMs?: number;
}

/**
 * Posts to Bluesky with `@atproto/api`, signed in with an app password from the environment:
 * `BLUESKY_IDENTIFIER` (handle or email), `BLUESKY_APP_PASSWORD`, and optionally
 * `BLUESKY_SERVICE` (default `https://bsky.social`), read on each call.
 *
 * The session is kept in the driver and refreshed by `@atproto/api` when its access token
 * expires: Bluesky allows 30 logins per 5 minutes and 300 a day per account, fewer than a
 * long-lived worker may post.
 */
export function blueskyDriver(options: BlueskyDriverOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Every request, the login included, gets its own deadline. `fetch` is looked up per call.
  const timedFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    return fetch(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) });
  };
  let session: CredentialSession | undefined;
  let client: Agent | undefined;
  let login: Promise<unknown> | undefined;

  /** The signed-in agent, logging in when there is no session. */
  async function signIn() {
    const identifier = env("BLUESKY_IDENTIFIER");
    const password = env("BLUESKY_APP_PASSWORD");
    // One session for the driver's life, on the service the first call names.
    session ??= new CredentialSession(new URL(process.env.BLUESKY_SERVICE || "https://bsky.social"), timedFetch);
    client ??= new Agent(session);
    // No session yet, or a refresh found the refresh token expired or revoked. Concurrent
    // calls share one login.
    if (!session.session) {
      login ??= session.login({ identifier, password }).finally(() => (login = undefined));
      await login.catch((err) => {
        throw driverError(err, "login", timeoutMs);
      });
    }
    const data = session.session;
    if (!data) throw new DriverError("Bluesky login returned no session", { retryable: true });
    return { agent: client, did: data.did, handle: data.handle };
  }

  return defineDriver(bluesky, {
    post: {
      create: async ({ text }, call) => {
        const { agent, did, handle } = await signIn();
        const rt = new RichText({ text });
        await rt.detectFacets(agent);
        const record = {
          text: rt.text,
          // A mention of a handle that does not resolve keeps no DID, which the PDS refuses.
          facets: rt.facets?.filter((f) => f.features.every((x) => !AppBskyRichtextFacet.isMention(x) || x.did)),
          createdAt: new Date().toISOString(),
        };
        const rkey = rkeyFor(call.idempotencyKey);
        let ref: { uri: string; cid: string };
        try {
          ref = await agent.app.bsky.feed.post.create({ repo: did, rkey }, record);
        } catch (err) {
          // Refused outright: no record was made, so there is nothing to look for.
          if (err instanceof XRPCError && REFUSED.has(err.status)) throw driverError(err, "post", timeoutMs);
          // A repo holds one record per key, so a repeated create fails (Bluesky's PDS answers
          // 500). If this key's post exists, an earlier try of this call made it (its reply was
          // lost): return it. Only RecordNotFound says it does not; any other failure to read
          // it back leaves that unknown, so the call may be tried again.
          const existing = await agent.app.bsky.feed.post.get({ repo: did, rkey }).catch((lookup: unknown) => {
            if (lookup instanceof XRPCError && lookup.error === "RecordNotFound") return undefined;
            throw new DriverError(`Bluesky post failed, and reading it back failed too: ${(lookup as Error).message}`, {
              retryable: true,
              cause: lookup,
            });
          });
          if (!existing) throw driverError(err, "post", timeoutMs);
          if (existing.value.text !== text) {
            throw new DriverError(`Bluesky already has a different post at ${existing.uri}`, { retryable: false });
          }
          ref = existing;
        }
        // A handle that fails verification reads "handle.invalid"; the DID always resolves.
        const profile = handle === "handle.invalid" ? did : handle;
        return { uri: ref.uri, cid: ref.cid, url: `https://bsky.app/profile/${profile}/post/${rkey}` };
      },
    },
  });
}

/** A create that failed with one of these made no record: the request was bad or not allowed. */
const REFUSED = new Set([400, 401, 403]);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new DriverError(`${name} is not set: the Bluesky driver needs it`, { retryable: false });
  return value;
}

/**
 * The record key for a call: a TID (the key type `app.bsky.feed.post` declares) derived from
 * the idempotency key, so every try of one call names the same record and the repo cannot
 * hold it twice. Its timestamp bits are hash bits, kept at or above 2^50 so they encode to
 * the full 11 characters. A TID's timestamp is not validated anywhere in the network:
 * https://docs.bsky.app/docs/advanced-guides/timestamps
 *
 * Keys are as unique as run ids: the README says what happens when two calls share one.
 */
function rkeyFor(idempotencyKey: string): string {
  const hash = createHash("sha256").update(idempotencyKey).digest();
  const micros = 2 ** 50 + Number(hash.readBigUInt64BE(0) % BigInt(7 * 2 ** 50));
  return TID.fromTime(micros, hash.readUInt16BE(8) % 1024).toString();
}

/**
 * Bluesky's error as a `DriverError`: retryable for a timeout, a lost connection, or a status
 * `retryableStatus` retries. A 429 stays retryable even when its limit resets hours away (the
 * daily write limit): the runtime decides how long to wait, and the message says when.
 */
function driverError(err: unknown, what: string, timeoutMs: number): unknown {
  if (!(err instanceof XRPCError)) return err;
  if (err.status === ResponseType.Unknown) {
    const timedOut = err.cause instanceof Error && err.cause.name === "TimeoutError";
    const message = timedOut ? `timed out after ${timeoutMs} ms` : `could not reach Bluesky: ${err.message}`;
    return new DriverError(`Bluesky ${what} ${message}`, { retryable: true, cause: err });
  }
  // A reply that fails the Lexicon schema is not an HTTP status: the server is out of date.
  if (err.status < 100) return new DriverError(`Bluesky ${what}: ${err.message}`, { retryable: false, cause: err });
  const reset = Number(err.headers?.["ratelimit-reset"]);
  const until = err.status === 429 && reset ? ` (the limit resets at ${new Date(reset * 1000).toISOString()})` : "";
  return new DriverError(`Bluesky ${what} failed: ${err.message}${until}`, {
    retryable: retryableStatus(err.status),
    status: err.status,
    vendorCode: err.error,
    cause: err,
  });
}
