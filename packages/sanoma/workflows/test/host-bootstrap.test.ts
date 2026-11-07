import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCloudflare, type StartContainer, stubContainer } from "@sanoma-ai/connector-cloudflare/fake";
import { findSentinels, testDatabaseUrl } from "sanoma/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { postgresSecretStore } from "../src/credentials.ts";
import { lazyDb } from "../src/db.ts";
import {
  type CallContext,
  defineConnector,
  defineDriver,
  DriverError,
  memorySecretStore,
  resolveSecrets,
  SanomaClient,
  SecretAccess,
  type SecretConfiguration,
  withSetup,
} from "../src/index.ts";
import { secret } from "../src/secret.ts";
import { checkSecretStore } from "../src/secret-store-check.ts";

// Needs Postgres. What a Cloudflare host delivers to its container (the Worker's text bindings, the
// secrets' among them, as the container's environment, on the fake that runs the package's own
// object code), and the company's runtime there resolving its bindings from it: the built-in
// store passes conformance under the delivered key, and every environment and bootstrap binding
// reads its delivered value, is read-only, and falls back to nothing when the host was not given it.

const databaseUrl = testDatabaseUrl("host_bootstrap");
const pool = lazyDb(databaseUrl, "host-bootstrap");
const keyDir = mkdtempSync(join(tmpdir(), "sanoma-host-bootstrap-"));
afterAll(async () => {
  await pool.close();
  rmSync(keyDir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

/** The company's config, the same on the machine that applies and in the container. */
const company: SecretConfiguration = {
  bindings: {
    SANOMA_SIGNING_KEY: { bootstrap: "SANOMA_SIGNING_KEY" },
    SANOMA_SECRETS_KEY: { bootstrap: "SANOMA_SECRETS_KEY" },
    PROVISIONING: { env: "SANOMA_PROVISIONING_CREDENTIAL", host: true },
    ELSEWHERE: { env: "NEVER_DELIVERED" },
  },
};

/** An operation reading a credential through its marker, failing with it in its message when asked to. */
const probeOps = defineConnector("probe", {
  credential: {
    use: {
      effect: "read",
      input: z.object({ credential: z.object({ $secret: z.string() }), fail: z.boolean() }),
      output: z.object({ used: z.boolean() }),
    },
  },
});
const probe = withSetup(probeOps, {
  driver: () =>
    defineDriver(probeOps, {
      credential: {
        use: async (input, call) => {
          const { credential } = await resolveSecrets(input, call.secrets);
          if (input.fail) throw new DriverError(`probe refused ${credential}`, { retryable: false });
          return { used: true };
        },
      },
    }),
});

/** The fake's stub container, keeping the environment each start was given. */
function capturing() {
  const delivered: Record<string, string>[] = [];
  const start: StartContainer = (input) => {
    delivered.push({ ...input.env });
    return stubContainer(input);
  };
  return { delivered, start };
}

describe("bootstrap a Cloudflare host delivers to its container", () => {
  const container = capturing();
  const fake = fakeCloudflare({ start: container.start });
  afterAll(() => fake.close());
  const signing = randomBytes(32).toString("base64");
  const encryption = randomBytes(32).toString("base64");
  const provisioning = "provisioning-credential-never-shown";

  it(
    "passes the store's conformance and keeps every binding read-only, with no fallback",
    { timeout: 60_000 },
    async () => {
      // The applying machine: the signing key in its environment, the encryption key in a mounted file.
      const keyFile = join(keyDir, "secrets-key");
      writeFileSync(keyFile, encryption, { mode: 0o600 });
      vi.stubEnv("SANOMA_SECRETS_KEY", undefined);
      vi.stubEnv("SANOMA_SIGNING_KEY_FILE", undefined);
      vi.stubEnv("SANOMA_SIGNING_KEY", signing);
      vi.stubEnv("SANOMA_SECRETS_KEY_FILE", keyFile);
      vi.stubEnv("SANOMA_PROVISIONING_CREDENTIAL", provisioning);
      const applier = new SecretAccess(company, memorySecretStore());
      await applier.store.write({ namespace: "default", path: "DB_URL" }, databaseUrl, {
        expectedVersion: null,
        by: "test",
      });
      const call: CallContext = {
        idempotencyKey: "host:1",
        runId: "bootstrap",
        opId: "cloudflare.host.create",
        attempt: 1,
        secrets: applier,
      };
      // As apply derives the host's secrets: markers only, resolved by the driver at its upload.
      const created = await fake.driver.ops["host.create"]!(
        {
          desired: {
            name: "bootstrap",
            image: "ghcr.io/sanoma-ai/runtime:0.11.4",
            source: "https://github.com/acme/company.git",
            ref: "main",
            revision: "0".repeat(40),
            secrets: {
              SANOMA_DATABASE_URL: secret("DB_URL"),
              SANOMA_SIGNING_KEY: secret("SANOMA_SIGNING_KEY"),
              SANOMA_SECRETS_KEY: secret("SANOMA_SECRETS_KEY"),
              SANOMA_PROVISIONING_CREDENTIAL: secret("PROVISIONING"),
            },
          },
        },
        call,
      );
      // What the ledger records of the create holds none of the values it delivered.
      for (const value of [signing, encryption, provisioning]) expect(JSON.stringify(created)).not.toContain(value);
      const env = container.delivered.at(-1)!;
      // Values, never a path on the applying machine, and nothing the host was not declared to carry.
      expect(env).toMatchObject({
        SANOMA_DATABASE_URL: databaseUrl,
        SANOMA_SIGNING_KEY: signing,
        SANOMA_SECRETS_KEY: encryption,
        SANOMA_PROVISIONING_CREDENTIAL: provisioning,
      });
      expect(Object.keys(env).filter((name) => name.endsWith("_FILE") || name === "NEVER_DELIVERED")).toEqual([]);

      // In the container: only what the host delivered.
      vi.unstubAllEnvs();
      for (const name of [
        "SANOMA_SIGNING_KEY",
        "SANOMA_SIGNING_KEY_FILE",
        "SANOMA_SECRETS_KEY",
        "SANOMA_SECRETS_KEY_FILE",
        "SANOMA_PROVISIONING_CREDENTIAL",
        "NEVER_DELIVERED",
      ])
        vi.stubEnv(name, undefined);
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const store = postgresSecretStore(() => pool.db());
      expect((await checkSecretStore(store, randomUUID())).filter((check) => !check.ok)).toEqual([]);

      const namespace = randomUUID();
      const runtime = new SecretAccess({ ...company, namespace }, store);
      expect(await runtime.read("PROVISIONING")).toEqual({ value: provisioning, version: "environment" });
      expect(await runtime.read("SANOMA_SIGNING_KEY")).toEqual({ value: signing, version: "bootstrap" });
      for (const name of ["PROVISIONING", "SANOMA_SIGNING_KEY", "SANOMA_SECRETS_KEY"]) {
        await expect(runtime.write(name, "replaced", { expectedVersion: null, by: "test" })).rejects.toMatchObject({
          code: "read_only",
        });
        await expect(runtime.delete(name)).rejects.toMatchObject({ code: "read_only" });
      }
      // A binding the host was not given reads as missing, never the store's value of that name.
      await store.write({ namespace, path: "ELSEWHERE" }, "stored", { expectedVersion: null, by: "test" });
      expect(await runtime.read("ELSEWHERE")).toBeUndefined();
      await expect(runtime.ensure("ELSEWHERE", () => "made")).rejects.toMatchObject({ code: "read_only" });

      // The company's runtime there: a call reading the delivered credential, and one failing with
      // it in its error, leave none of what the host delivered in the database.
      const client = await SanomaClient.connect({
        databaseUrl,
        workflows: [],
        connectors: [probe],
        secrets: { ...company, namespace },
      });
      try {
        const use = (fail: boolean) =>
          client.call("probe.credential.use", { credential: secret("PROVISIONING"), fail }, { actor: "alice" });
        expect(await use(false)).toEqual({ used: true });
        await expect(use(true)).rejects.toMatchObject({ message: "probe refused [redacted]" });
      } finally {
        await client.close();
      }
      expect(await findSentinels(databaseUrl, [signing, encryption, provisioning])).toEqual([]);
    },
  );
});
