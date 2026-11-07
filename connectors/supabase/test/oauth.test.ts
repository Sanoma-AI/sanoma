import { createHash, randomUUID } from "node:crypto";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  defineConnection,
  memorySecretStore,
  SanomaClient,
  type SanomaConfig,
  startWorker,
} from "@sanoma-ai/workflows";
import { secret } from "@sanoma-ai/workflows/resources";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import { supabase } from "../src/index.ts";

// Supabase's OAuth method end to end over a fake Management API (msw): consent, the callback, the
// worker's exchange at `/v1/oauth/token` with PKCE and the client's Basic credentials, the
// organizations as the account, an operation called with the stored grant, its renewal when
// Supabase answers 401, and Revoke at `/v1/oauth/revoke`.

const API = "https://api.supabase.com";
const CLIENT = { clientId: "supabase-app", clientSecret: "supabase-app-secret" };
let issued: { code: string; challenge: string; redirectUri: string } | undefined;
/** The access token the fake accepts now, and the refresh token that renews it. */
let valid = { access: "sbp_oauth_access", refresh: "sbp_oauth_refresh" };
/** What `/v1/oauth/revoke` was sent. */
const revoked: unknown[] = [];

const fake = setupServer(
  http.post(`${API}/v1/oauth/token`, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    const [id, secretValue] = atob(request.headers.get("authorization")!.replace(/^Basic /, ""))
      .split(":")
      .map(decodeURIComponent);
    if (form.get("grant_type") === "refresh_token") {
      if (id !== CLIENT.clientId || form.get("refresh_token") !== valid.refresh)
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      // Rotates both, as a provider that rotates refresh tokens does.
      valid = { access: `${valid.access}+`, refresh: `${valid.refresh}+` };
      return HttpResponse.json({
        access_token: valid.access,
        refresh_token: valid.refresh,
        token_type: "Bearer",
        expires_in: 86_400,
      });
    }
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      id !== CLIENT.clientId ||
      secretValue !== CLIENT.clientSecret ||
      form.get("code") !== issued?.code ||
      form.get("redirect_uri") !== issued.redirectUri ||
      challenge !== issued.challenge
    )
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    return HttpResponse.json({
      access_token: "sbp_oauth_access",
      refresh_token: "sbp_oauth_refresh",
      token_type: "Bearer",
      expires_in: 86_400,
    });
  }),
  http.get(`${API}/v1/organizations`, ({ request }) =>
    request.headers.get("authorization") === `Bearer ${valid.access}`
      ? HttpResponse.json([{ id: "acme-org", name: "Acme" }])
      : HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
  ),
  http.post(`${API}/v1/oauth/revoke`, async ({ request }) => {
    revoked.push(await request.json());
    return new HttpResponse(null, { status: 204 });
  }),
);

const ops = defineConnection(supabase, {
  name: "ops",
  method: "oauth",
  credentials: secret("SUPABASE_OPS"),
  client: secret("SUPABASE_OAUTH_APP"),
  account: "acme-org",
});
const store = memorySecretStore();
const config: SanomaConfig = {
  databaseUrl: testDatabaseUrl("supabase_oauth"),
  workflows: [],
  connectors: [supabase],
  connections: [ops],
  secrets: { store },
};

beforeAll(() => fake.listen({ onUnhandledFrame: "bypass" }));
afterAll(() => fake.close());

it("connects by consent, lists the organization with the stored grant, renews it on a 401 and revokes it", async () => {
  const worker = await startWorker(config);
  const client = await SanomaClient.connect(config);
  try {
    const started = await client.authorizeConnection(
      { connection: { vendor: "supabase", $connection: ops.$connection } },
      {
        actor: "alice",
        id: randomUUID(),
        redirectUri: "https://app.acme.test/connect/supabase/callback",
        client: CLIENT,
      },
    );
    const consent = new URL(started.url);
    expect(`${consent.origin}${consent.pathname}`).toBe(`${API}/v1/oauth/authorize`);
    expect(consent.searchParams.has("scope")).toBe(false);
    issued = {
      code: "supabase-code",
      challenge: consent.searchParams.get("code_challenge")!,
      redirectUri: consent.searchParams.get("redirect_uri")!,
    };
    const { runId } = await client.receiveConnection(
      "supabase",
      started.attempt,
      new URLSearchParams({ code: issued.code, state: consent.searchParams.get("state")! }),
      { actor: "alice" },
    );
    const run = await waitFor(
      () => client.run(runId),
      (r) => r?.status === "finished" || r?.status === "failed",
      20_000,
    );
    expect(run?.status).toBe("finished");
    expect((await client.connections({ actor: "alice" }))[0]).toMatchObject({
      id: "supabase/ops",
      status: "connected",
      account: "acme-org",
    });
    expect(await client.call("supabase.organization.list", {}, { actor: "alice", connection: ops })).toEqual({
      organizations: [{ id: "acme-org", name: "Acme" }],
    });

    // Supabase stops taking the access token (401): the grant is renewed with its refresh token and the call made again.
    valid = { ...valid, access: "sbp_oauth_access_rotated" };
    expect(await client.call("supabase.organization.list", {}, { actor: "alice", connection: ops })).toEqual({
      organizations: [{ id: "acme-org", name: "Acme" }],
    });
    const [renewed] = await client.connections({ actor: "alice" });
    expect(renewed?.renewal).toMatchObject({ outcome: "refreshed" });
    expect(renewed?.renewal?.refreshedAt).toBeDefined();
    // Supabase publishes no refresh-token lifetime: renewed on use only, never scheduled, so an idle instance is never woken for it.
    expect(renewed?.renewal?.dueAt).toBeUndefined();

    // Revoke asks Supabase with the application and the current refresh token, then drops the grant.
    await client.call(
      "sanoma.connection.revoke",
      { connection: { vendor: "supabase", $connection: ops.$connection }, expectedRevision: renewed!.revision! },
      { actor: "alice" },
    );
    expect(revoked).toEqual([
      { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret, refresh_token: valid.refresh },
    ]);
    const [gone] = await client.connections({ actor: "alice" });
    expect(gone?.status).toBe("disconnected");
    expect(await store.read({ namespace: "default", path: "SUPABASE_OPS" })).toBeUndefined();
    expect(await store.read({ namespace: "default", path: "SUPABASE_OAUTH_APP" })).toBeDefined();
  } finally {
    await client.close();
    await worker.stop();
  }
}, 60_000);
