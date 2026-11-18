---
title: Credentials
description: "The runtime separates a secret's storage, a connector's authentication method, and the named account used by a call."
sidebar:
  order: 4
---

The runtime separates a secret's storage, a connector's authentication method, and the named account used by a call. `secret("NAME")` remains a logical reference. `SanomaConfig.secrets` selects the store and maps names to locations; `connections` and `connectionRules` declare account requirements. Credential values stay outside code, workflow inputs, durable steps, descriptions and ledger records.

The store resolver is used by the worker's `call.secrets`, resource secret resolution, `SanomaClient` reads and mutations, and the app's login/model/remote secret lookup. It does not copy values into `process.env` or fall back to another store. Some shipped connector drivers still declare an `env` schema and read process variables themselves; migrating those drivers and their SDK/bridge sessions to connection-scoped authentication is a separate step. Registering a named connection does not by itself migrate such a driver.

`client.setCredential(name, value, { by })` validates a driver-declared name and writes through the configured binding. `client.setSecret(name, value, { by })` also accepts undeclared logical names. `client.clearCredential(name, { by })` conditionally deletes a declared value; `client.clearSecret(name, { by })` also accepts undeclared logical names. These operations refuse an externally managed binding or a read-only store. `client.credentials()` returns statuses, storage location, ownership and available change metadata without values; `client.secrets(names)` returns values to trusted server code only. The provider is validated when the client or worker starts; missing connector credentials can still be entered later.

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

