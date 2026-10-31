# Working on @sanoma-ai/connector-gcp

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): seven KMS/IAM resources, explicit WIF provisioning identities, bootstrap trust, retention boundaries and verification status.
- [Source map](src/AGENTS.md): provider schemas, identity verification, driver guards and fake.
- [Test map](test/AGENTS.md): synthetic federation tests and their limits.

Keep trusted deployment identity mappings keyed by the server-selected connection ID. Never introduce ambient ADC, service-account private keys, caller-selected credential files or an executable credential source. Provisioning authority is separate from the company runtime's D1 identity. Preserve project checks, sanitized authentication failures, operation-scoped bridge sessions and KMS deletion/replacement refusal. A generated provider field does not automatically expand the connector's supported security scope.

Run `pnpm vitest run connectors/gcp`, root type/lint/format checks and the package build. Provider updates go through `src/resources.config.ts`, the recorded schema/pins and `pnpm --filter @sanoma-ai/connector-gcp generate`; do not hand-edit generated types. Synthetic tests are not live IAM, billing or renewal evidence.
