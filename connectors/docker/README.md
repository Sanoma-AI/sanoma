# @sanoma-ai/connector-docker

The local Docker host for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows): one container on this machine's Docker daemon that runs the company, through the [`kreuzwerker/docker`](https://github.com/kreuzwerker/terraform-provider-docker) OpenTofu provider (4.6.0) on [provider-bridge](https://github.com/Sanoma-AI/provider-bridge), which apply creates, replaces and deletes.

## Usage

```sh
npm install @sanoma-ai/connector-docker
```

The one resource type is writable and a host ([Hosts](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#hosts)): `read` and `import` (effect `read`), and the change operations only the apply workflow may call, `plan` (effect `read`), `create`, `update` and `delete` (effect `write`), with the container's id as the policy's `target` (`new:docker.container` for a create):

| Type        | Operations                                                                   | Import id                      |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------ |
| `container` | `docker.container.read`, `.import`, `.plan`, `.create`, `.update`, `.delete` | its name, or its id (bound by) |

A data file declares the container with the constructor in `@sanoma-ai/connector-docker/resources`:

```ts
import { docker } from "@sanoma-ai/connector-docker/resources";
import { secret } from "sanoma/resources";

export const host = docker.container({
  name: "sanoma-acme",
  image: "sanoma-runtime:0.2.0",
  source: repo, // a declared github.repository, or a clone URL
  ref: "main",
  port: 3000,
  secrets: {
    SANOMA_DATABASE_URL: secret("DATABASE_URL"),
    SANOMA_SECRETS_KEY: secret("SECRETS_KEY"),
  },
});
```

| Field           | What it is                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | The container's name, its identity: apply binds a declaration to the container of that name when there is one                               |
| `image`         | The Sanoma runtime image ([`packages/sanoma/runtime`](../../packages/sanoma/runtime/Dockerfile)), pinned to a tag or digest, never `latest` |
| `source`        | The company repository: a clone URL, or a declared `github.repository` (its `http_clone_url`)                                               |
| `ref`           | The branch it runs, never a commit: apply resolves it and sets the hidden `revision`, so a merge is drift on the container                  |
| `port`          | The port on `127.0.0.1` the app answers on, never on other interfaces                                                                       |
| `secrets`       | Environment variables, each a `secret(...)`: write-only, never in an output, the ledger or a checkpoint                                     |
| `id`, `running` | Docker's: its id, and whether it runs                                                                                                       |

The host's outputs are `{ url: "http://127.0.0.1:<port>", revision, healthy }`, `healthy` while it runs. Its capabilities: long-lived, no public URL, it runs an image rather than building one, no fixed egress.

The container runs the image with `SANOMA_SOURCE`, `SANOMA_REVISION`, `PORT` (3000) and the secrets as its environment, the image's entrypoint clones the source at the revision and serves it, its port is published on `127.0.0.1` only, it restarts unless stopped, and apply waits for its healthcheck (`/healthz`, up to ten minutes, the clone and install included) before it is created. Labels say what it runs (`sanoma.revision`, `sanoma.source`, `sanoma.ref`) and the names of the variables it was given (`sanoma.env`).

Every change replaces the container: the provider forces a new one for any change of its name, image, environment, labels or ports. So a deploy (a new revision) or a secret's rotation is a replace, a few seconds of downtime plus the runtime's start. A stopped container plans a replace too.

The logo is Docker's whale from [Simple Icons](https://simpleicons.org/?q=docker) (CC0), there only to identify the service an operation calls.

## Resource types

`src/resources.gen.ts` is generated from the provider's schema by `pnpm generate` with `src/resources.config.ts`: the provider and `docker_container`, with the attributes the provider's source forces a new container for. It is checked in and never edited by hand. `src/connector.ts` maps the declared fields onto `docker_container` and back (`TfMapped` on [`tfConnector`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/README.md#connectors-for-opentofu-providers)): a container's fields are read from its labels and ports, never from its environment.

The provider keeps a container's environment in its state, unmarked: the type's `writeOnly: ["env"]` keeps it inside the driver, so no state, plan or output carries a secret.

## Driver

`@sanoma-ai/connector-docker/driver` (`dockerDriver({ bridge?, host?, inspect? })`) runs the provider on a provider bridge (the process's `defaultBridge()` from `SANOMA_BRIDGE_BIN` by default) against the Docker daemon at `host`, found on every call when not given (`dockerHost()`): `DOCKER_HOST`, else the active docker context's endpoint (`DOCKER_CONTEXT`, else the config's `currentContext`), else Docker Desktop's `~/.docker/run/docker.sock`, else `/var/run/docker.sock`. `unix://` and `tcp://` hosts are supported.

The provider reads neither a container's environment nor its labels back, and imports one by its id only. So the driver asks Docker for the container first (`GET /containers/{id}/json`), imports it by its id, and fills in the environment its `sanoma.env` label names, its `sanoma.*` labels, its ports and the attributes only a config sets: a container made as declared then plans no change, and its revision reads from its label. Docker's inspect answers stay inside the driver.

`./fake` (`fakeDocker`) creates, replaces and deletes containers in memory over the recorded replies; nothing reaches a daemon.

### Environment

| Variable      | What it is                                                                           |
| ------------- | ------------------------------------------------------------------------------------ |
| `DOCKER_HOST` | Optional: the Docker daemon's address; without it, the active context's or Desktop's |

No credential: the daemon's socket is this machine's.
