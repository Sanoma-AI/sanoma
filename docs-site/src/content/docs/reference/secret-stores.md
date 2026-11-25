---
title: "Secret store configuration and migration"
description: "Look up store bindings, adapter operations, and the stages of a store migration."
sidebar:
  order: 10
---

## Secret store configuration

```ts
// sanoma.config.ts
import { defineConfig, type SecretConfiguration } from "sanoma";

const secrets = {
  namespace: "local",
  bindings: {
    SUPPORT_AUTH: { path: "mail/support", management: "sanoma" },
    FINANCE_AUTH: { path: "mail/finance", management: "external" },
    BUILD_TOKEN: { env: "CI_BUILD_TOKEN" },
    SANOMA_SIGNING_KEY: { bootstrap: "SANOMA_SIGNING_KEY" },
    SANOMA_SECRETS_KEY: { bootstrap: "SANOMA_SECRETS_KEY" },
  },
} satisfies SecretConfiguration;

export default defineConfig({ connectors: [], secrets });
```

Without `store`, the runtime uses its encrypted Postgres adapter. Without `namespace`, it uses `default`. An unbound name resolves to the same path in that namespace, managed by Sanoma. A `{ path, management: "external" }` binding is read-only to Sanoma even when its store can write. An `{ env }` binding reads that exact variable, is read-only, and does not fall back when absent. A `{ bootstrap }` binding explicitly exposes one deployment key to trusted host-secret resolution; it reads the corresponding environment or mounted-file input and never stores the key in Postgres.

