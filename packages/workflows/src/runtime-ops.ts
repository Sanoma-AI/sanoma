import { createHash } from "node:crypto";
import { z } from "zod";
import { keyBytes } from "./deployment-key.ts";
import { type CallContext, defineConnector, defineDriver, DriverError, retryableStatus } from "./op.ts";
import { generateSecret, SECRET_NAME } from "./secret.ts";
import { sealInvite } from "./seal.ts";
import { errorMessage } from "./shared.ts";
import { sourceKeyPair, sshPublicKey } from "./ssh-key.ts";
import { memoryTokens, type Tokens } from "./tokens.ts";
import type { InspectRun } from "./run-status.ts";
import {
  identityProvisioningCode,
  memoryIdentityProvisioning,
  type IdentityProvisioning,
} from "./identity-provisioning.ts";
import {
  prepareSecretStore,
  memoryStorageProvisioning,
  storageProvisioningCode,
  type PrepareStorage,
} from "./storage-provisioning.ts";

// What a workflow cannot do itself and the runtime does for it, as operations of the vendor
// `sanoma` (`sanoma.secret.*`, `sanoma.invite.mint`, `sanoma.token.*`): named in `uses`, decided by
// the policy, recorded in the ledger, and never answering a secret's value. `resolveConfig`
// registers them in every config with their driver (`runtimeDriver`), so a policy may name them;
// a sandbox run calls `sandboxRuntimeDriver`, over its own secrets and tokens, posting nothing.

/** A secret's name, as the store takes it (upper case), other than the runtime's own (`SANOMA_…`: its keys and credentials). */
const SecretName = z
  .string()
  .regex(SECRET_NAME, "a secret's name: upper case, A-Z, 0-9 and _")
  .refine((name) => !name.startsWith("SANOMA_"), "a SANOMA_ name is the runtime's own, not a workflow's to use");

/** How long an instance gets to answer `POST /auth/invite`. */
const INVITE_TIMEOUT_MS = 10_000;

const DeploymentIdentity = z.object({
  deployment: z.string().min(1).max(256),
  company: z.string().min(1).max(256),
  environment: z.string().min(1).max(256),
  serviceAccount: z.string().regex(/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/),
});
const Generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdentityTarget = ({ deployment }: { deployment: string }) => deployment;

// Enrollment implementations can see credential hashes and database credentials. Neither their
// errors nor causes may be captured in durable driver history, including on an uncertain commit.
async function identityWrite(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    const code = identityProvisioningCode(error) ?? "unavailable";
    throw new DriverError(`Identity provisioning: ${code}`, { retryable: code === "unavailable" });
  }
}

/**
 * The runtime's own operations a workflow calls: `import { sanoma } from "sanoma"`, then
 * `uses: [sanoma.secret.generate]` and `ctx.sanoma.secret.generate({ name, kind })`.
 */
