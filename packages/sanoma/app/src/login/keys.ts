import { requestOrigin, signingKeyFor } from "@sanoma-ai/workflows";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parse, serialize } from "cookie-es";

// Keys of their own, each for one purpose, derived from the deployment's SANOMA_SIGNING_KEY: the
// staff login's cookie, the setup's state, an OAuth attempt's cookie, and each visitor login's
// cookies; and the cookies a redirect flow (GitHub's manifest, OAuth consent) carries its state in.

/**
 * Signs short values (a session, a state) with a key derived from `SANOMA_SIGNING_KEY` for
 * `purpose`, so each use has a key of its own; `verify` compares in constant time.
 */
export function signer(purpose: string) {
  const key = signingKeyFor(purpose);
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  const verify = (payload: string, signature: string) => {
    const [expected, given] = [Buffer.from(sign(payload)), Buffer.from(signature)];
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return { sign, verify };
}

/**
 * The key a visitor login signs its cookies with (`LoginContext.key`): derived for `login <vendor>`
 * from `SANOMA_SIGNING_KEY`, an independent 32-byte base64 bootstrap key, hex.
 */
export function loginKey(vendor: string): string {
  return signingKeyFor(`login ${vendor}`).toString("hex");
}

/** The request's cookies, by name. */
export const cookies = (request: Request) => parse(request.headers.get("cookie") ?? "");

/**
 * A Set-Cookie line (`maxAge` 0 clears it): httpOnly, Lax, and Secure when the request came over
 * HTTPS (directly or through a proxy that says so).
 */
export const cookie = (request: Request, name: string, value: string, path: string, maxAge: number) =>
  serialize(name, value, {
    path,
    maxAge,
    httpOnly: true,
    sameSite: "lax",
    secure: requestOrigin(request).startsWith("https:"),
  });

/**
 * A redirect flow's cookie value, signed for `purpose`: `value` (a state, an attempt's id) and the
 * actor who started the flow, whom the redirect back does not carry. `open` gives both back, or
 * nothing when the value is missing or its signature does not hold.
 */
export function actorCookie(purpose: string) {
  const { sign, verify } = signer(purpose);
  return {
    seal(value: string, actor: string) {
      const payload = `${value}.${Buffer.from(actor).toString("base64url")}`;
      return `${payload}.${sign(payload)}`;
    },
    open(sealed: string | undefined): { value: string; actor: string } | undefined {
      const [value, who, signature] = (sealed ?? "").split(".");
      if (!value || !who || !signature || !verify(`${value}.${who}`, signature)) return undefined;
      return { value, actor: Buffer.from(who, "base64url").toString() };
    },
  };
}
