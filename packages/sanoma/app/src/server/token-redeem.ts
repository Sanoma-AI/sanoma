import type { SanomaClient } from "sanoma/workflows";
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

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Answers `{ token }` for a code and its verifier, once; 410 alike for a code unknown, expired or
 * redeemed, a verifier that is not its challenge's (which leaves the code to be redeemed), and a
 * secret no longer holding the live token it held at the handoff; 400 for a body that is not
 * `{ code, verifier }`.
 */
export async function redeemToken(client: SanomaClient, request: Request): Promise<Response> {
  const asked = Redeem.safeParse(await request.json().catch(() => undefined));
  if (!asked.success) return answer(400, { error: "Send { code, verifier }" });
  const handed = await client.tokens.redeem(asked.data);
  const token = handed && (await client.secrets([handed.store])).get(handed.store)?.value;
  // The very token handed off, still live: never another put under the same name since.
  const live = token && (await client.tokens.resolve(token));
  if (!handed || !live || live.principal.id !== `token:${handed.tokenId}`)
    return answer(410, { error: "This code is used, expired or not for this verifier: sign in again" });
  return answer(200, { token });
}