Without `store`, the runtime uses its encrypted Postgres adapter. Without `namespace`, it uses `default`. An unbound name resolves to the same path in that namespace, managed by Sanoma. A `{ path, management: "external" }` binding is read-only to Sanoma even when its store can write. An `{ env }` binding reads that exact variable, is read-only, and does not fall back when absent. A `{ bootstrap }` binding explicitly exposes one deployment key to trusted host-secret resolution; it reads the corresponding environment or mounted-file input and never stores the key in Postgres. Bootstrap keys and recovery are described [below](#bootstrap-keys).

To deliver an additional environment binding to the [declared hosts](/hosting/hosts/), opt in with `RELAY_TOKEN: { env: "ACME_RELAY_TOKEN", host: true }`. Apply gives each deriving host the logical `secret("RELAY_TOKEN")` marker under `ACME_RELAY_TOKEN`; only the trusted host driver resolves its value. `host` is allowed only on environment bindings. Omitted or `false` adds no delivery beyond the host's existing derived bindings. Two opted-in bindings cannot target the same environment variable, and a binding cannot replace a derived host binding with a different logical secret. An opted-in binding with no value where apply runs is a problem of the plan, before any vendor call: the host is left out, and the problem names the binding and the variable it reads (`RELAY_TOKEN (\`host: true\`) has no value where apply runs, …: set ACME_RELAY_TOKEN, …`).

This applies to declared deriving hosts that accept derived bootstrap, not hosts that bind their own bootstrap or company hosts created by workflows. A connector credential needs no host delivery: it is a [named connection](#named-connections)'s bundle in the store, entered on the connector page. Company workflows must deliver only that company's runtime authority. Delivery uses the host's existing rollout behavior: it does not watch local environment changes or restart a host automatically. For Cloudflare secret replacement, advance the non-secret `configurationRevision` and apply the host; see [the Worker](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/cloudflare/README.md#the-worker).

An external adapter is a `SecretStore` instance supplied as `secrets.store`. A database-backed adapter may instead supply a `SecretStoreFactory`, which the runtime binds to its own company database without opening a second pool. For managed Cloud, `managedKmsStore` from `sanoma/secrets` composes broker authentication and the [KMS-backed Postgres store](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/KMS-SECRETS.md#runtime-boundary), with a lazy SDK client owned and closed by the runtime. Lower-level `kmsPostgresStore` accepts an explicit caller-owned KMS client; omit `database` to bind it to the runtime database. Factory adapters may expose `close()` for their own lazy clients; caller-supplied store instances remain caller-owned. It authenticates to one deployment's authorized storage before Sanoma can read values. Prefer a scoped workload identity where the adapter supports it; otherwise deliver its bootstrap credential through the host. Do not make that credential depend on reading the same store it unlocks. The [Supabase Vault adapter](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/supabase/README.md#supabase-vault-as-the-secret-store) provides this boundary for BYOC. The [support matrix](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/SECRET-SUPPORT.md) lists the stores, what each credential method needs from one, connector coverage, deferred adapters and the trust limits.

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

The adapter contract uses `read({ namespace, path })`, `write(address, value, { expectedVersion, by })`, `delete(address, { expectedVersion, by })` and `validate(namespace)`. A read returns an opaque version beside the value; `expectedVersion: null` creates only when absent, and a version replaces or deletes only that version. `ensure` uses create-if-absent and reads the winner of a concurrent creation. Providers advertise writable access, a byte limit, conditional-write guarantees (`atomic`, `coordinated` or `none`), deletion behavior and change detection. `coordinated` covers cooperating Sanoma writers only; it cannot promise safety against external writers. Unsupported conditional writes are refused, not emulated with an unsafe read followed by a write.

The built-in adapter stores one encrypted value or credential bundle per namespace/path, with a fresh version on each write. AES-256-GCM authenticates the complete namespace/path identity. It rejects plaintext rows and ciphertext moved to another address. `SecretStoreError` returns fixed codes without provider responses or secret values. Connector authentication declares its own versioned schema with `defineAuthentication`: `api-key`, `fields`, `oauth2` or `signed`, with storage requirements. Every method keeps a bundle in the store. A credential a named method needs is entered on its connector page (or obtained by consent, for `oauth2`), never an environment variable the config reads: the [GCP provisioning identity](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/gcp/README.md#deployment-identity) stores its bootstrap bearer as an `api-key` bundle and declares the identity's other facts in code.

Connector authors use `checkAuthenticationStore`, `encodeCredentials` and `decodeCredentials` inside trusted code. The runtime runs the same check for every declared connection and creation rule: a method that writes its credentials (an OAuth refresh) bound to an `{ env }`, `{ bootstrap }` or external binding, one that needs conditional writes in a store without them, or one larger than the store holds, is a setup problem on its connector page card (`storageProblem`) and in `sanoma check`, and its preview is refused. Nothing is copied to another store instead. OAuth consent and renewal are described [below](#connecting-by-oauth-consent).

Adapter authors can run `checkSecretStore(store, disposableNamespace)` from `sanoma/workflows`. It checks missing values, ownership, contention, stale versions, namespace separation, size limits and the advertised deletion behavior. It mutates test records; use a scoped test identity and clean up retained versions according to the provider. `memorySecretStore()` is the in-process reference implementation, not persistent deployment storage.

## Moving between stores

A config may name other stores beside the selected one, `secrets.stores`: `{ <name>: { store?, namespace? } }`, each a store instance or factory (none is the built-in store) and its namespace, the same shape as the selected store's. Naming one changes nothing by itself; it is where a move may take the secrets, or where a finished move retires them from. The built-in `migrate-store` workflow (registered when `stores` names any) moves them, in this order, each step an operation of `sanoma.storeMigration` that the policy decides and the ledger records, with names, versions and sizes and never a value:

1. `plan` (read, direct): the secrets Sanoma knows, from the connections' declarations and rule-created accounts, OAuth applications, the bindings and the data files' `secret()` references, plus any `names` the input adds (a host's derived secrets are not found by themselves); a data file that does not load is a problem. Each is `copy`, `kept` (an OAuth application whose destination already holds another: its grants are flagged `reauthorize: "client_changed"`), `external`, `bound` (an `{ env }` or `{ bootstrap }` binding, not in a store) or `missing`. A destination value Sanoma did not write is a problem, never overwritten.
2. `prepare` (access): `checkSecretStore` on the destination in a disposable namespace (`sanoma-move-check` and `sanoma-move-check-other`; a Vault login needs grants for them), the capabilities against each secret, then the move's receipts (`sanoma_secret_moves`, `sanoma_secret_move_items`). One move at a time.
3. `transfer` (write): pauses writes at the source (the fence: every runtime's writes and deletes there are refused `read_only` until the move cuts over or is cancelled), once any OAuth renewal of a grant kept there that has sent its refresh token has stored its grant (the run waits, two seconds at a time), then copies each value with expected versions on both sides. A renewal while the fence holds fails closed (`unavailable`) before it spends the refresh token, and the grant still valid keeps serving. A connect or reconnect fails the same way before it spends its code, and a disconnect or revoke is refused before anything changes. Resumed, it skips what its receipts show copied, replaces only its own earlier copy, and adopts an equal value. A value it did not write ends the move (cancelled, the fence lifted), as does a source value that changes once the code has switched.
4. `verify` (read): reads each copy back and compares it with the source in memory. A value that changed at the source since its copy is copied again. The run then waits, checking again from five seconds to five minutes apart, until the deployed code selects the destination; the source stays paused for writes meanwhile, so make the switch soon after the copies verify.
5. `cutover` (access): once the code selects the destination (the reviewed change: switch `secrets.store` and `namespace` to the destination's and name the old store under `stores`), and every copy still reads back equal, rebinds each connection to the new location (its fingerprint names the store) and starts the rollback window, `retainHours` (default 168). The old store stays fenced, so an old runtime still running cannot write there.
6. `retire` (write): after the window, deletes the old copies Sanoma manages at the versions it copied. One changed since, an externally managed one, or a store that cannot delete is kept and named.

`cancel` (write, direct) stops a move before its cutover, while the code still selects the source, and lifts the fence; the copies already made stay at the destination, named. A rollback after the cutover is a move back. The run's id is the move's; a stop anywhere resumes where it was. The app's Secret storage panel starts, follows and cancels moves ([its README](/start/the-app/#connection-management)); `client.storeMoves({ actor })` reads them. Vendor tokens are never revoked.

## Named connections

A connector declares authentication methods in `withSetup(connector, { authentication: { methodName: definition } })`. Code then declares each account independently, sharing the connector and its driver factory. For a connector `mail` that declares an `apiKey` method:

```ts
import { defineConfig, defineConnection, defineConnectionRule } from "sanoma";
import { secret } from "sanoma/resources";
import { mail } from "@acme/mail";

const support = defineConnection(mail, {
  name: "support",
  method: "apiKey",
  credentials: secret("SUPPORT_AUTH"),
  scopes: ["messages:read"],
  account: "support@example.test",
});
const sales = defineConnection(mail, {
  name: "sales",
  method: "apiKey",
  credentials: secret("SALES_AUTH"),
  scopes: ["messages:read"],
});
const customer = defineConnectionRule(mail, {
  name: "customer",
  method: "apiKey",
  createBy: [{ group: "visitors" }],
  scopes: ["messages:read"],
});

export default defineConfig({
  connectors: [mail],
  connections: [support, sales],
  connectionRules: [customer],
});
```

`@acme/mail` is an illustrative connector, not a shipped package. `support` is also a typed `ConnectionRef<"mail">`, with ID `mail/support`. A workflow selects it in operation options, for example `ctx.mail.message.read({ id: "one" }, { connection: { vendor: "mail", $connection: "mail/support" } })`; a server-side direct call passes `connection: support` alongside its `actor`. A connector with authentication methods requires a selector unless exactly one declaration is marked `default: true`; one connected account alone is not an implicit default. Existing business-resource targets remain unchanged. Cedar sees optional `context.connection` metadata: ID, vendor, method, account, scopes and revision.

Connection creation rules accept principal IDs or `{ group: "visitors" }` for authenticated customer sign-ups. The runtime uses admitted groups and owns each dynamic connection by the initiating principal. Disconnect invalidates the account revision and blocks new selection; for an OAuth grant it also deletes the stored grant, and Revoke ends it at the provider ([renewal, Reconnect, Disconnect and Revoke](#renewal-reconnect-disconnect-and-revoke)). Visitors also need a Cedar permit for the relevant operation; a creation rule does not bypass policy.

`sanoma.connection.bind` is a policy-controlled access operation. Its input contains a declared reference, the granted account and scopes, and `expectedRevision` (`null` for an initial binding). It persists metadata and a new revision, never credential values. `sanoma.connection.create` takes a declared rule ID, account and scopes; the actor must be in `createBy`. It creates an owner-scoped dynamic ID without a repository commit. Trusted code can make a typed reference with `connectionRef(rule, id)`, but the runtime still verifies the stored owner and declaration on use. These low-level metadata operations are not a credential-entry interface or proof of vendor consent. Use the secure intake APIs below for user-entered values; each named invocation also verifies the current bundle.

A durable call pins its account revision before policy evaluation. A held direct call carries the same pin into its durable continuation. The runtime checks that the binding and definition still match before execution; rebinding or changing requirements requires a fresh call and authorization. Policy approvals cannot silently authorize a different account. The ledger records connection metadata, not its credential bundle. This changes the durable step layout; old runs are not replayed against the new layout.

Named drivers explicitly opt into methods with `defineDriver(connector, implementation, { authentication: ["apiKey"] })`. Each method supplies `verify(credentials)`, which checks the provider and returns `{ account, scopes, expiresAt? }`; expiry is Unix milliseconds. A missing verifier or unsupported driver is refused. After policy allows the operation, the runtime reads only the selected bundle, validates its schema, verifies that its account and grants still match the authorized metadata, and rechecks the binding after verification. Changed grants or expired credentials require reconnection. Verifier exceptions expose no SDK messages or causes.

The driver reads `authenticationCredentials("apiKey", definition, call)` inside its operation and creates a client for that invocation. `defineDriver` also accepts a factory `(call) => implementation`, invoked inside that boundary, for operations sharing one SDK client during a call. `call.authentication.credentialVersion` identifies the version read. The runtime keeps no credential or SDK cache: replacement affects the next invocation, while a call already executing retains its original bundle. Never put this material in an operation result. Named calls' `call.secrets` can resolve only auxiliary secret markers in their authorized input, and `ensure` additionally requires a marker with `generate: true`. An operation may declare generated destinations with `createsSecrets(input)`, such as a database connector storing a URL under the authorized resource export's name; these are exact logical names, not wildcard store access. Driver failures retain retryability and HTTP status, with a fixed message and no provider cause. Direct calls and durable calls use the same driver boundary.

Resource declarations use the same identity as an option, loaded with the rest of the data file:

```ts
import { mail } from "@acme/mail/resources";

export const inbox = mail.inbox({ name: "support" }, { connection: { vendor: "mail", $connection: "mail/support" } });
```

The resource type must belong to that connector. Apply and drift pin the selected revision when they read declarations, then carry it through imports, plans and effects. The resource lockfile records the connection alongside the vendor object ID. Changing the account of a bound resource requires an explicit unbind/rebind; a default change or a same-name account replacement cannot redirect a later apply. The app exposes these declarations through its [connection management](/start/the-app/#connection-management) forms.

Sandbox runs use synthetic identities for declared static connections, with separate fake state, faults and remembered replies for each account and run. They never read production connection records, invoke authentication verifiers or read production credentials. A production revision or an undeclared dynamic account is refused. Scenario steps can select an account in their returned seed, such as `{ op: mail.message.create, input: { title }, connection: support }`; absent a selector, only an explicitly declared default is used. Fault seeds accept the same `connection` field. Standalone driver tests can use `connectionFakes(makeFake)` from `sanoma/workflows/fake`: its `driver` requires `call.connection`, `account(ref)` exposes just that account's fake for seeding and fault injection, and `calls` is the combined log with connection IDs. Rebinding a reference to a different vendor account starts fresh fake state.

## Connecting and managing accounts

Use `SanomaClient.previewConnection(target, credentials, { actor, id })` and `connectConnection(review, credentials, { actor })` for secure account intake. These are trusted server APIs, not workflow operations: credential values must never be passed to `client.call`, workflow arguments or an approval. `target` is either `{ connection: ref }` for a declared account or `{ rule: "vendor/rule" }` for an authorized dynamic account. Keep the same request ID while completing one review; a new account or a changed review starts a new request.

Preview runs the metadata-only `sanoma.connection.prepare` access gate before reading a store or verifying submitted credentials. The connector verifies the account and granted scopes against the code's requirements. The returned `ConnectionReview` contains metadata only: the verified account and scopes, destination, existing account/destination when present, expected revisions and the authorization fingerprint. It never returns credentials. An externally managed or read-only binding accepts no pasted replacement; preview reads its existing bundle.

Save rechecks the review, policy and destination, verifies the credentials again, then calls `sanoma.connection.configure` to reserve a `pending` account revision. It writes a managed bundle directly through the selected store with the reviewed expected version, outside durable execution. An opaque stored-version receipt records a successful write so resuming the same approved setup does not blindly repeat it. `sanoma.connection.activate` is a separate access gate: it verifies the saved bundle before making that revision usable. These gates, Test and Disconnect use ordinary policy decisions and ledger records containing metadata only. When a gate asks for approval, return to the secure form and retry after the decision; an approval never stores the form's credential values for later replay.

`pending` and `uncertain` accounts cannot run operations. An ambiguous store write or a failure after writing can leave `uncertain`; it must be inspected and reverified rather than treated as a successful connection or blindly written again. A policy, account, scope, destination or binding revision change invalidates the relevant review and requires fresh verification. Changing a destination does not copy or delete the previous value: the review identifies both locations. To move every value to another store, use [Moving between stores](#moving-between-stores).

The read APIs are scoped to the admitted actor:

- `client.connections({ actor })` returns `ConnectionCard` metadata for company declarations and that actor's dynamic accounts, including requirements, account, scopes, ownership, current/bound storage location, change attribution and last-tested health. Listing cards does not read credentials or contact a vendor.
- `client.connectionRules({ actor })` returns creation choices permitted by the current code's `createBy` person IDs or `{ group }` entries. Creating under a rule still passes policy and ownership checks.
- `client.secretStoreStatus({ actor })` validates the selected store's bootstrap access and reports its ID, namespace, capabilities and a sanitized readiness problem. It neither enumerates nor reads credential values.

Call `sanoma.connection.test` with `{ connection }` to verify the current bundle under policy. Its health result is a timestamped observation, not a live guarantee or background monitor: it can report expired, revoked, wrong-account, changed-scope, invalid, unavailable or store-denied states. An external bundle whose opaque version differs from the prior test is marked externally renewed. A later vendor or store change is detected on the next Test or authorized invocation.

`sanoma.connection.disconnect` takes `{ connection, expectedRevision }` and makes the binding unusable under a new revision. For any method but `oauth2` it deletes no stored value and revokes nothing at the vendor; externally managed values remain with their owner. An OAuth grant has its own lifecycle: [renewal, Reconnect, Disconnect and Revoke](#renewal-reconnect-disconnect-and-revoke). Moving values to another store is [its own workflow](#moving-between-stores). The app's [connection forms](/start/the-app/#connection-management) implement this secure intake and show these states; they do not add a second configuration source.

## Connecting by OAuth consent

A method of kind `oauth2` connects an account by the provider's consent instead of a pasted value. The connector owns the flow; the runtime defines the grant's schema (`oauthGrant`: `accessToken`, `tokenType`, optional `refreshToken`, `expiresAt` in Unix milliseconds and `scopes`):

```ts
export const oauth = defineAuthentication({
  kind: "oauth2",
  version: 1,
  storage: { writable: true, conditionalWrites: true, maxBytes: 16_384 },
  oauth: {
    authorizeUrl: "https://example.test/oauth/authorize",
    tokenUrl: "https://example.test/oauth/token",
    scopes: ["messages:read"],
    pkce: true,
    clientAuthentication: "client_secret_basic",
  },
  verify: async (grant) => ({ account: await accountOf(grant.accessToken), scopes: grant.scopes ?? [] }),
});
```

Endpoints are `https`, or `http` on a loopback host for tests. A declaration names two secrets: `credentials`, the grant, and `client`, the company's own OAuth application (`{ clientId, clientSecret }`, schema `oauthClient`). They are separate bundles, so several accounts can share one application and a grant never holds the client secret. `client` is refused on any other kind of method:

```ts
const ops = defineConnection(mail, {
  name: "ops",
  method: "oauth",
  credentials: secret("MAIL_OPS"),
  client: secret("MAIL_OAUTH_APP"),
});
```

The flow has three trusted steps and one workflow:

1. `client.authorizeConnection(target, { actor, id, redirectUri, client? })` runs `sanoma.connection.authorize`, a policy gate that carries metadata only, with `replacesApplication` true when `client` is given, so a policy can hold or deny replacing the OAuth application every account of the connection or rule shares. It then stores the application when `client` is given, or reads the stored one. It makes a single-use state and a PKCE verifier and returns the consent URL, the attempt's opaque ID and its expiry. The state's hash and the sealed verifier are kept in the `sanoma_connection_attempts` row, bound to the actor, connection, setup request, client ID and redirect URI. They never enter workflow history. `redirectUri` must end in `/connect/<vendor>/callback` (`connectionCallbackPath`).
2. The provider sends the person back. `client.receiveConnection(vendor, attempt, params, { actor })` checks the attempt's actor, state, expiry and vendor and seals the code into the row. It takes a callback once. Then it starts the built-in `connect` workflow (in a config only when a declared connection or rule connects by OAuth) with the attempt's ID alone (run ID `connect:<attempt>`); if that start fails, the attempt ends `unavailable`. A refused callback throws a `CallbackError` whose `reason` is `expired`, `mismatch`, `replayed`, `declined` or `rejected`.
3. `connect` calls `sanoma.connection.exchange`, which only that workflow may call. It takes the code and verifier once, posts them to the token endpoint and verifies the grant. It checks the declared account and scopes, writes the grant with the store's expected version and returns metadata only. Then `sanoma.connection.activate` verifies the stored grant. Both are ordinary policy decisions and ledger records.
4. `client.connectionAttempt(attempt, { actor })` reports `waiting`, `exchanging`, `connected` or `failed`, with the problem when it failed and `approval_pending` while a gate waits for approval.

A code is never sent twice. If the provider issued a grant and the store did not keep it, the account is `uncertain` and the attempt fails with `uncertain`: connect again for a new grant. An attempt expires ten minutes after it starts, and again ten minutes after its callback: an exchange held for an approval must be approved within that time, as the provider's code expires too. Expired rows are swept an hour later. An `oauth2` method needs a writable store with conditional writes. Any other store is refused before consent, so a person never authorizes a grant the store cannot keep. The protocol is [oauth4webapi](https://github.com/panva/oauth4webapi), which runs on Node and on Cloudflare Workers.

## Renewal, Reconnect, Disconnect and Revoke

`refresh: "refresh_token"` on the flow declares that the provider renews grants with a refresh token (RFC 6749 section 6). `tokenRejected` names the HTTP statuses (400 to 499) by which the provider says it refused an access token, such as `[401]`. `refreshTokenLifetime` is how many seconds a refresh token stays usable unused (an hour to ten years), counted from its last renewal, for a provider that publishes it; a provider whose refresh tokens lapse a fixed time after consent, renewed or not, still needs Reconnect then. A method's `revoke(grant, client)` revokes a grant at the provider, for a provider with a revocation endpoint:

```ts
oauth: { /* ... */ refresh: "refresh_token", tokenRejected: [401], refreshTokenLifetime: 30 * 86_400 },
revoke: async (grant, client) => { /* the provider's revocation request */ },
```

A grant renews on use. Renewal is always `refreshGrant` (oauth4webapi's refresh request), written with the store's expected version, as the exchange writes it:

- **Near expiry.** A call that authenticates a grant expiring within five minutes renews it first. If the renewal is `unavailable` and the grant has not expired, the call goes on with it, and the next call asks again.
- **On a declared rejection.** A driver error whose `status` is in `tokenRejected`, or a verifier that answers `rejected`, renews the grant once and retries once. A second rejection fails the call. A status the connector did not declare is never retried.

Renewal on use is part of the call that needs it, which the policy already allowed: it is not a policy decision or a ledger record of its own. That is the design.

An idle instance is never woken to renew an access token: scale to zero keeps one registered wake. A wake is scheduled only to keep a **refresh token** alive, and only when the flow declares `refreshTokenLifetime`. Then each stored grant's next renewal is a row (`due_at`, when a tenth of the refresh token's lifetime is left). The worker counts the earliest as a deadline (`worker.deadlines`, [Hosts](/hosting/hosts/)), so a worker that stops when idle registers it with its wakeup; nothing in process keeps it running. When it comes, the runtime's `renewal` agent calls `sanoma.connection.refresh`, a policy decision and ledger record like any other. A policy that forbids it stops that account's scheduled renewals, and use renews it again. Without `refreshTokenLifetime` (Supabase publishes none), a grant nobody uses is renewed by the next call that uses it, or needs Reconnect if its refresh token lapsed meanwhile.

One process renews a connection at a time. A lease in `sanoma_connection_renewals` (one minute, a holder ID fencing every write under it) covers the read, the refresh request and the write; a process that finds the lease held waits for the grant the holder stores. Before the request goes out, the holder marks the lease sent. A refresh token is never sent twice, so these leave the account `uncertain`, under a new revision, and the card asks for **Reconnect**:

- The provider answered and the store did not keep the new grant, or another writer changed it in between.
- The request was sent and had no answer (the connection dropped, or a timeout), since the provider may have rotated the refresh token. A connection that failed before anything was sent (no address, refused, unreachable, a connect timeout, TLS refusing the server) is `unavailable` instead: the grant still in force keeps being used and the renewal is asked again later.
- A lease lapsed after its holder sent the request (a worker that stopped mid-renewal): the next process does not resend it.

A provider's `invalid_grant` is `revoked`; any other refusal is `rejected`, and `429` is `unavailable` (tried again later). Each renewal's outcome and time are kept for the card, never a token. `sanoma.connection.test` reports `expiresAt` and `refreshedAt` beside the health state; `sanoma.connection.refresh` takes `{ connection }` and returns `{ id, refreshed, expiresAt? }`.

**Reconnect** is a new consent: its exchange takes the same lease, replaces the grant whole with the expected version and starts the renewal history again. **Disconnect** deletes the grant Sanoma keeps (a store that cannot delete keeps it, unusable under the new revision) and forgets its renewal. The OAuth application stays, since other accounts may share it. **Revoke** (`sanoma.connection.revoke`, `{ connection, expectedRevision }`) is a policy decision of its own: it calls the method's `revoke` with the grant and the company's application, then disconnects as above. It is `unsupported` for a method without `revoke`, and changes nothing when the provider does not confirm (`unavailable`). An externally managed grant is never deleted. Calls already sent with a grant are not undone.

## Bootstrap keys

`SANOMA_SIGNING_KEY` signs application sessions and authorization state. `SANOMA_SECRETS_KEY` encrypts rows only for the built-in Postgres store. They are independent 32-byte random values encoded as base64. Each accepts exactly one source: the variable itself or its `_FILE` counterpart, whose file holds that base64 value. Conflicting sources, unreadable files and malformed values fail without printing the key. The launcher creates missing local keys in ignored `.env`; newly created files have mode `0600`. With an external store, it creates only the signing key.

For a host deployment, deliver signing material, database authentication and the adapter's bootstrap through that host's secret delivery mechanism; include the encryption key only for the built-in store. A mount path is local to the process reading it: do not send a laptop's `_FILE` path to a remote container. Explicit bootstrap bindings let a host resource receive the key value through its secret channel while code keeps only the reference.

On a Cloudflare host, apply resolves each binding on the machine that applies it (a `_FILE` key is read there) and uploads the value as a Worker secret; the container receives the Worker's secrets as its environment when it starts, and keeps them until its next start. There, `{ env }` and `{ bootstrap }` bindings read those values, refuse writes and deletes, and read as missing when the host was not given them. Being in the environment is how a value is delivered, not how it is kept: it is plain to code in the Worker and the container. Cloudflare's account-wide Secrets Store is not a supported store. See [Cloudflare secrets](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/cloudflare/README.md#secrets) for what a host is given, the token's permissions and the Supabase setups.

The managed Cloud [runtime identity broker](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/CLOUD-IDENTITY.md) supplies refreshable, deployment-bound Google access tokens; its enrollment, bootstrap and rollout requirements are separate from credential storage and provisioning identity.

In the trusted control plane, configure `identityProvisioning: { databaseUrl: secret("IDENTITY_WRITER_URL") }` to use `sanoma.identity.enroll`, `.retire` and `.revoke` under policy. A company's runtime bearer has no expiry: a deploy replaces it with a new generation and retires the old one, and closing the company or a leak revokes it. The restricted enrollment-writer URL is entered under that name on the app's Hosting page (Connect) and read from the store when an enrollment operation first uses it, never at config load. Until it is stored, the page lists it as missing and enrollment fails with "the enrollment writer is not set". Each client and worker owns its lazy writer pool; company runtimes and the broker do not receive it. See [provisioning operations](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/CLOUD-IDENTITY.md#provisioning-operations) for setup, rotation and the caller-owned adapter option.

Back up ciphertext, its namespace/path and version metadata, and the matching encryption key separately. A database-only backup cannot recover encrypted values. Preserve the signing key across ordinary restarts; replacing it invalidates sessions and pending signed authorization state. Changing a vendor token updates a stored value and its version; it does not rotate the row-encryption key. Replacing the encryption key without re-encrypting every retained value makes those values unreadable. Automated encryption-key rotation is not included. A move to another store is the [`migrate-store` workflow](#moving-between-stores), and an OAuth grant that needs new consent is reconnected from its card.
