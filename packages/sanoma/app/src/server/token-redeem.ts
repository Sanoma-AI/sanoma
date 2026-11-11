import type { SanomaClient } from "sanoma/workflows";
import { bodyText } from "sanoma/workflows/shared";
import { z } from "zod";

// `POST /api/token/redeem`, a machine route on every host, before the login: the other half of
// `sanoma.token.handoff`. A machine signing in (the Mac's app, after the browser brought it a
// code) posts the one-time code and its PKCE verifier, and is answered the api token the code
// hands off, once. It sets no cookie and starts no session: the token is all it grants.

const Redeem = z.object({
  code: z.string().regex(/^sch_[\w-]{43}$/),
  // RFC 7636's code verifier: 43 to 128 unreserved characters.
  verifier: z.string().regex(/^[\w.~-]{43,128}$/),
});

/** The most a request's body may hold: a code and a verifier are under 300 bytes. */
const MAX_BODY = 1024;

/** A body's JSON, or undefined for one that is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Answers `{ token }` for a code and its verifier, once; 410 alike for a code unknown, expired or
 * redeemed, a verifier that is not its challenge's (which leaves the code to be redeemed), and a
 * secret no longer holding the live token it held at the handoff; 400 for a body that is not
 * `{ code, verifier }`; 413 for one over `MAX_BODY`, read no further.
 */
export async function redeemToken(client: SanomaClient, request: Request): Promise<Response> {
  const text = await bodyText(request, MAX_BODY);
  if (text === undefined) return answer(413, { error: "The body is too large" });
  const asked = Redeem.safeParse(parsed(text));
  if (!asked.success) return answer(400, { error: "Send { code, verifier }" });
  const handed = await client.tokens.redeem(asked.data);
  const token = handed && (await client.secrets([handed.store])).get(handed.store)?.value;
  // The very token handed off, still live: never another put under the same name since.
  const live = token && (await client.tokens.resolve(token));
  if (!handed || !live || live.principal.id !== `token:${handed.tokenId}`)
    return answer(410, { error: "This code is used, expired or not for this verifier: sign in again" });
  return answer(200, { token });
}
