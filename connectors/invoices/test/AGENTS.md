# Invoice connector tests

| File                   | Purpose                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `driver.test.ts`       | Real PDF results for each schema, validation, encoding bounds and failures                     |
| `features.test.ts`     | Packaged Gherkin features on the real driver and scenario fake                                 |
| `workflow.test.ts`     | Isolated Postgres worker: graph/lint, policy, sandbox, no-retry errors and checkpoint recovery |
| `fixtures/generate.ts` | Customer-shaped workflow used by integration tests                                             |

No HTTP replay fixtures: generation is local. Real workflow tests must prove durable results survive a worker restart without another render.