export const sanoma = defineConnector("sanoma", {
  run: {
    inspect: {
      effect: "read",
      idempotent: true,
      description:
        "Inspect a run's status in this application without its input, output or error. A snapshot, not a lock or proof that cancelled vendor calls have stopped",
      input: z.object({ runId: z.string().min(1).max(512) }),
      output: z.object({
        runId: z.string(),
        status: z.enum(["missing", "active", "finished", "failed", "cancelled"]),
        workflow: z.string().optional(),
      }),
      target: ({ runId }: { runId: string }) => runId,
    },
  },
  secretStore: {
    prepare: {
      effect: "access",
      idempotent: true,
      description:
        "Prepare a company/environment KMS Postgres schema and restricted runtime login; store its database URL without returning credentials",
      input: z.object({
        company: z.string().min(1).max(256),
        environment: z.string().min(1).max(256),
        database: z.strictObject({ $secret: z.string().regex(SECRET_NAME) }),
        store: SecretName,
      }),
      output: z.object({ company: z.string(), environment: z.string(), role: z.string(), store: z.string() }),
      target: ({ company, environment }: { company: string; environment: string }) =>
        JSON.stringify([company, environment]),
      createsSecrets: ({ store }: { store: string }) => [store],
    },
  },
  identity: {
    enroll: {
      effect: "access",
      idempotent: true,
      description:
        "Enroll a deployment identity, keeping its bootstrap credential in the secret store. A higher generation rotates it; mappings are immutable",
      input: DeploymentIdentity.extend({ generation: Generation, validUntil: z.iso.datetime(), store: SecretName }),
      output: z.object({ deployment: z.string(), generation: Generation, store: z.string() }),
      target: IdentityTarget,
      createsSecrets: ({ store }: { store: string }) => [store],
    },
    retire: {
      effect: "access",
      idempotent: true,
      description:
        "Shorten an old identity generation's validity after delivering its replacement; never extend access",
      input: DeploymentIdentity.extend({ generation: Generation, validUntil: z.iso.datetime() }),
      output: z.object({}),
      target: IdentityTarget,
    },
    revoke: {
      effect: "access",
      idempotent: true,
      description: "Disable all token renewal for a deployment. This deployment id cannot be re-enrolled",
      input: DeploymentIdentity,
      output: z.object({}),
      target: IdentityTarget,
    },
  },
  secret: {
    generate: {
      effect: "write",
      // A value stored is kept: a retry answers what the first try stored.
      idempotent: true,
      description:
        "Make a secret and store it under a name: a random value, or an RSA key pair whose private half (PEM) is stored and whose public half (OpenSSH) is answered. A name stored already is kept",
      input: z.object({
        name: SecretName,
        kind: z.enum(["random", "ssh-rsa"]).describe("random: 32 random bytes; ssh-rsa: an RSA deploy key"),
      }),
      output: z.object({
        name: z.string(),
        publicKey: z.string().optional().describe("For ssh-rsa: the public half, `ssh-rsa <base64>`"),
      }),
      target: ({ name }: { name: string }) => name,
      createsSecrets: ({ name }: { name: string }) => [name],
    },
    delete: {
      effect: "write",
      idempotent: true,
      description: "Delete a stored secret; one not stored is nothing to do",
      input: z.object({ name: SecretName }),
      output: z.object({}),
      target: ({ name }: { name: string }) => name,
      createsSecrets: ({ name }: { name: string }) => [name],
    },
  },
  invite: {
    mint: {
      effect: "access",
      // Each try seals a new request (good for `sealInvite`'s few minutes), and the instance's newest
      // invite for an email replaces the last.
      idempotent: true,
      description:
        "Ask an instance for an invite link that signs a declared person in: a request sealed under the instance's signing key, named by a secret marker, posted to its /auth/invite",
      input: z.object({
        host: z.url({ protocol: /^https?$/ }).describe("The instance's address, such as https://acme.sanoma.work"),
        email: z.email().describe("The email the instance's people file declares"),
        key: z
          .strictObject({ $secret: SecretName })
          .describe('The instance\'s SANOMA_SIGNING_KEY, as stored here: secret("NAME")'),
      }),
      output: z.object({ url: z.string().describe("The one-use invite link the instance minted") }),
      target: ({ host }: { host: string }) => host,
      // A link that signs someone in: the ledger records that there was one, not what it was.
      opaque: ["url"],
    },
  },
  token: {
    mint: {
      effect: "access",
      description:
        "Mint an api token acting for a subject in groups, store it under a name, and answer its id (never the token)",
      input: z.object({
        subject: z.string().regex(/^\S+$/, "a principal's id, such as visitor:better-auth:<id>"),
        groups: z.array(z.string().min(1)),
        store: SecretName.describe("The secret the token is stored under"),
      }),
      output: z.object({ id: z.string() }),
      target: ({ subject }: { subject: string }) => subject,
      createsSecrets: ({ store }: { store: string }) => [store],
    },
    revoke: {
      effect: "access",
      idempotent: true,
      description: "Revoke an api token: it resolves to nobody from now on",
      input: z.object({ id: z.string().min(1) }),
      output: z.object({}),
      target: ({ id }: { id: string }) => `token:${id}`,
    },
  },
});

/** A `DriverError` that a retry would not change. */
const refuse = (message: string) => new DriverError(`sanoma: ${message}`, { retryable: false });

