# connectors/gcp/src

| Path                                                   | What it owns                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`index.ts`](index.ts)                                 | `gcpWithIdentities`: frozen deployment mappings and the connector's authentication/driver/fake setup; bare `gcp` has no live identity mappings.  |
| [`provisioning-identity.ts`](provisioning-identity.ts) | Protected URL-source WIF config from a trusted provisioning bearer callback.                                                                     |
| [`authentication.ts`](authentication.ts)               | Explicit external-account OIDC config validation, selected connection lookup, STS/service-account impersonation and sanitized verified identity. |
| [`driver.ts`](driver.ts)                               | Named workload-identity opt-in, project checks, KMS retention guards and one provider session per operation with explicit credentials.           |
| [`connector.ts`](connector.ts)                         | Seven `tfConnector` resource types, key/service-account references and IAM member import IDs through `bindingId`, preserving native state.       |
| [`resources.config.ts`](resources.config.ts)           | The selected Google provider resource schemas to generate.                                                                                       |
| [`resources.gen.ts`](resources.gen.ts)                 | Generated Google 8.7.0 schemas and provider pin; never edit by hand.                                                                             |
| [`resources.ts`](resources.ts)                         | The `./resources` constructors used by company data files.                                                                                       |
| [`fake.ts`](fake.ts)                                   | `fakeGcp` over the shared bridge resource fake.                                                                                                  |
