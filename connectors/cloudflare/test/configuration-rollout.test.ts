import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { memorySecrets, type CallContext } from "@sanoma-ai/workflows";
import { expect, it, vi } from "vitest";
import { fakeCloudflare } from "../src/fake.ts";

it("rolls out a rotated bootstrap at the same source and image, then converges", async () => {
  const started: string[] = [];
  const fake = fakeCloudflare({
    start: async ({ env }) => {
      started.push(env.SANOMA_MANAGED_IDENTITY_CREDENTIAL!);
      const server = createServer((_req, res) => res.writeHead(200).end("ok"));
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: async () => {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      };
    },
  });
  let calls = 0;
  const context = (value: string): CallContext => ({
    runId: "rollout",
    opId: "cloudflare.container.update",
    attempt: 1,
    idempotencyKey: `rollout-${++calls}`,
    secrets: memorySecrets({ BOOTSTRAP: value }),
  });
  const desired = {
    name: "rollout",
    source: "https://github.com/acme/company.git",
    ref: "main",
    revision: "same-commit",
    image: "ghcr.io/sanoma-ai/runtime:0.10.12",
    port: 3000,
    configurationRevision: "d1-g1",
    secrets: { SANOMA_MANAGED_IDENTITY_CREDENTIAL: { $secret: "BOOTSTRAP" } },
  };
  const run = (name: string, input: object, value = "synthetic-first-bootstrap") =>
    fake.driver.ops[`container.${name}`]!(input, context(value));
  try {
    await run("create", { desired });
    expect(started).toEqual(["synthetic-first-bootstrap"]);
    const rotated = { ...desired, configurationRevision: "d1-g2" };
    expect(await run("plan", { id: desired.name, desired: rotated })).toMatchObject({ action: "update" });
    // An old Worker can briefly answer during rollout. Matching the git revision alone is insufficient.
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
      Response.json({
        revision: "same-commit",
        configurationRevision: "d1-g1",
        running: true,
        ready: true,
      }),
    );
    const result = await run("update", { id: desired.name, desired: rotated }, "synthetic-next-bootstrap");
    expect(result).toMatchObject({ state: { revision: "same-commit", configurationRevision: "d1-g2", healthy: true } });
    expect(started).toEqual(["synthetic-first-bootstrap", "synthetic-next-bootstrap"]);
    expect(await run("plan", { id: desired.name, desired: rotated })).toMatchObject({ action: "none" });
    await run("update", { id: desired.name, desired: rotated }, "synthetic-next-bootstrap");
    expect(started).toHaveLength(2);
    const read = await run("read", { id: desired.name });
    expect(read).toMatchObject({ state: { configurationRevision: "d1-g2" } });
    expect(JSON.stringify([result, read, fake.state])).not.toContain("synthetic-next-bootstrap");
    expect(JSON.stringify([result, read, fake.state])).not.toContain("synthetic-first-bootstrap");
    const { configurationRevision: _removed, ...withoutRevision } = rotated;
    expect(await run("plan", { id: desired.name, desired: withoutRevision })).toMatchObject({
      action: "update",
      planned: { configurationRevision: null },
    });
    await run("update", { id: desired.name, desired: withoutRevision }, "synthetic-next-bootstrap");
    expect(started).toHaveLength(3);
  } finally {
    vi.restoreAllMocks();
    await fake.close();
  }
});
