---
title: Secrets
description: "Choose a secret store, supply bootstrap keys, and reference secrets from company resources."
sidebar:
  order: 3
---

By default, Sanoma stores encrypted secrets in the company’s Postgres. Set `secrets` in `sanoma.config.ts` to select a `SecretStore` or runtime-bound store factory. For example, a company can use its own [Supabase Vault](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/supabase/README.md#supabase-vault-as-the-secret-store).

Use `connections` and `connectionRules` to declare the accounts a workflow can select. Workflow code names the connection. Resource data files refer to secrets by name. The app’s [connection forms](/using-the-app/connections/#connection-management) verify and save accounts through the selected store. Going live uses explicitly declared default connections for vendors with named authentication. See [configuration and ownership rules](/workflows/credentials/).

For managed Cloud configuration, `import { managedKmsStore } from "sanoma/secrets"` supplies the [KMS-backed Postgres store](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/KMS-SECRETS.md#runtime-boundary) from a fixed company/key reference and broker `{ endpoint, credential }`. The runtime uses its existing database pool and opens and closes the KMS client itself. Keep the credential reader in trusted deployment config; workflow code uses logical secret references. This helper does not provision infrastructure or establish deployed Cloud readiness.

## Bootstrap keys

| Deployment input     | Purpose                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANOMA_SIGNING_KEY` | Signs sessions and authorization state. Preserve it between restarts. Replacing it invalidates signed sessions and pending authorization state. On a host it also protects staff token keys. See [how to clear those keys](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/better-auth/README.md#agents-signing-in). |
| `SANOMA_SECRETS_KEY` | Encrypts rows in the built-in Postgres store. An external store uses its provider’s bootstrap identity.                                                                                                                                                                                                                            |

Each key is an independent random 32-byte value encoded as base64. Supply the variable or its `_FILE` counterpart, with the base64 value in the mounted file. Conflicting sources, unreadable files, and malformed values fail before startup without printing the value. On first local start the launcher generates missing keys in the ignored `.env` file, creating the file with mode `0600`. With an external store it generates only the signing key.

The template uses explicit `{ bootstrap: "SANOMA_SIGNING_KEY" }` and `{ bootstrap: "SANOMA_SECRETS_KEY" }` bindings. Deliver the signing key, database authentication, and store bootstrap through the host’s secret mechanism. Supply a mounted path on the machine that reads it.

Back up the database ciphertext with its namespace, path, and version metadata. Keep a separate backup of the matching encryption key. Replacing that key requires re-encrypting every retained row. Automated key rotation is unavailable. Rotating a vendor token updates the stored value. To change backends, use the [store migration workflow](/reference/secret-stores/#moving-between-stores).

On a Cloudflare host, apply resolves each binding on the machine that applies it (a `_FILE` key is read there) and uploads the value as a Worker secret; the container receives the Worker's secrets as its environment when it starts, and keeps them until its next start. There, `{ env }` and `{ bootstrap }` bindings read those values, refuse writes and deletes, and read as missing when the host was not given them. Being in the environment is how a value is delivered, not how it is kept: it is plain to code in the Worker and the container.

Cloudflare's account-wide Secrets Store is not a supported store. See [Cloudflare secrets](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/cloudflare/README.md#secrets) for what a host is given, the token's permissions and the Supabase setups.

### Managed Cloud identity

The managed Cloud [runtime identity broker](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/CLOUD-IDENTITY.md) supplies refreshable, deployment-bound Google access tokens; its enrollment, bootstrap and rollout requirements are separate from credential storage and provisioning identity.

In the trusted control plane, configure `identityProvisioning: { databaseUrl: secret("IDENTITY_WRITER_URL") }` to use `sanoma.identity.enroll`, `.retire` and `.revoke` under policy. A company's runtime bearer has no expiry: a deploy replaces it with a new generation and retires the old one, and closing the company or a leak revokes it. The restricted enrollment-writer URL is entered under that name on the app's Hosting page (Connect) and read from the store when an enrollment operation first uses it, never at config load.

Until it is stored, the page lists it as missing and enrollment fails with "the enrollment writer is not set". Each client and worker owns its lazy writer pool; company runtimes and the broker do not receive it. See [provisioning operations](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/CLOUD-IDENTITY.md#provisioning-operations) for setup, rotation and the caller-owned adapter option.

## Secrets

Never put a secret in a workflow's input or an operation's input or output. They are persisted verbatim: DBOS keeps every step's input and output in Postgres, the ledger records each call's input and output, an approval a policy asks for carries the held call's input, and the app shows all of it to anyone who can reach it. A driver reads its credentials when it is called (from the environment or a secret store), and an operation that creates a secret (an API key, a password reset link) returns a reference to where it is stored, not the secret.

A secret a resource needs is named, never written. A data file gives `secret("NAME")` (from `sanoma/resources`; `NAME` upper case, as a variable's; sanoma's own, `SANOMA_…`, only in a host's `secrets`) at a write-only field (or an entry of a write-only map), and `secret("NAME", { generate: true })` for one apply makes when none is stored: `database_password: secret("SUPABASE_DB_PASSWORD", { generate: true })`.

Declarations, checkpoints and the ledger hold its marker, `{ "$secret": "NAME", "generate": true }`; the resource type refuses one at any other field, and its schema does not judge it.

The driver resolves the markers just before the vendor call, `await resolveSecrets(input, call.secrets)`: each is replaced by the stored value, a `generate` one with none stored first made (32 random bytes, base64url) and stored, and one with nothing stored fails the call for good, before the vendor call, with the `vendorCode` `secret_not_set` (the run's ledger then says nothing changed at the vendor).

`call.secrets` is `{ get(name), ensure(name, make), delete?(name) }`, resolved through the configured store and explicit bindings (see [Credentials](/workflows/credentials/)); a fake's and a sandbox run's are in memory (`memorySecrets()`, which a driver's tests use too).
