import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { memorySecrets, type CallContext } from "sanoma/workflows";
import { expect, it, vi } from "vitest";
import { container, host } from "../src/connector.ts";
import { containerOps, type CloudflareApi } from "../src/ops.ts";
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
    // The instance token as a store keeps it: the running container takes the bundle's ask only with its own.
    secrets: memorySecrets({ BOOTSTRAP: value, SANOMA_WAKEUP_TOKEN: "rollout-instance-token" }),
  });
  const desired = {
    name: "rollout",
    source: "https://github.com/acme/company.git",
    ref: "main",
    revision: "same-commit",
    image: "ghcr.io/sanoma-ai/runtime:0.10.12",
    port: 3000,
    configurationRevision: "d1-g1",
    secrets: {
      SANOMA_MANAGED_IDENTITY_CREDENTIAL: { $secret: "BOOTSTRAP" },
      // Made up: Hyperdrive's origin is made of it, and nothing connects to it.
      SANOMA_DATABASE_URL: "postgresql://sanoma:test@db.acme.example:5432/company",
    },
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

/** An upload already succeeded; its stopped runtime has not established readiness. */
function pendingRollout(type: typeof container | typeof host, start: () => Promise<Response>) {
  const desired = {
    name: "retry",
    source: "https://github.com/acme/company.git",
    ref: "main",
    revision: "same-commit",
    image: "ghcr.io/sanoma-ai/runtime:0.11.6",
    configurationRevision: "d1-g2",
    port: 3000,
    secrets: {
      SANOMA_MANAGED_IDENTITY_CREDENTIAL: { $secret: "BOOTSTRAP" },
      SANOMA_DATABASE_URL: { $secret: "DATABASE_URL" },
    },
  };
  const text = {
    SANOMA_SOURCE: desired.source,
    SANOMA_REF: desired.ref,
    SANOMA_REVISION: desired.revision,
    SANOMA_IMAGE: desired.image,
    SANOMA_CONFIG_REVISION: desired.configurationRevision,
    PORT: "3000",
  };
  const send = vi.fn<CloudflareApi["send"]>(async (url: string) =>
    new URL(url).searchParams.has("start")
      ? start()
      : Response.json({
          revision: desired.revision,
          configurationRevision: desired.configurationRevision,
          running: false,
          ready: false,
        }),
  );
  const upload = vi.fn<CloudflareApi["upload"]>();
  const api = {
    workerUrl: async () => "https://retry.example.test",
    application: async () => ({ id: "owned-app" }),
    settings: async () => ({
      bindings: [
        { type: "durable_object_namespace", name: "SANOMA_INSTANCE" },
        { type: "secret_text", name: "SANOMA_MANAGED_IDENTITY_CREDENTIAL" },
        { type: "secret_text", name: "SANOMA_DATABASE_URL" },
        { type: "secret_text", name: "SANOMA_WAKEUP_TOKEN" },
        { type: "hyperdrive", name: "DATABASE", id: "retry-database" },
        ...Object.entries(text).map(([name, value]) => ({ type: "plain_text", name, text: value })),
      ],
      // The app's upload made: its version tagged with the revision.
      annotations: { "workers/tag": desired.revision },
    }),
    send,
    upload,
  } as unknown as CloudflareApi;
  const ops = containerOps(() => api, { startTimeoutMs: 100, pollMs: 1 }, type);
  // No bootstrap value is available: an unchanged update must not resolve or upload secrets.
  const call: CallContext = {
    runId: "retry",
    opId: `cloudflare.${type.type}.update`,
    attempt: 1,
    idempotencyKey: "retry",
    secrets: memorySecrets({}),
  };
  return { desired, ops, call, send, upload };
}

it.each([container, host])(
  "an unchanged $type update awaits readiness while reads and plans remain passive",
  async (type) => {
    const ready = Promise.withResolvers<Response>();
    const start = vi.fn<() => Promise<Response>>(() => ready.promise);
    const { desired, ops, call, upload } = pendingRollout(type, start);
    await expect(ops.read({ id: desired.name })).resolves.toMatchObject({ gone: false });
    await expect(ops.plan({ id: desired.name, desired })).resolves.toMatchObject({ action: "none" });
    expect(start).not.toHaveBeenCalled();
    let finished = false;
    const update = ops.update({ id: desired.name, desired }, call).then((result) => {
      finished = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      ready.resolve(
        Response.json({
          revision: desired.revision,
          configurationRevision: desired.configurationRevision,
          running: true,
          ready: true,
        }),
      );
      await expect(update).resolves.toMatchObject({
        state: { healthy: true, revision: desired.revision, configurationRevision: desired.configurationRevision },
      });
      expect(upload).not.toHaveBeenCalled();
    } finally {
      ready.resolve(
        Response.json({ revision: desired.revision, configurationRevision: desired.configurationRevision }),
      );
      await update.catch(() => {});
    }
  },
);

it("an unchanged update refuses terminal startup failure instead of reporting successful recovery", async () => {
  const { desired, ops, call, upload } = pendingRollout(container, async () =>
    Response.json({ error: "synthetic startup failure", exit: "exit 128" }, { status: 503 }),
  );
  await expect(ops.update({ id: desired.name, desired }, call)).rejects.toThrow("synthetic startup failure");
  expect(upload).not.toHaveBeenCalled();
});
