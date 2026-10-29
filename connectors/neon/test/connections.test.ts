import { z } from "zod";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { expect, it } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import {
  defineConnection,
  defineWorkflow,
  encodeCredentials,
  memoryLedger,
  memorySecretStore,
  SanomaClient,
  startWorker,
} from "@sanoma-ai/workflows";
import { secret } from "@sanoma-ai/workflows/resources";
import { neon, neonApiKey } from "../src/index.ts";

// Protocol doubles from Neon's pinned SDK schema; no real API key or vendor account is used.
it("uses separate Neon organization clients through the authorized runtime, including rotation during a request", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: { key: string; path: string }[] = [];
  const keyOf = (request: Request) => {
    const key = request.headers.get("authorization")!.replace(/^Bearer /, "");
    requests.push({ key, path: new URL(request.url).pathname });
    return key;
  };
  const server = setupServer(
    http.get("https://console.neon.tech/api/v2/users/me/organizations", ({ request }) => {
      const key = keyOf(request);
      return HttpResponse.json({ organizations: [{ id: key.startsWith("support-") ? "org-support" : "org-sales" }] });
    }),
    http.get("https://console.neon.tech/api/v2/projects/same/branches", async ({ request }) => {
      const key = keyOf(request);
      if (key === "support-v1") {
        entered.resolve();
        await release.promise;
      }
      return HttpResponse.json({ branches: [{ id: "branch", default: true }] });
    }),
    http.get("https://console.neon.tech/api/v2/projects/same/endpoints", ({ request }) => {
      const key = keyOf(request);
      return HttpResponse.json({
        endpoints: [
          {
            id: "endpoint",
            branch_id: "branch",
            type: "read_write",
            current_state: key === "support-v1" ? "idle" : key === "support-v2" ? "active" : "init",
          },
        ],
      });
    }),
    http.get("https://console.neon.tech/api/v2/projects/same/connection_uri", ({ request }) => {
      keyOf(request);
      return HttpResponse.json({ uri: "postgresql://fixture:synthetic-password@database.example.test/neondb" });
    }),
  );
  server.listen({ onUnhandledFrame: "error" });
  const suffix = randomUUID().slice(0, 8);
  const support = defineConnection(neon, {
    name: `support-${suffix}`,
    method: "apiKey",
    credentials: secret("NEON_SUPPORT"),
    account: "org-support",
  });
  const sales = defineConnection(neon, {
    name: `sales-${suffix}`,
    method: "apiKey",
    credentials: secret("NEON_SALES"),
    account: "org-sales",
  });
  const save = defineWorkflow({
    name: "store-neon-url",
    trigger: "manual",
    input: z.object({}),
    uses: [neon.project.storeUrl],
    run: async (ctx) => ctx.neon.project.storeUrl({ id: "same", export: "supportStore" }, { connection: support }),
  });
  const health = defineWorkflow({
    name: "check-neon-accounts",
    trigger: "manual",
    input: z.object({ account: z.enum(["support", "sales"]) }),
    uses: [neon.project.health],
    run: async (ctx, input) =>
      ctx.neon.project.health({ id: "same" }, { connection: input.account === "support" ? support : sales }),
  });
  const store = memorySecretStore();
  const config = {
    databaseUrl: testDatabaseUrl("neon_connections"),
    connectors: [neon],
    connections: [support, sales],
    secrets: { store },
    ledger: memoryLedger(),
    workflows: [save, health],
  };
  const client = await SanomaClient.connect(config);
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let held: Promise<unknown> | undefined;
  try {
    for (const [connection, key] of [
      [support, "support-v1"],
      [sales, "sales-v1"],
    ] as const) {
      await client.setSecret(connection.credentials!.$secret, encodeCredentials(neonApiKey, { apiKey: key }), {
        by: "alice",
      });
      await client.call(
        "sanoma.connection.bind",
        { connection, account: connection.account!, scopes: [], expectedRevision: null },
        { actor: "alice" },
      );
    }
    worker = await startWorker(config);
    const checkHealth = async (account: "support" | "sales") =>
      client.result(await client.start(health, { account }, { startedBy: "alice" }), 15_000);
    held = checkHealth("support");
    await Promise.race([
      entered.promise,
      held.then(() => {
        throw new Error("Expected an in-flight Neon request");
      }),
    ]);
    await client.setSecret("NEON_SUPPORT", encodeCredentials(neonApiKey, { apiKey: "support-v2" }), { by: "alice" });
    expect(await Promise.all((["support", "sales"] as const).map(checkHealth))).toEqual([
      { healthy: true, state: "active" },
      { healthy: false, state: "init" },
    ]);
    release.resolve();
    expect(await held).toEqual({ healthy: true, state: "idle" });
    expect(requests.filter((r) => r.path.endsWith("/endpoints")).map((r) => r.key)).toEqual(
      expect.arrayContaining(["support-v1", "support-v2", "sales-v1"]),
    );
    const run = await client.start(save, {}, { startedBy: "alice" });
    expect(await client.result(run, 10_000)).toEqual({ secret: "SANOMA_DATABASE_URL_SUPPORT_STORE" });
    expect((await store.read({ namespace: "default", path: "SANOMA_DATABASE_URL_SUPPORT_STORE" }))?.value).toContain(
      "synthetic-password",
    );
    expect(JSON.stringify(await client.ledger(run))).not.toContain("synthetic-password");
    // Replacing the bundle with another organization's valid key is rejected before its operation.
    await client.setSecret("NEON_SUPPORT", encodeCredentials(neonApiKey, { apiKey: "sales-v1" }), { by: "alice" });
    const before = requests.filter((r) => r.path.endsWith("/branches")).length;
    await expect(checkHealth("support")).rejects.toThrow("Secret store: denied");
    expect(requests.filter((r) => r.path.endsWith("/branches"))).toHaveLength(before);
  } finally {
    release.resolve();
    await held?.catch(() => undefined);
    await worker?.stop();
    await client.close();
    server.close();
  }
});
