# @sanoma/bridge

Everything OpenTofu in Sanoma. A TypeScript client for [`provider-bridge`](https://github.com/Sanoma-AI/provider-bridge), the Go sidecar that runs OpenTofu providers and serves their schema, import and read over ConnectRPC on a unix socket; a fake that replays the bridge's recorded replies; and, at `@sanoma/bridge/tfschema`, the generator that turns a provider's schema into a connector's resource types, with its `sanoma-tfschema` bin. Connectors for bridged vendors (GitHub, Stripe) are built on it; nothing in the browser may import it. It depends on `@sanoma/workflows` (a peer), never the other way round.

## Usage

```ts
import { readPins, startBridge } from "@sanoma/bridge";

const { "integrations/github": github } = readPins();
const bridge = await startBridge(); // SANOMA_BRIDGE_BIN, or { bin }
const { schema } = await bridge.schema(github!); // schema.protocol: 5
await bridge.configure(github!, JSON.stringify({ owner: "Sanoma-AI", token: process.env.GITHUB_TOKEN }));
const { resources } = await bridge.import(github!, "github_repository", "provider-bridge");
const [repo] = resources;
const { resource, gone } = await bridge.read(
  github!,
  "github_repository",
  repo!.stateJson,
  repo!.private,
  repo!.schemaVersion,
);
await bridge.stop();
```

`startBridge({ bin?, cacheDir?, socketPath?, env?, args?, logger?, readyTimeoutMs?, timeoutMs?, interceptors? })` spawns `provider-bridge serve --socket <path> --watch-stdin`, waits for its ready line, and connects with `@connectrpc/connect-node` over HTTP/1.1 on the socket. The bridge watches its stdin, which stays open, so it exits with this process; `stop()` closes stdin and waits for it to stop its providers. Each JSON line it writes on stderr goes to `logger` (default: warnings and errors to `console.error`). It inherits only `HOME`, `PATH`, the temp, cache, proxy and TLS variables, plus `env`.

| `Bridge` method                                         | Returns                                        | Notes                                                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema(ref)`                                           | `{ schema: SchemaDocument, sha256 }`           | No credentials. `schema.protocol` is 5 or 6; `sha256` is the release's SHA256SUMS hash. Parsed once per release and hash.                                        |
| `configure(ref, configJson)`                            | `{ warnings }`                                 | The same config again is a no-op; another config fails (`failed_precondition`) until `close(ref)`.                                                               |
| `import(ref, typeName, id)`                             | `{ resources: ResourceState[], warnings }`     | Import, then read each result. Nothing found: `not_found`, though GitHub's provider fails with `failed_precondition` and a diagnostic (a connector's `missing`). |
| `read(ref, typeName, stateJson, priv?, schemaVersion?)` | `{ resource?: ResourceState, gone, warnings }` | `gone: true` (no `resource`) when the object no longer exists. Pass back the `private` and `schemaVersion` you got: the state is upgraded.                       |
| `close(ref?)`                                           | nothing                                        | Stops one configured provider, or all.                                                                                                                           |
| `stop()`                                                | nothing                                        | Stops the bridge.                                                                                                                                                |

A `ProviderRef` is `{ source, version, sha256? }`; `readPins()` returns the pinned ones keyed by source (`integrations/github`, `stripe/stripe`, `hashicorp/null`). A `ResourceState` is `{ typeName, stateJson, private, schemaVersion }`. JSON values stay strings (`configJson`, `stateJson`) so numbers keep full precision: parse them where that does not matter. The schema document is parsed (`SchemaDocument`, with `Block`, `Attribute`, `NestedType`, `NestedBlock` and `CtyType` mirroring the bridge README).

A failed call throws a `BridgeError` with `code` (Connect's, spelled `invalid_argument`, `failed_precondition`, `unavailable`, `not_found`, ...) and `diagnostics` (the provider's error diagnostics: `{ severity, summary, detail, attributePath }`). `unavailable` means the provider exited, or the bridge's socket is missing, refused or reset: configure again.

`ensureConfigured(bridge, ref, configJson, call?)` is the configure lifecycle a driver needs: it configures the provider on first use, closes and configures it again when the config changes (a new token), runs `call`, configures again on the next call after `unavailable`, and when the bridge says the provider is not configured (a restarted bridge, another client's `close`) configures it and retries `call` once. Its configure steps run one at a time per bridge and release, so concurrent calls and drivers sharing a bridge configure once. It takes any `ProviderClient` (`configure`, `import`, `read` and `close` of a `Bridge`).

## The fake

`fakeBridge({ fixtures?, bridge? })` from `@sanoma/bridge/fake` is a `Bridge` that answers from fixtures (default: this package's `testdata/`), through the same Connect client as the real one (an in-memory router transport), so errors map the same way. It refuses what the bridge refuses: a call before `configure`, another config, an unknown resource type, a pin that does not match the release's sha256 (from `pins.json`, or for a release not pinned there, the sha256 its recorded replies carry; a pin it has nothing to check against is refused too). `calls` lists every call sent, logged by a Connect interceptor on the in-memory transport and the real one alike. Schema documents are parsed once per file for every fake in the process. A call no fixture covers fails, `failed_precondition` for a schema and `not_found` for an import or read, naming the file to record.

Fixtures, in provider-bridge's format (its `cmd/bridge-record` writes the same):

- `pins.json`: `{ "<source>": { version, sha256, note } }`.
- `schemas/<ns>_<type>_<version>.json`: the schema document, as `GetSchema` returns it.
- `replies/<ns>_<type>_<version>/<resource type>/<import id slug>/{import,read}.json`: `{ provider, request, response, scrubbed }`. `request` and `response` are the bridge's messages in Connect's JSON form (bytes base64, int64 as strings); a failed call has `response: { error: { code, message, diagnostics } }`. The slug replaces every run of characters outside `[A-Za-z0-9._-]` with `_` (`repo:main` is `repo_main`). The fake finds an import by its ID and a read by the `id` in the request's state, so a read of any state with that `id` gets the recorded reply.

`stateBridge(state, calls?)` is the other fake, for connectors' fakes: a `ProviderClient` over a `BridgeState` (`{ objects }`, plain JSON by `<typeName>/<import id>`) that `loadReplies(fixtures, ref)` builds from the recorded replies of a release (each object with the state its read returned, or its import's failure; a read recorded without its import is keyed by its state's `id`). It reads the state on every call, so a test can change an object (drift) or remove it (`gone`), and refuses what the bridge refuses with real `BridgeError`s. `fixturesDir` is this package's `testdata/` as a path.

`SANOMA_LIVE=1` sends the fake's calls to a real bridge (`startBridge(bridge)`), and `SANOMA_LIVE=1 SANOMA_RECORD=1` also rewrites the fixtures it touches (the same variables as [`@sanoma/testing/replay`](../testing/README.md#replaying-a-vendors-api)). Recording fetches the schema before `configure` and scrubs: every value of an attribute the schema marks `sensitive` becomes `"<scrubbed>"`; every state string equal to a string in the configure config becomes `"<scrubbed>"`; every config value that is sensitive in the provider's schema or named like a secret (`token`, `api_key`, `password`, ...) is replaced wherever it appears, raw, JSON-escaped or base64, by `<scrubbed:config.<path>>`, and a file in which one survives is not written. `private` stays as base64, and a reply whose private data holds a secret is refused. `scrubbed` lists the paths hit and the secrets. Read the diff, and grep it for credentials, before committing.

## Connectors for OpenTofu providers

`tfConnector({ vendor, provider, types, references, missing, info })` from `@sanoma/bridge/connector` is a whole connector for a vendor with an OpenTofu provider, from its generated types (`resources.gen.ts`, see [`src/tfschema/`](src/tfschema/AGENTS.md)). A vendor package keeps only what the schema does not say:

```ts
import { tfConnector } from "@sanoma/bridge/connector";
import { github_repository, provider } from "./resources.gen.ts";

export const githubTf = tfConnector({
  vendor: "github",
  provider,
  types: { repository: { tf: github_repository, title: "Repository", identity: "name", find: ({ name }) => name } },
  // Fields that name another declared resource, by type, and what else the vendor holds there:
  // the schema types them as strings.
  references: { branch_protection: { repository_id: { type: "github.repository", by: ["name", "node_id"] } } },
  // Which of the bridge's errors mean "no such object": default `not_found`.
  missing: (e) => e.code === "not_found" || e.diagnostics.some((d) => d.summary.startsWith("could not find ")),
  info: { title: "GitHub", logo: { svg }, package: "@sanoma/connector-github" },
});
githubTf.connector; // for defineConfig and workflows: github.repository.read, github.repository.import
githubTf.resources; // the data-file constructors: githubTf.resources.repository({ name: "sanoma" })
githubTf.driver(bridge, () => ({ token: process.env.GITHUB_TOKEN })); // the driver; the config is read per call
```

Each type becomes a resource type (`defineResource`, with the generated schema and fields, its `references` as `fields.references`, and an optional `normalize`), given to `defineConnector` under its name; `info.package` is needed, since data files import the constructors from `<package>/resources`. The driver's `import` asks the provider to find the object (the bridge reads it too); `read` refreshes a state from an earlier call, or imports when it has none, or one without an `id`. Either answers `{ gone: true }` when the provider finds nothing, or fails with an error `missing(e)` accepts (`(e: BridgeError) => boolean`, default `e.code === "not_found"`): how each provider says an object is not there is its own, and GitHub's is a `failed_precondition` whose diagnostic says it "could not find" it. States go out in the resource's shape, secrets dropped (`fromTfState`), and come back in the provider's (`toTfState`). The provider is configured through `ensureConfigured`. The bridge's errors become `DriverError`s with its code as `vendorCode` and the provider's diagnostics in the message, retryable only on `unavailable`.

The provider's private data and state version travel in the operation's opaque `handle` (`<version>:<base64>`), so they pass through the runtime: DBOS's step records keep them as they keep every operation's output. The ledger does not: the resource operations declare `handle` opaque, and the ledger records it as `"<handle>"`. Providers rarely put anything but a state version there, but this is a known residual risk: the recorder refuses a fixture whose private data holds a configured secret, and nothing checks the runtime's copies.

`tfFake(githubTf, { fixtures?, missingReply?, file?, calls? })` from `@sanoma/bridge/fake` is the connector's fake: its real driver over a `stateBridge` of the replies recorded for its release (default: this package's `testdata/`), with every fault `defineFake` gives and, with fields in the resource's shape, `put(type, id, fields, { from? })` (an object under that import id, over a copy of the recorded one `from` names; its provider `id` is `fields.id`, else the import id), `override(type, id, fields)` and `remove(type, id)` to simulate drift. After `remove`, an import answers as the provider would for a missing object: `missingReply(type, id)`, a bridge error as a fixture records one, or `not_found` without it.

## Environment

| Variable            | What it is                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `SANOMA_BRIDGE_BIN` | The `provider-bridge` binary `startBridge` runs when no `bin` is given.                           |
| `SANOMA_BRIDGE_SRC` | The provider-bridge checkout `pnpm bridge:download` builds from (default: found beside the repo). |
| `SANOMA_LIVE`       | `1`: the fake calls a real bridge; the live test runs.                                            |
| `SANOMA_RECORD`     | `1`, with `SANOMA_LIVE=1`: the fake rewrites its fixtures.                                        |

`pnpm bridge:download` (at the repo root or here) runs `go build -mod=vendor -o packages/bridge/bin/provider-bridge ./cmd/provider-bridge` in the checkout, with the Go the checkout pins (through `mise x` when mise is installed), and prints the `export SANOMA_BRIDGE_BIN=...` line. `bin/` is gitignored. Downloading a pinned release by checksum is a stub (`RELEASE` and `downloadRelease` in the script) until provider-bridge publishes releases.

## Supply chain

- **Pinned providers, never upgraded implicitly.** Every call names an exact version and, from `pins.json`, the sha256 of the release's SHA256SUMS; the bridge refuses any other release. A pin changes only by hand, in a commit that re-records that release's schema and replies.
- **Verified by the bridge.** The bridge downloads from registry.opentofu.org only, checks SHA256SUMS' OpenPGP signature and the zip's checksum, and runs only the verified binary (see provider-bridge's README).
- **Credentials only through `configure`.** The bridge gets a minimal environment and passes providers a smaller one; a driver reads its token per call and sends it in the config, never in a data file or the environment.
- **One bridge per tenant.** A configured provider holds that tenant's credentials.

## Develop

- `pnpm run generate` rewrites `src/gen/` from `proto/` with buf and `protoc-gen-es` (versions pinned in `package.json`; `@bufbuild/protobuf` at the same version). Never edit `src/gen/` by hand; CI checks it is up to date. When the bridge's proto changes, copy it here verbatim, note the bridge commit above, and regenerate.
- `testdata/` is a verbatim copy of provider-bridge's (not formatted, not hand-edited): copy it again when the bridge re-records.
- `SANOMA_LIVE=1 pnpm vitest run packages/bridge` also builds the bridge and runs `hashicorp/null`, downloaded once into `provider-bridge-test` in the user cache directory.

Status: early (0.x). License: Apache-2.0.
