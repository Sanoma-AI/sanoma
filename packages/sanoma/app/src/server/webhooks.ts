import { type RemoteEvent, vendorCodeOf } from "sanoma/workflows";
import type { AppContext } from "../context.ts";
import { secretValues } from "./secrets.ts";

// A git host's webhooks (`POST /webhooks/<vendor>`, the handler's machine routes, on every host):
// verified by the vendor's connector's remote half, which reads the raw body once for its
// signature (its secret read through the client's store), and each event it says happened
// started as a run of the built-in `follow` (`SanomaClient.follow`), which the worker, with the
// checkout, does: a push to `main` deploys, a push to a draft's branch plans its change again, a
// closed pull request ends it.

/** A plain-text answer, never cached. */
export const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Answers a webhook of `vendor`'s host: 404 when no connector's remote half of that vendor reads
 * webhooks or its secret is not stored (`no_webhook_secret`), 401 when the signature is missing or
 * wrong (`bad_signature`), 400 for a signed body it cannot read (`bad_payload`), else 204 once
 * a follow run is started for every event it carries (one per event: a delivery told again
 * starts none). The secret is read through the client's store, as the half's other credentials are.
 */
export async function remoteWebhook(app: AppContext, vendor: string, request: Request): Promise<Response> {
  const half = app.resolved.remotes.get(vendor);
  if (!half?.webhook) return plain(404, `No connector reads ${vendor}'s webhooks\n`);
  let events: RemoteEvent[];
  try {
    events = await half.webhook(request, { secrets: secretValues(app.client) });
  } catch (err) {
    const vendorCode = vendorCodeOf(err);
    if (vendorCode === "no_webhook_secret") return plain(404, `${vendor}'s webhook secret is not stored\n`);
    if (vendorCode === "bad_signature") return plain(401, "The signature is missing or wrong\n");
    if (vendorCode === "bad_payload") return plain(400, "The body is not one the connector reads\n");
    throw err;
  }
  for (const event of events) await app.client.follow(event);
  return new Response(null, { status: 204 });
}
