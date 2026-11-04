import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { lintWorkflow } from "../src/lint.ts";
import {
  defineWorkflow,
  memorySecrets,
  memorySecretStore,
  openInvite,
  resolveConfig,
  SecretAccess,
  sanoma,
  sshPublicKey,
} from "../src/index.ts";
import { databaseUrlSecret, storeDatabaseUrl } from "../src/database.ts";
import { runtimeDriver, sandboxRuntimeDriver } from "../src/runtime-ops.ts";
import { memoryTokens, newApiToken } from "../src/tokens.ts";
import { rootWith } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The runtime's own operations a workflow calls (`sanoma.secret.*`,
// `sanoma.invite.mint`, `sanoma.token.*`) over the worker's store, under the policy, never a
// secret's value in the ledger; and `ctx.startedBy` for a person, a visitor and an api token.

const keys = defineWorkflow({
  name: "keys",
  trigger: "manual",
  input: z.object({ name: z.string(), kind: z.enum(["random", "ssh-rsa"]) }),
  uses: [sanoma.secret.generate],
  run: async (ctx, input) => {
    return await ctx.sanoma.secret.generate(input);
  },
});

const drop = defineWorkflow({
  name: "drop",
  trigger: "manual",
  input: z.object({ name: z.string() }),
  uses: [sanoma.secret.delete],
  run: async (ctx, input) => {
    return await ctx.sanoma.secret.delete(input);
  },
});

const invite = defineWorkflow({
  name: "invite",
  trigger: "manual",
  input: z.object({ host: z.string() }),
  uses: [sanoma.invite.mint],
  run: async (ctx, { host }) => {
    return await ctx.sanoma.invite.mint({ host, email: "ada@acme.test", key: { $secret: "ACME_SIGNING_KEY" } });
  },
});

const token = defineWorkflow({
  name: "token",
  trigger: "manual",
  input: z.object({ id: z.uuid().optional(), subject: z.string(), store: z.string() }),
  uses: [sanoma.token.mint],
  run: async (ctx, { id, subject, store }) => {
    return await ctx.sanoma.token.mint({ id, subject, groups: ["visitors"], store });
  },
});

const revoke = defineWorkflow({
  name: "revoke",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [sanoma.token.revoke],
  run: async (ctx, input) => {
    return await ctx.sanoma.token.revoke(input);
  },
});

const whoami = defineWorkflow({
  name: "whoami",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async (ctx) => {
    const { email = null, github = null, subject = null } = ctx.startedBy;
    return { ...ctx.startedBy, email, github, subject };
  },
});

const root = rootWith({
  "policies/policy.cedar": `permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:whoami", resource);

@reason("that one stays")
forbid (principal, action == Sanoma::Action::"sanoma.secret.delete", resource)
when { context.input.name == "KEEP_ME" || context.input.name == "SANOMA_DATABASE_URL_KEEP" };
`,
});

/** A small RSA private key in PEM. */
const createPrivateKeyPem = () =>
  generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const messages = (src: string) => lintWorkflow(src).map((p) => p.message);

/** A 32-byte signing key, as an instance's SANOMA_SIGNING_KEY and as stored here under ACME_SIGNING_KEY. */
const SIGNING_KEY = randomBytes(32).toString("base64");

