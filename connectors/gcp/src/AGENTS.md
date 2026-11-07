# connectors/gcp/src

| Path                                         | What it owns                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts)                       | `gcpWithIdentity`: the declared provisioning identity, its `workloadIdentity` method, driver and fake; bare `gcp` declares none.                  |
| [`authentication.ts`](authentication.ts)     | Identity fact checks, the stored-bearer `workloadIdentity` method (verify by one federation), the in-memory URL-source external-account config.   |
| [`driver.ts`](driver.ts)                     | Per-call bearer read, account and project checks, KMS retention guards, narrow absent-IAM import handling and one provider session per operation. |
| [`connector.ts`](connector.ts)               | Eleven `tfConnector` resource types, their import IDs (`find`), references and IAM member binding IDs, preserving native state.                   |
| [`resources.config.ts`](resources.config.ts) | The selected Google provider resource schemas to generate.                                                                                        |
| [`resources.gen.ts`](resources.gen.ts)       | Generated Google 8.7.0 schemas and provider pin; never edit by hand.                                                                              |
| [`resources.ts`](resources.ts)               | The `./resources` constructors used by company data files.                                                                                        |
| [`fake.ts`](fake.ts)                         | `fakeGcp` over the shared bridge resource fake.                                                                                                   |
