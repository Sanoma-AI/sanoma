import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { SanomaClient } from "sanoma/workflows";
import type { AppContext } from "../src/context.ts";
import { authorizeConnection, connectionCallback } from "../src/server/connect.ts";

// The OAuth callback's answer when the provider or the exchange failed with a secret in what it
// said: back to the connector page with one of the callback's reasons, and nothing it was given
// (the code, the state, the provider's description) in the redirect or the log.

const ORIGIN = "https://app.example.test";

/** A callback request for an attempt this browser started, as the provider sends the person back with `params`. */
async function callbackFor(params: Record<string, string>) {
  const state = `SENTINEL-state-${randomUUID()}`;
  const started = { attempt: randomUUID(), connection: "acme/main", expiresAt: Date.now() + 600_000 };
  const client = {
    authorizeConnection: async () => ({ ...started, url: `https://oauth.example.test/authorize?state=${state}` }),
  } as unknown as SanomaClient;
  const { cookie } = await authorizeConnection(
    { client } as AppContext,
    { id: "alice" },
    { target: { connection: { vendor: "acme", $connection: "main" } }, requestId: randomUUID() } as never,
    new Request(`${ORIGIN}/connectors/acme`),
  );
  const query = new URLSearchParams({ ...params, state });
  return {
    state,
    request: new Request(`${ORIGIN}/connect/acme/callback?${query}`, {
      headers: { cookie: cookie.split(";")[0]! },
    }),
  };
}

it("redirects with the reason alone, whatever the provider or the exchange said", async () => {
  const said = `SENTINEL-description-${randomUUID()}`;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const refusals: [Error, string][] = [
    [Object.assign(new Error(`rejected: ${said}`), { name: "CallbackError", reason: "rejected" }), "rejected"],
    [new Error(`the token endpoint answered ${said}`), "failed"],
  ];
  for (const [thrown, reason] of refusals) {
    const { state, request } = await callbackFor({ error: "server_error", error_description: said, code: said });
    const client = {
      receiveConnection: async () => {
        throw thrown;
      },
    } as unknown as SanomaClient;
    const response = await connectionCallback({ client } as AppContext, request, "acme");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/connectors/acme?error=${reason}`);
    expect(JSON.stringify([...response.headers])).not.toMatch(new RegExp(`${said}|${state}`));
  }
  expect(JSON.stringify(logged.mock.calls)).not.toContain(said);
});
