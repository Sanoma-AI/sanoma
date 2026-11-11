# connectors/sanoma-cloud/src

Source of `@sanoma-ai/connector-sanoma-cloud`: the database and host types, the driver over sanoma-ops's workflows and an in-memory fake.

## Contents

| Path                             | What it is                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts)   | `database` (the `Database` contract) and `host` (the `Host` contract, binding its own bootstrap, naming its `account`'s operations), `REGIONS`, the slug rules, and `cloudOps` with the `company` group |
| [`operations.ts`](operations.ts) | `CloudApi` (the workflows) and `cloudOperations`: read, plan, adopt, deploy and refuse, and the account's (`company.*`), shared by the driver and the fake                                              |
| [`driver.ts`](driver.ts)         | `cloudDriver`: each workflow started and its result read over `POST /api/call`, with `SANOMA_CLOUD_TOKEN` as a bearer, and the error mapping                                                            |
| [`fake.ts`](fake.ts)             | `fakeCloud`: in-memory companies by slug, a host's runtime behind an address that starts it on a request                                                                                                |
| [`resources.ts`](resources.ts)   | The `./resources` entry: `cloud.database` and `cloud.host`, the constructors a data file declares them with                                                                                             |
| [`index.ts`](index.ts)           | The package root: `cloud` with its driver and fake attached (`withSetup`), and `REGIONS`                                                                                                                |
