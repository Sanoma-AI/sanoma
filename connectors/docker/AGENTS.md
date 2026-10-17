# Working on @sanoma-ai/connector-docker

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the container type, its fields and outputs, the driver and the daemon's address.
- [Source map](src/AGENTS.md): generated types, the mapping onto `docker_container`, driver, and fake.
- [Test map](test/AGENTS.md): the mapping offline, the driver over recorded replies, and the conformance kit against local Docker.

Change `src/resources.config.ts` and `src/connector.ts` for the type; do not hand-edit `src/resources.gen.ts`. Regenerate with `pnpm --filter @sanoma-ai/connector-docker generate`.

Keep `env` write-only (the provider stores it unmarked) and read a container's fields from its labels, never its environment. Keep `CREATE_ONLY`, the labels and the healthcheck's durations as Docker reads them back, so a container made as declared plans `none` from an import. Publish the port on `127.0.0.1` only.

Run `pnpm vitest run connectors/docker` and `pnpm typecheck`. `test/host.test.ts` needs Docker, Postgres, network and `SANOMA_BRIDGE_BIN`, and skips without Docker or the binary.
