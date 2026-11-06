# Working on @sanoma-ai/connector-gcp

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): eleven KMS/IAM/Cloud Run resources and their import IDs, the declared provisioning identity and its stored bearer, first administrator setup, retention boundaries and verification status.
- [Source map](src/AGENTS.md): provider schemas, identity verification, driver guards and fake.
- [Test map](test/AGENTS.md): synthetic federation tests and their limits.

Identity facts (project, number, account, audience, issuer) are declared on `gcpWithIdentity`, never in the stored bundle, which holds only the provisioning bearer; the driver reads it with `authenticationCredentials` inside each call. Never introduce ambient ADC, service-account private keys, credential files, an executable credential source or an environment fallback. Provisioning authority is separate from the company runtime's D1 identity. Preserve project checks, sanitized authentication failures, operation-scoped bridge sessions and KMS deletion/replacement refusal. A generated provider field does not automatically expand the connector's supported security scope.

IAM member public IDs use the provider import format; preserve native `state.id`. Derive IDs from structured fields through `tfConnector`'s `bindingId`, never by splitting native IDs on slashes. See [IAM member IDs](README.md#iam-member-ids).

Run `pnpm vitest run connectors/gcp`, root type/lint/format checks and the package build. Provider updates go through `src/resources.config.ts`, the recorded schema/pins and `pnpm --filter @sanoma-ai/connector-gcp generate`; do not hand-edit generated types. Synthetic tests are not live IAM, billing or renewal evidence.