/** The token id a call mints, from its idempotency key: the same on every try of one call, so a retry finds its own. */
function tokenIdOf(call: CallContext) {
  const hex = createHash("sha256").update(call.idempotencyKey).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The 32 bytes of a signing key stored as text (base64, or base64url as `generate` makes one), or a refusal. */
function signingKeyOf(secret: string, text: string | undefined): Buffer {
  if (text === undefined) throw refuse(`the secret ${secret} is not set: store the instance's signing key under it`);
  const key = keyBytes(text);
  if (!key) throw refuse(`${secret} is not a signing key: 32 bytes in base64`);
  return key;
}

/**
 * Posts the sealed `request` to the instance's `/auth/invite`, and answers the link it minted
 * (`sanoma.invite.mint`, and going live's sign-in); a `DriverError` otherwise, retryable by status.
 */
export async function postInvite(host: string, request: string): Promise<{ url: string }> {
  const at = new URL("/auth/invite", host);
  let res: Response;
  try {
    res = await fetch(at, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
      // A redirect is answered as it is (a 3xx, not retried): the sealed request goes to `host` alone.
      redirect: "manual",
      signal: AbortSignal.timeout(INVITE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DriverError(`sanoma: ${at.host} could not be reached: ${errorMessage(err)}`, {
      retryable: true,
      cause: err,
    });
  }
  const body = (await res.json().catch(() => undefined)) as { url?: unknown; error?: unknown } | undefined;
  if (res.ok && typeof body?.url === "string") return { url: body.url };
  const why = typeof body?.error === "string" ? `: ${body.error}` : res.ok ? ": no url" : "";
  throw new DriverError(`sanoma: ${at.host} answered ${res.status} to POST /auth/invite${why}`, {
    retryable: !res.ok && retryableStatus(res.status),
    status: res.status,
  });
}

/**
 * The driver of the runtime's own operations, over the call's secrets and `tokens` (the config's
 * database's, `tokenStore`); `invite` posts a sealed request to an instance (`postInvite` by default).
 */
export function runtimeDriver({
  tokens,
  identities,
  inspect,
  storage = prepareSecretStore,
  invite = postInvite,
}: {
  tokens: Tokens;
  identities?: IdentityProvisioning;
  inspect?: InspectRun;
  storage?: PrepareStorage;
  invite?: (host: string, request: string, call: CallContext) => Promise<{ url: string }>;
}) {
  return defineDriver(sanoma, {
    run: {
      async inspect({ runId }) {
        if (!inspect) throw refuse("run inspection is not configured");
        try {
          return await inspect(runId);
        } catch {
          throw new DriverError("Run inspection unavailable", { retryable: true });
        }
      },
    },
    secretStore: {
      async prepare(input, call) {
        try {
          return await storage(input, call.secrets);
        } catch (error) {
          const code = storageProvisioningCode(error) ?? "unavailable";
          throw new DriverError(`Storage provisioning: ${code}`, { retryable: code === "unavailable" });
        }
      },
    },
    identity: {
      async enroll({ store, ...input }, call) {
        if (!identities) throw refuse("identity provisioning is not configured");
        // Store before enrolling: a lost DB response retries with the same credential, never a new bearer.
        const credential = await call.secrets.ensure(store, generateSecret);
        if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw refuse("invalid identity bootstrap credential");
        await identityWrite(() =>
          identities.enroll({ ...input, hash: createHash("sha256").update(credential).digest("hex") }),
        );
        return { deployment: input.deployment, generation: input.generation, store };
      },
      async retire(input) {
        if (!identities) throw refuse("identity provisioning is not configured");
        await identityWrite(() => identities.retire(input));
        return {};
      },
      async revoke(input) {
        if (!identities) throw refuse("identity provisioning is not configured");
        await identityWrite(() => identities.revoke(input));
        return {};
      },
    },
    secret: {
      async generate({ name, kind }, call) {
        if (kind === "random") {
          await call.secrets.ensure(name, generateSecret);
          return { name };
        }
        // A pair made only when none is stored: the public half is always derived from what is.
        let stored = await call.secrets.get(name);
        if (stored === undefined) {
          const pair = await sourceKeyPair();
          stored = await call.secrets.ensure(name, () => pair.privateKey);
        }
        const publicKey = sshPublicKey(stored);
        if (!publicKey)
          throw refuse(`${name} holds a value that is not an RSA private key: delete it, or name another`);
        return { name, publicKey };
      },
      async delete({ name }, call) {
        await call.secrets.delete(name);
        return {};
      },
    },
    invite: {
      async mint({ host, email, key }, call) {
        const signingKey = signingKeyOf(key.$secret, await call.secrets.get(key.$secret));
        const request = sealInvite({ email }, signingKey);
        return invite(host, request, call);
      },
    },
    token: {
      async mint({ subject, groups, store }, call) {
        const id = tokenIdOf(call);
        const held = await call.secrets.get(store);
        if (held !== undefined) {
          // This call's own, stored by a try whose answer was lost.
          if ((await tokens.resolve(held))?.principal.id === `token:${id}`) return { id };
          throw refuse(`${store} holds a value already: delete it, or store the token under another name`);
        }
        let token: string;
        try {
          ({ token } = await tokens.mint({ id, subject, groups }));
        } catch (err) {
          // A try that minted this id and stopped before storing it left a token nobody holds: revoked here.
          if ((await tokens.subjectOf(id)) === undefined) throw err;
          await tokens.revoke({ id });
          throw refuse(`an earlier try minted token ${id} and stopped before storing it: it is revoked, start again`);
        }
        if ((await call.secrets.ensure(store, () => token)) !== token) {
          await tokens.revoke({ id });
          throw refuse(`${store} was stored by someone else meanwhile: the token minted is revoked`);
        }
        return { id };
      },
      async revoke({ id }) {
        await tokens.revoke({ id });
        return {};
      },
    },
  });
}

/**
 * The runtime's own operations for one sandbox run: the run's secrets (in memory), tokens in
 * memory, and an invite that posts nothing, answering a link on the host named.
 */
export const sandboxRuntimeDriver = () =>
  runtimeDriver({
    tokens: memoryTokens(),
    inspect: async (runId) => ({ runId, status: "missing" }),
    identities: memoryIdentityProvisioning(),
    storage: memoryStorageProvisioning(),
    invite: async (host, _request, call) => ({ url: new URL(`/auth/invite/sandbox-${tokenIdOf(call)}`, host).href }),
  });
