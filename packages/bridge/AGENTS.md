# @sanoma/bridge

A TypeScript client for [`provider-bridge`](https://github.com/Sanoma-AI/provider-bridge), the Go sidecar that runs OpenTofu providers and serves their schema, import and read over ConnectRPC on a unix socket, and a fake that replays the bridge's recorded replies. Connectors for bridged vendors (GitHub, Stripe) call it from their drivers; nothing in the browser may import it.

## Contents

| Path                                                           | What it is                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`src/`](src/AGENTS.md)                                        | The client, the fake, the recorder, the schema document types and the generated Connect code            |
| [`test/`](test/AGENTS.md)                                      | The fake over the checked-in fixtures, error mapping, the recorder, and a live test (`SANOMA_LIVE=1`)   |
| [`proto/bridge/v1/bridge.proto`](proto/bridge/v1/bridge.proto) | The bridge's API, a verbatim copy of `provider-bridge/proto/bridge/v1/bridge.proto` at a2fc11a          |
| [`buf.gen.yaml`](buf.gen.yaml)                                 | Config for `pnpm run generate`, which writes `src/gen/` from `proto/` with `protoc-gen-es`              |
| [`testdata/`](testdata/README.md)                              | Pins, schema documents and recorded replies, copied from `provider-bridge/testdata` at a2fc11a          |
| [`scripts/download-bridge.ts`](scripts/download-bridge.ts)     | `pnpm bridge:download`: builds `bin/provider-bridge` from a provider-bridge checkout (releases: a stub) |

## Usage

```ts
import { readPins, startBridge } from "@sanoma/bridge";

const { "integrations/github": github } = readPins();
const bridge = await startBridge(); // SANOMA_BRIDGE_BIN, or { bin }
const { schema } = await bridge.schema(github!);
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

| `Bridge` method                                         | Returns                                        | Notes                                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema(ref)`                                           | `{ schema: SchemaDocument, protocol, sha256 }` | No credentials. `protocol` is 5 or 6; `sha256` is the release's SHA256SUMS hash.                                                           |
| `configure(ref, configJson)`                            | `{ warnings }`                                 | The same config again is a no-op; another config fails (`failed_precondition`) until `close(ref)`.                                         |
| `import(ref, typeName, id)`                             | `{ resources: ResourceState[], warnings }`     | Import, then read each result. Nothing found: `not_found`, though GitHub's provider fails with `failed_precondition` and a diagnostic.     |
| `read(ref, typeName, stateJson, priv?, schemaVersion?)` | `{ resource?: ResourceState, gone, warnings }` | `gone: true` (no `resource`) when the object no longer exists. Pass back the `private` and `schemaVersion` you got: the state is upgraded. |
| `close(ref?)`                                           | nothing                                        | Stops one configured provider, or all.                                                                                                     |
| `stop()`                                                | nothing                                        | Stops the bridge.                                                                                                                          |

A `ProviderRef` is `{ source, version, sha256? }`; `readPins()` returns the pinned ones keyed by source (`integrations/github`, `stripe/stripe`, `hashicorp/null`). A `ResourceState` is `{ typeName, stateJson, private, schemaVersion }`. JSON values stay strings (`configJson`, `stateJson`) so numbers keep full precision: parse them where that does not matter. The schema document is parsed (`SchemaDocument`, with `Block`, `Attribute`, `NestedType`, `NestedBlock` and `CtyType` mirroring the bridge README).

A failed call throws a `BridgeError` with `code` (Connect's, spelled `invalid_argument`, `failed_precondition`, `unavailable`, `not_found`, ...) and `diagnostics` (the provider's error diagnostics: `{ severity, summary, detail, attributePath }`). `unavailable` means the provider exited: configure again.

## The fake

`fakeBridge({ fixtures?, bridge? })` from `@sanoma/bridge/fake` is a `Bridge` that answers from fixtures (default: this package's `testdata/`), through the same Connect client as the real one (an in-memory router transport), so errors map the same way. It refuses what the bridge refuses: a call before `configure`, another config, an unknown resource type, a pin that does not match `pins.json`. `calls` lists every call. A call no fixture covers fails, `failed_precondition` for a schema and `not_found` for an import or read, naming the file to record.

Fixtures, in provider-bridge's format (its `cmd/bridge-record` writes the same):

- `pins.json`: `{ "<source>": { version, sha256, note } }`.
- `schemas/<ns>_<type>_<version>.json`: the schema document, as `GetSchema` returns it.
- `replies/<ns>_<type>_<version>/<resource type>/<import id slug>/{import,read}.json`: `{ provider, request, response, scrubbed }`. `request` and `response` are the bridge's messages in Connect's JSON form (bytes base64, int64 as strings); a failed call has `response: { error: { code, message, diagnostics } }`. The slug replaces every run of characters outside `[A-Za-z0-9._-]` with `_` (`repo:main` is `repo_main`). The fake finds an import by its ID and a read by the `id` in the request's state, so a read of any state with that `id` gets the recorded reply.

`SANOMA_LIVE=1` sends the fake's calls to a real bridge (`startBridge(bridge)`), and `SANOMA_LIVE=1 SANOMA_RECORD=1` also rewrites the fixtures it touches (the same variables as [`@sanoma/testing/replay`](../testing/AGENTS.md#replaying-a-vendors-api)). Recording fetches the schema before `configure` and scrubs: every value of an attribute the schema marks `sensitive` becomes `"<scrubbed>"`; every state string equal to a string in the configure config becomes `"<scrubbed>"`; every config value that is sensitive in the provider's schema or named like a secret (`token`, `api_key`, `password`, ...) is replaced wherever it appears, raw, JSON-escaped or base64, by `<scrubbed:config.<path>>`, and a file in which one survives is not written. `private` stays as base64, and a reply whose private data holds a secret is refused. `scrubbed` lists the paths hit and the secrets. Read the diff, and grep it for credentials, before committing.

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
