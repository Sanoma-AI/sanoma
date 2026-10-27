import { HOST_CHECK_AGENT, type RemoteEvent } from "@sanoma-ai/workflows";
import type { AppContext } from "../context.ts";
import { secretValues } from "./secrets.ts";

// A git host's webhooks (`POST /webhooks/<vendor>`, `startApp`'s machine routes): verified by the
// vendor's connector's remote half, which reads the raw body once for its signature, and each
// event it says happened handed to `SanomaClient.remoteEvent`: a push to `main` deploys, a push to
// a draft's branch plans its change again, a closed pull request ends it.

/** Who the events are told as: the runtime's host check, the actor drift and a push's apply use. */
const BY = HOST_CHECK_AGENT;

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * Answers a webhook of `vendor`'s host: 404 when no connector's remote half of that vendor reads
 * webhooks or its secret is not stored (`no_webhook_secret`), 401 when the signature is missing or
 * wrong (`bad_signature`), 400 for a signed body it cannot read (`bad_payload`), else 204 once
 * every event it carries is done (`remoteEvent`). The
 * secret is read as the half's other credentials are: the environment's first, then the stored one.
 */
export async function remoteWebhook(app: AppContext, vendor: string, request: Request): Promise<Response> {
  const half = app.resolved.remotes.get(vendor);
  if (!half?.webhook) return plain(404, `No connector reads ${vendor}'s webhooks\n`);
  let events: RemoteEvent[];
  try {
    events = await half.webhook(request, { secrets: secretValues(app.client) });
  } catch (err) {
    // Read by property: the half's `DriverError` may be another copy's class.
    const vendorCode = (err as { vendorCode?: string } | undefined)?.vendorCode;
    if (vendorCode === "no_webhook_secret") return plain(404, `${vendor}'s webhook secret is not stored\n`);
    if (vendorCode === "bad_signature") return plain(401, "The signature is missing or wrong\n");
    if (vendorCode === "bad_payload") return plain(400, "The body is not one the connector reads\n");
    throw err;
  }
  for (const event of events) await app.client.remoteEvent(event, { by: BY });
  return new Response(null, { status: 204 });
}