Bootstrap keys and recovery are described [below](/hosting/secrets/#bootstrap-keys).

To deliver an additional environment binding to the [declared hosts](/hosting/hosts/), opt in with `RELAY_TOKEN: { env: "ACME_RELAY_TOKEN", host: true }`. Apply gives each deriving host the logical `secret("RELAY_TOKEN")` marker under `ACME_RELAY_TOKEN`; only the trusted host driver resolves its value. `host` is allowed only on environment bindings. Omitted or `false` adds no delivery beyond the host's existing derived bindings.

Two opted-in bindings cannot target the same environment variable, and a binding cannot replace a derived host binding with a different logical secret. An opted-in binding with no value where apply runs is a problem of the plan, before any vendor call: the host is left out, and the problem names the binding and the variable it reads (`RELAY_TOKEN (\`host: true\`) has no value where apply runs, …: set ACME_RELAY_TOKEN, …`).

This applies to declared deriving hosts that accept derived bootstrap, not hosts that bind their own bootstrap or company hosts created by workflows. A connector credential needs no host delivery: it is a [named connection](/workflows/credentials/#named-connections)'s bundle in the store, entered on the connector page. Company workflows must deliver only that company's runtime authority. Delivery uses the host's existing rollout behavior: it does not watch local environment changes or restart a host automatically.

For Cloudflare secret replacement, advance the non-secret `configurationRevision` and apply the host; see [the Worker](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/cloudflare/README.md#the-worker).

### Configure an external store

An external adapter is a `SecretStore` instance supplied as `secrets.store`. A database-backed adapter may instead supply a `SecretStoreFactory`, which the runtime binds to its own company database without opening a second pool. For managed Cloud, `managedKmsStore` from `sanoma/secrets` composes broker authentication and the [KMS-backed Postgres store](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/KMS-SECRETS.md#runtime-boundary), with a lazy SDK client owned and closed by the runtime.

Lower-level `kmsPostgresStore` accepts an explicit caller-owned KMS client; omit `database` to bind it to the runtime database. Factory adapters may expose `close()` for their own lazy clients; caller-supplied store instances remain caller-owned. It authenticates to one deployment's authorized storage before Sanoma can read values. Prefer a scoped workload identity where the adapter supports it; otherwise deliver its bootstrap credential through the host.

Do not make that credential depend on reading the same store it unlocks. The [Supabase Vault adapter](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/supabase/README.md#supabase-vault-as-the-secret-store) provides this boundary for BYOC. The [support matrix](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/SECRET-SUPPORT.md) lists the stores, what each credential method needs from one, connector coverage, deferred adapters and the trust limits.

Keep deployment composition in config code, outside workflows. For example, given an adapter instance already authenticated as `liveStore`:

```ts
import type { SecretConfiguration, SecretStore } from "sanoma";

export function stores(liveStore: SecretStore) {
  return {
    local: { namespace: "local" },
    preview: {
      namespace: "preview",
      bindings: { SUPPORT_AUTH: { env: "PREVIEW_MAIL_AUTH" } },
    },
    live: {
      store: liveStore,
      namespace: "live",
      bindings: { SUPPORT_AUTH: { path: "mail/support", management: "external" } },
    },
  } satisfies Record<"local" | "preview" | "live", SecretConfiguration>;
}
```

Pass exactly the selected configuration to `defineConfig`. A namespace is a routing boundary, not authorization: preview identities must be unable to read production values, and a built-in preview should have its own database and encryption key. Cloning the code grants no storage access. The config description exposes store ID, namespace and bindings, never the provider object or its credentials.

### Adapter operations

The adapter contract uses `read({ namespace, path })`, `write(address, value, { expectedVersion, by })`, `delete(address, { expectedVersion, by })` and `validate(namespace)`. A read returns an opaque version beside the value; `expectedVersion: null` creates only when absent, and a version replaces or deletes only that version. `ensure` uses create-if-absent and reads the winner of a concurrent creation. Providers advertise writable access, a byte limit, conditional-write guarantees (`atomic`, `coordinated` or `none`), deletion behavior and change detection.

`coordinated` covers cooperating Sanoma writers only; it cannot promise safety against external writers. Unsupported conditional writes are refused, not emulated with an unsafe read followed by a write.

The built-in adapter stores one encrypted value or credential bundle per namespace/path, with a fresh version on each write. AES-256-GCM authenticates the complete namespace/path identity. It rejects plaintext rows and ciphertext moved to another address. `SecretStoreError` returns fixed codes without provider responses or secret values. Connector authentication declares its own versioned schema with `defineAuthentication`: `api-key`, `fields`, `oauth2` or `signed`, with storage requirements.

Every method keeps a bundle in the store. A credential a named method needs is entered on its connector page (or obtained by consent, for `oauth2`), never an environment variable the config reads: the [GCP provisioning identity](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/gcp/README.md#deployment-identity) stores its bootstrap bearer as an `api-key` bundle and declares the identity's other facts in code.

Connector authors use `checkAuthenticationStore`, `encodeCredentials` and `decodeCredentials` inside trusted code. The runtime runs the same check for every declared connection and creation rule: a method that writes its credentials (an OAuth refresh) bound to an `{ env }`, `{ bootstrap }` or external binding, one that needs conditional writes in a store without them, or one larger than the store holds, is a setup problem on its connector page card (`storageProblem`) and in `sanoma check`, and its preview is refused.

Nothing is copied to another store instead. OAuth consent and renewal are described [below](/workflows/credentials/#connecting-by-oauth-consent).

Adapter authors can run `checkSecretStore(store, disposableNamespace)` from `sanoma/workflows`. It checks missing values, ownership, contention, stale versions, namespace separation, size limits and the advertised deletion behavior. It mutates test records; use a scoped test identity and clean up retained versions according to the provider. `memorySecretStore()` is the in-process reference implementation, not persistent deployment storage.

## Moving between stores

A config may name other stores beside the selected one, `secrets.stores`: `{ <name>: { store?, namespace? } }`, each a store instance or factory (none is the built-in store) and its namespace, the same shape as the selected store's. Naming one changes nothing by itself; it is where a move may take the secrets, or where a finished move retires them from.

The built-in `migrate-store` workflow (registered when `stores` names any) moves them, in this order, each step an operation of `sanoma.storeMigration` that the policy decides and the ledger records, with names, versions and sizes and never a value:

1. `plan` (read, direct): the secrets Sanoma knows, from the connections' declarations and rule-created accounts, OAuth applications, the bindings and the data files' `secret()` references, plus any `names` the input adds (a host's derived secrets are not found by themselves); a data file that does not load is a problem. Each is `copy`, `kept` (an OAuth application whose destination already holds another: its grants are flagged `reauthorize: "client_changed"`), `external`, `bound` (an `{ env }` or `{ bootstrap }` binding, not in a store) or `missing`.

   A destination value Sanoma did not write is a problem, never overwritten.
2. `prepare` (access): `checkSecretStore` on the destination in a disposable namespace (`sanoma-move-check` and `sanoma-move-check-other`; a Vault login needs grants for them), the capabilities against each secret, then the move's receipts (`sanoma_secret_moves`, `sanoma_secret_move_items`). One move at a time.
3. `transfer` (write): pauses writes at the source (the fence: every runtime's writes and deletes there are refused `read_only` until the move cuts over or is cancelled), once any OAuth renewal of a grant kept there that has sent its refresh token has stored its grant (the run waits, two seconds at a time), then copies each value with expected versions on both sides. A renewal while the fence holds fails closed (`unavailable`) before it spends the refresh token, and the grant still valid keeps serving.

   A connect or reconnect fails the same way before it spends its code, and a disconnect or revoke is refused before anything changes. Resumed, it skips what its receipts show copied, replaces only its own earlier copy, and adopts an equal value. A value it did not write ends the move (cancelled, the fence lifted), as does a source value that changes once the code has switched.
4. `verify` (read): reads each copy back and compares it with the source in memory. A value that changed at the source since its copy is copied again. The run then waits, checking again from five seconds to five minutes apart, until the deployed code selects the destination; the source stays paused for writes meanwhile, so make the switch soon after the copies verify.
5. `cutover` (access): once the code selects the destination (the reviewed change: switch `secrets.store` and `namespace` to the destination's and name the old store under `stores`), and every copy still reads back equal, rebinds each connection to the new location (its fingerprint names the store) and starts the rollback window, `retainHours` (default 168). The old store stays fenced, so an old runtime still running cannot write there.
6. `retire` (write): after the window, deletes the old copies Sanoma manages at the versions it copied. One changed since, an externally managed one, or a store that cannot delete is kept and named.

`cancel` (write, direct) stops a move before its cutover, while the code still selects the source, and lifts the fence; the copies already made stay at the destination, named. A rollback after the cutover is a move back. The run's id is the move's; a stop anywhere resumes where it was. The app's Secret storage panel starts, follows and cancels moves ([its README](/using-the-app/connections/#connection-management)); `client.storeMoves({ actor })` reads them. Vendor tokens are never revoked.