describe("the runtime's own operations", () => {
  const store = memorySecretStore();
  const app = useTestApp(
    {
      workflows: [keys, drop, invite, token, revoke, whoami],
      connectors: [],
      secrets: {
        store,
        bindings: {
          SANOMA_DATABASE_URL_EXTERNAL: { path: "customer/database", management: "external" },
          SANOMA_DATABASE_URL_ENV: { env: "TEST_EXTERNAL_DATABASE_URL" },
        },
      },
      root,
    },
    { databaseUrl: testDatabaseUrl("runtime-ops") },
  );
  const stored = async (name: string) => (await store.read({ namespace: "default", path: name }))?.value;
  const run = async (workflow: string, input: unknown, startedBy: unknown = "ada") =>
    app.client.result(await app.client.start(workflow, input, { startedBy: startedBy as string }));
  const ledgerOf = async (workflow: string, input: unknown) => {
    const runId = await app.client.start(workflow, input, { startedBy: "ada" });
    const output = await app.client.result(runId);
    return { output, ledger: JSON.stringify(await app.client.ledger(runId)) };
  };

  /** A stand-in instance's `POST /auth/invite`: answers `status`, recording each body. */
  let server: Server;
  let host = "";
  const posted: { request: string }[] = [];
  let status = 200;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/auth/invite") posted.push(JSON.parse(body));
        res.writeHead(status, {
          "content-type": "application/json",
          ...(status === 307 && { location: "/auth/invite" }),
        });
        res.end(JSON.stringify(status < 300 ? { url: `${host}/auth/invite/one-use` } : { error: "Not today" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("generates a random secret into the store, keeps one there, and never records its value", async () => {
    const { output, ledger } = await ledgerOf("keys", { name: "ACME_RANDOM", kind: "random" });
    expect(output).toEqual({ name: "ACME_RANDOM" });
    const value = await stored("ACME_RANDOM");
    expect(value).toMatch(/^[\w-]{43}$/);
    expect(ledger).toContain('"op":"sanoma.secret.generate"');
    expect(ledger).not.toContain(value);
    await run("keys", { name: "ACME_RANDOM", kind: "random" });
    expect(await stored("ACME_RANDOM")).toBe(value);
  });

  it("generates an RSA key pair: the private half stored, the public half answered in OpenSSH's format", async () => {
    const { output, ledger } = await ledgerOf("keys", { name: "ACME_SOURCE_KEY", kind: "ssh-rsa" });
    const { publicKey } = output as { name: string; publicKey: string };
    const pem = (await stored("ACME_SOURCE_KEY"))!;
    expect(pem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(publicKey).toMatch(/^ssh-rsa [A-Za-z0-9+/]+=*$/);
    // `ssh-rsa`, then the strings `ssh-rsa`, e and n, each after its length.
    const wire = Buffer.from(publicKey.slice("ssh-rsa ".length), "base64");
    const fields: Buffer[] = [];
    for (let at = 0; at < wire.length; at += 4 + wire.readUInt32BE(at)) {
      fields.push(wire.subarray(at + 4, at + 4 + wire.readUInt32BE(at)));
    }
    const [kind, e, n] = fields;
    expect(kind!.toString()).toBe("ssh-rsa");
    const jwk = createPublicKey(pem).export({ format: "jwk" });
    expect({ e: e!.toString("base64url"), n: n!.subarray(n![0] === 0 ? 1 : 0).toString("base64url") }).toEqual({
      e: jwk.e,
      n: jwk.n,
    });
    expect(ledger).toContain(publicKey);
    expect(ledger).not.toContain("PRIVATE KEY");
    // Kept, and its public half answered again.
    expect(await run("keys", { name: "ACME_SOURCE_KEY", kind: "ssh-rsa" })).toEqual({
      name: "ACME_SOURCE_KEY",
      publicKey,
    });
    expect(await stored("ACME_SOURCE_KEY")).toBe(pem);
    expect(sshPublicKey(pem)).toBe(publicKey);
  });

  it("refuses an ssh-rsa kind over a name holding something else, and a name not upper case", async () => {
    await run("keys", { name: "ACME_NOT_A_KEY", kind: "random" });
    await expect(run("keys", { name: "ACME_NOT_A_KEY", kind: "ssh-rsa" })).rejects.toThrow(
      /ACME_NOT_A_KEY holds a value that is not an RSA private key/,
    );
    await expect(run("keys", { name: "acme_key", kind: "random" })).rejects.toThrow(/a secret's name: upper case/);
  });

  it("deletes a secret, as the policy lets it", async () => {
    await run("keys", { name: "ACME_GONE", kind: "random" });
    expect(await run("drop", { name: "ACME_GONE" })).toEqual({});
    expect(await stored("ACME_GONE")).toBeUndefined();
    // None stored is nothing to do.
    expect(await run("drop", { name: "ACME_GONE" })).toEqual({});
    await run("keys", { name: "KEEP_ME", kind: "random" });
    await expect(run("drop", { name: "KEEP_ME" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await stored("KEEP_ME")).toBeDefined();
  });

  it("retires a database export through the policy and ledger without deleting neighboring values", async () => {
    const secrets = new SecretAccess({ store }, store);
    const name = databaseUrlSecret("cloudAcme");
    const value = "postgresql://synthetic:private-password@db.invalid/acme";
    await storeDatabaseUrl(secrets, "cloudAcme", value, { where: "test database", others: "another database" });
    await store.write({ namespace: "preview", path: name }, "preview database", { expectedVersion: null, by: "test" });
    await store.write({ namespace: "default", path: "SANOMA_DATABASE_URL_OTHER" }, "other database", {
      expectedVersion: null,
      by: "test",
    });
    const { output, ledger } = await ledgerOf("drop", { name });
    expect(output).toEqual({});
    expect(await stored(name)).toBeUndefined();
    expect(ledger).toContain('"op":"sanoma.secret.delete"');
    expect(ledger).toContain(name);
    expect(ledger).not.toContain(value);
    expect(ledger).not.toContain("private-password");
    expect((await store.read({ namespace: "preview", path: name }))?.value).toBe("preview database");
    expect(await stored("SANOMA_DATABASE_URL_OTHER")).toBe("other database");
    expect(await run("drop", { name })).toEqual({});
    // Deletion remains a workflow operation; adding database exports does not bypass that gate.
    await expect(app.client.call("sanoma.secret.delete", { name }, { actor: "ada" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await storeDatabaseUrl(secrets, "keep", value, { where: "test database", others: "another database" });
    await expect(run("drop", { name: "SANOMA_DATABASE_URL_KEEP" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(await stored("SANOMA_DATABASE_URL_KEEP")).toBe(value);
  });

  it("cannot retire a database URL owned by an external store binding or environment", async () => {
    const value = "postgresql://synthetic:external-password@db.invalid/customer";
    await store.write({ namespace: "default", path: "customer/database" }, value, {
      expectedVersion: null,
      by: "test",
    });
    vi.stubEnv("TEST_EXTERNAL_DATABASE_URL", value);
    try {
      for (const name of ["SANOMA_DATABASE_URL_EXTERNAL", "SANOMA_DATABASE_URL_ENV"]) {
        await expect(run("drop", { name })).rejects.toMatchObject({ code: "read_only" });
      }
      expect((await store.read({ namespace: "default", path: "customer/database" }))?.value).toBe(value);
      expect(process.env.TEST_EXTERNAL_DATABASE_URL).toBe(value);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mints an invite: a request sealed under the named key, posted to the instance, its link answered", async () => {
    await store.write({ namespace: "default", path: "ACME_SIGNING_KEY" }, SIGNING_KEY, {
      expectedVersion: null,
      by: "test",
    });
    const before = Date.now();
    const { output, ledger } = await ledgerOf("invite", { host });
    expect(output).toEqual({ url: `${host}/auth/invite/one-use` });
    // The link signs someone in: the call's record says there was one (the run's output is the workflow's).
    const called = (JSON.parse(ledger) as { type: string; output?: unknown }[]).find((r) => r.type === "op.called");
    expect(called?.output).toEqual({ url: "<url>" });
    const [{ request }] = posted.splice(0) as [{ request: string }];
    // Not under this process's key: under the instance's, which opens it.
    expect(openInvite(request)).toBeUndefined();
    vi.stubEnv("SANOMA_SIGNING_KEY", SIGNING_KEY);
    try {
      const opened = openInvite(request)!;
      expect(opened).toMatchObject({ email: "ada@acme.test", nonce: expect.any(String) });
      // Posted at once, so good for `sealInvite`'s few minutes, not longer.
      expect(opened.exp).toBeGreaterThan(before);
      expect(opened.exp).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails an invite the instance refuses, not retryable, and one whose key is not stored", async () => {
    status = 403;
    try {
      await expect(run("invite", { host })).rejects.toThrow(/answered 403 to POST \/auth\/invite: Not today/);
      // A redirect is not followed: the sealed request goes to the host named alone.
      status = 307;
      await expect(run("invite", { host })).rejects.toThrow(/answered 307 to POST \/auth\/invite/);
    } finally {
      status = 200;
    }
    expect(posted.splice(0)).toHaveLength(2);
    await store.delete(
      { namespace: "default", path: "ACME_SIGNING_KEY" },
      {
        expectedVersion: (await store.read({ namespace: "default", path: "ACME_SIGNING_KEY" }))!.version,
        by: "test",
      },
    );
    await expect(run("invite", { host })).rejects.toThrow(/the secret ACME_SIGNING_KEY is not set/);
    expect(posted).toEqual([]);
  });

  it("mints a token into the store, answering its id alone, and revokes it", async () => {
    const subject = "visitor:better-auth:owner-1";
    const { output, ledger } = await ledgerOf("token", { subject, store: "ACME_CLOUD_TOKEN" });
    const { id } = output as { id: string };
    const value = (await stored("ACME_CLOUD_TOKEN"))!;
    expect(value).toMatch(/^sca_/);
    expect(ledger).not.toContain(value);
    expect(await app.client.tokens.resolve(value)).toEqual({
      principal: { id: `token:${id}`, groups: ["visitors"] },
      subject,
    });
    // A name holding a value already is refused, and nothing is minted over it.
    await expect(run("token", { subject, store: "ACME_CLOUD_TOKEN" })).rejects.toThrow(
      /ACME_CLOUD_TOKEN holds a token with conflicting/,
    );
    expect(await run("revoke", { id })).toEqual({});
    expect(await app.client.tokens.resolve(value)).toBeUndefined();
  });

  it("recovers a recorded token ID across workflow runs without changing authority or reviving revocation", async () => {
    const input = { id: randomUUID(), subject: "visitor:recovery:owner", store: "RECOVERED_CLOUD_TOKEN" };
    const first = await ledgerOf("token", input);
    const value = (await stored(input.store))!;
    expect(first.output).toEqual({ id: input.id });
    const again = await ledgerOf("token", input);
    expect(again.output).toEqual(first.output);
    expect(await stored(input.store)).toBe(value);
    expect(first.ledger + again.ledger).not.toContain(value);
    await expect(run("token", { ...input, subject: "visitor:recovery:other" })).rejects.toThrow(/conflicting/);
    await expect(run("token", { ...input, id: randomUUID() })).rejects.toThrow(/conflicting/);
    expect(await app.client.tokens.resolve(value)).toMatchObject({ subject: input.subject });
    await run("revoke", { id: input.id });
    await expect(run("token", input)).rejects.toThrow(/revoked/);
    expect(await app.client.tokens.resolve(value)).toBeUndefined();
    expect(await stored(input.store)).toBe(value);
  });

  it("atomically registers one saved bearer and refuses changed grants, IDs and revoked registrations", async () => {
    const registration = {
      id: randomUUID(),
      token: newApiToken(),
      subject: "visitor:registered:owner",
      groups: ["z", "a"],
    };
    expect(await Promise.all(Array.from({ length: 8 }, () => app.client.tokens.register(registration)))).toEqual(
      Array(8).fill(true),
    );
    expect(await app.client.tokens.register({ ...registration, groups: ["a", "z", "a"] })).toBe(true);
    for (const changed of [
      { token: newApiToken() },
      { subject: "another" },
      { groups: ["admin"] },
      { id: randomUUID() },
    ])
      expect(await app.client.tokens.register({ ...registration, ...changed })).toBe(false);
    await app.client.tokens.revoke({ id: registration.id });
    expect(await app.client.tokens.register(registration)).toBe(false);
    expect(await app.client.tokens.resolve(registration.token)).toBeUndefined();
  });

  it("reuses the stored bearer after a lost registration response from Postgres", async () => {
    const registration = app.client.tokens.register.bind(app.client.tokens);
    let lose = true;
    const driver = runtimeDriver({
      tokens: {
        ...app.client.tokens,
        register: async (input) => {
          const result = await registration(input);
          if (lose) {
            lose = false;
            throw new Error("synthetic lost database response");
          }
          return result;
        },
      },
    });
    const secrets = memorySecrets();
    const call = {
      idempotencyKey: "registration-loss:1",
      runId: "registration-loss",
      opId: "sanoma.token.mint",
      attempt: 1,
      secrets,
    };
    const input = {
      id: randomUUID(),
      subject: "visitor:lost:owner",
      groups: ["visitors"],
      store: "LOST_RECEIPT_TOKEN",
    };
    await expect(driver.ops["token.mint"]!(input, call)).rejects.toMatchObject({ retryable: true });
    const value = (await secrets.get(input.store))!;
    expect(await app.client.tokens.resolve(value)).toMatchObject({ subject: input.subject });
    expect(
      await driver.ops["token.mint"]!(input, { ...call, runId: "recovery", idempotencyKey: "recovery:1" }),
    ).toEqual({ id: input.id });
    expect(await secrets.get(input.store)).toBe(value);
  });

  it("is refused a direct call, as any operation that is not a read", async () => {
    await expect(
      app.client.call("sanoma.secret.generate", { name: "ACME_DIRECT", kind: "random" }, { actor: "ada" }),
    ).rejects.toThrow(/cannot be called directly/);
    expect(await stored("ACME_DIRECT")).toBeUndefined();
  });

  describe("ctx.startedBy", () => {
    it("is a person's id", async () => {
      expect(await run("whoami", {}, "ada")).toEqual({ id: "ada", email: null, github: null, subject: null });
    });

    it("is a visitor's id with the email and GitHub login their login verified", async () => {
      const visitor = { id: "visitor:better-auth:u1", email: "u1@acme.test" };
      expect(await run("whoami", {}, visitor)).toEqual({ ...visitor, github: null, subject: null });
      const linked = { ...visitor, github: "ada-lovelace" };
      expect(await run("whoami", {}, linked)).toEqual({ ...linked, subject: null });
    });

    it("is a token's id with its row's subject, never one the caller gives", async () => {
      const minted = await app.client.tokens.mint({ subject: "visitor:better-auth:owner-2", groups: ["visitors"] });
      const caller = {
        id: `token:${minted.id}`,
        groups: ["visitors"],
        subject: "someone-else",
        email: "x@acme.test",
        github: "someone",
      };
      expect(await run("whoami", {}, caller)).toEqual({
        id: `token:${minted.id}`,
        email: null,
        github: null,
        subject: "visitor:better-auth:owner-2",
      });
      await app.client.tokens.revoke({ id: minted.id });
      // Revoked, it starts nothing.
      await expect(run("whoami", {}, caller)).rejects.toMatchObject({ code: "not_admitted" });
    });
  });
});

describe("the runtime's own operations in a config", () => {
  it("are in every config, with their driver, for a workflow's `uses`", () => {
    const resolved = resolveConfig({ workflows: [keys], connectors: [] });
    for (const id of [
      "sanoma.secret.generate",
      "sanoma.secret.delete",
      "sanoma.invite.mint",
      "sanoma.token.mint",
      "sanoma.token.revoke",
    ]) {
      expect(resolved.ops.get(id)).toBeDefined();
      expect(resolved.drivers.get(id)).toBeDefined();
    }
  });

  it("are what a workflow imports, while sealInvite stays refused", () => {
    expect(
      messages(`import { defineWorkflow, sanoma } from "sanoma";\nexport const x = [defineWorkflow, sanoma];\n`),
    ).toEqual([]);
    expect(messages(`import { sealInvite } from "sanoma";\nexport const x = sealInvite;\n`)).toEqual([
      expect.stringMatching(/import \{ sealInvite \} from "sanoma" is not allowed|sealInvite/),
    ]);
  });

  it("run in a sandbox over the run's secrets and tokens of its own, posting nothing", async () => {
    const driver = sandboxRuntimeDriver();
    const secrets = memorySecrets({ ACME_SIGNING_KEY: SIGNING_KEY });
    const call = { idempotencyKey: "run:1", runId: "run", opId: "sanoma.invite.mint", attempt: 1, secrets };
    expect(
      await driver.ops["invite.mint"]!(
        { host: "https://acme.sanoma.work", email: "ada@acme.test", key: { $secret: "ACME_SIGNING_KEY" } },
        call,
      ),
    ).toEqual({ url: expect.stringMatching(/^https:\/\/acme\.sanoma\.work\/auth\/invite\/sandbox-/) });
    const { id } = (await driver.ops["token.mint"]!(
      { subject: "visitor:x:1", groups: [], store: "ACME_TOKEN" },
      { ...call, opId: "sanoma.token.mint" },
    )) as { id: string };
    expect(await secrets.get("ACME_TOKEN")).toMatch(/^sca_/);
    // A retry of the same call finds its own token stored.
    expect(
      await driver.ops["token.mint"]!(
        { subject: "visitor:x:1", groups: [], store: "ACME_TOKEN" },
        { ...call, opId: "sanoma.token.mint", attempt: 2 },
      ),
    ).toEqual({ id });
  });

  it("refuses the runtime's own SANOMA_ names as any operation's secret", () => {
    const resolved = resolveConfig({ workflows: [keys], connectors: [] });
    const parses = (op: string, input: object) => resolved.ops.get(op)!.input.safeParse(input).success;
    for (const name of [
      "SANOMA_SIGNING_KEY",
      "SANOMA_SECRETS_KEY",
      "SANOMA_GITHUB_APP_PEM",
      "SANOMA_DATABASE_URL",
      "SANOMA_DATABASE_URL_",
      "SANOMA_DATABASE_URL_bad",
      "SANOMA_DATABASE_URL_A-B",
      "SANOMA_MANAGED_IDENTITY_CREDENTIAL",
    ]) {
      expect(parses("sanoma.secret.generate", { name, kind: "random" })).toBe(false);
      expect(parses("sanoma.secret.delete", { name })).toBe(false);
      expect(parses("sanoma.token.mint", { subject: "x", groups: [], store: name })).toBe(false);
      expect(parses("sanoma.invite.mint", { host: "https://a.test", email: "a@a.test", key: { $secret: name } })).toBe(
        false,
      );
    }
    expect(parses("sanoma.secret.delete", { name: "ACME_KEY" })).toBe(true);
    const name = databaseUrlSecret("cloudAcme");
    expect(parses("sanoma.secret.delete", { name })).toBe(true);
    expect(parses("sanoma.secret.generate", { name, kind: "random" })).toBe(false);
    expect(parses("sanoma.token.mint", { subject: "x", groups: [], store: name })).toBe(false);
    expect(
      parses("sanoma.secretStore.prepare", {
        company: "acme",
        environment: "production",
        database: { $secret: "ADMIN_URL" },
        store: name,
      }),
    ).toBe(false);
    expect(
      parses("sanoma.identity.enroll", {
        deployment: "acme",
        company: "acme",
        environment: "production",
        serviceAccount: "runtime@example-project.iam.gserviceaccount.com",
        generation: 1,
        validUntil: "2030-01-01T00:00:00Z",
        store: name,
      }),
    ).toBe(false);
  });

  it("seals an invite under a key stored as base64url without padding, as a generate marker makes one", async () => {
    const bytes = randomBytes(32);
    const secrets = memorySecrets({ ACME_SIGNING_KEY: bytes.toString("base64url") });
    let request = "";
    const driver = runtimeDriver({
      tokens: memoryTokens(),
      invite: async (_host, sealed) => ((request = sealed), { url: "https://acme.test/auth/invite/x" }),
    });
    await driver.ops["invite.mint"]!(
      { host: "https://acme.test", email: "ada@acme.test", key: { $secret: "ACME_SIGNING_KEY" } },
      { idempotencyKey: "run:1", runId: "run", opId: "sanoma.invite.mint", attempt: 1, secrets },
    );
    vi.stubEnv("SANOMA_SIGNING_KEY", bytes.toString("base64url"));
    try {
      expect(openInvite(request)).toMatchObject({ email: "ada@acme.test" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a missing saved bearer without replacing or revoking another registration", async () => {
    const tokens = memoryTokens();
    const driver = runtimeDriver({ tokens });
    const call = {
      idempotencyKey: "run:2",
      runId: "run",
      opId: "sanoma.token.mint",
      attempt: 1,
      secrets: memorySecrets(),
    };
    const input = { subject: "visitor:x:1", groups: [], store: "ACME_TOKEN" };
    const { id } = (await driver.ops["token.mint"]!(input, call)) as { id: string };
    const original = (await call.secrets.get(input.store))!;
    // Deleting a saved bearer does not authorize another value for the existing token ID.
    await call.secrets.delete!("ACME_TOKEN");
    await expect(driver.ops["token.mint"]!(input, { ...call, attempt: 2 })).rejects.toThrow(/conflicting/);
    expect(await tokens.resolve(original)).toMatchObject({ principal: { id: `token:${id}` } });
    expect(await tokens.resolve((await call.secrets.get(input.store))!)).toBeUndefined();
  });

  it("does not register before the bearer is durably saved and reuses a lost store response", async () => {
    const tokens = memoryTokens(),
      stored = memorySecrets();
    const register = vi.spyOn(tokens, "register");
    let lose = true;
    const secrets = {
      ...stored,
      ensure: async (name: string, make: () => string) => {
        const value = await stored.ensure(name, make);
        if (lose) {
          lose = false;
          throw new Error("synthetic lost store response");
        }
        return value;
      },
    };
    const driver = runtimeDriver({ tokens });
    const input = { id: randomUUID(), subject: "visitor:stored:owner", groups: [], store: "STORED_FIRST_TOKEN" };
    const call = {
      idempotencyKey: "store-loss:1",
      runId: "store-loss",
      opId: "sanoma.token.mint",
      attempt: 1,
      secrets,
    };
    await expect(driver.ops["token.mint"]!(input, call)).rejects.toThrow(/lost store/);
    expect(register).not.toHaveBeenCalled();
    const value = (await stored.get(input.store))!;
    expect(await tokens.resolve(value)).toBeUndefined();
    expect(await driver.ops["token.mint"]!(input, { ...call, attempt: 2 })).toEqual({ id: input.id });
    expect(await stored.get(input.store)).toBe(value);
    expect(await tokens.resolve(value)).toMatchObject({ subject: input.subject });
  });

  it("derives no public half from a public key", () => {
    const pem = createPublicKey(createPrivateKeyPem()).export({ type: "spki", format: "pem" }).toString();
    expect(sshPublicKey(pem)).toBeUndefined();
  });
});
