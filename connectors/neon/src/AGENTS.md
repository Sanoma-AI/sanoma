# connectors/neon/src

Source of `@sanoma-ai/connector-neon`: the project resource type and its operations, the driver over Neon's SDK and an in-memory fake.

## Contents

| Path                                     | What it is                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts)           | `project` (the resource type, which meets the `Database` contract), `REGIONS`, the size helpers, and `neonOps`: its operations with health, storeUrl, branches and computes |
| [`operations.ts`](operations.ts)         | `neonOperations`: the operations over a `NeonApi` (read, plan, the replace refused, the URL stored), shared by the driver and the fake                                      |
| [`driver.ts`](driver.ts)                 | `neonDriver`: one `NeonApi`/SDK client per authorized call, with credentials from `CallContext.authentication` and sanitized error mapping                                  |
| [`authentication.ts`](authentication.ts) | `neonApiKey`: the versioned key bundle and organization verification through Neon's authenticated organizations endpoint                                                    |
| [`fake.ts`](fake.ts)                     | `fakeNeon`: an in-memory Neon with projects, branches and computes, a suspend and a start                                                                                   |
| [`resources.ts`](resources.ts)           | The `./resources` entry: `neon.project`, the constructor a data file declares the project with                                                                              |
| [`steps.ts`](steps.ts)                   | `neonSteps`: the connector's steps for Gherkin tests (`defineSteps`)                                                                                                        |
| [`index.ts`](index.ts)                   | The package root: `neon` with its driver, fake and steps attached (`withSetup`), and `REGIONS`                                                                              |
