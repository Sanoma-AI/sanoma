# connectors/sanoma-cloud/test

Tests for the Sanoma Cloud connector: the driver against a stand-in for sanoma-ops's api, and the Host, Database and Sandbox contracts' conformance kits over the fake.

## Contents

| Path                                         | What it is                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`driver.test.ts`](driver.test.ts)           | `cloudDriver` against `POST /api/call` in this process: the requests, the workflows' answers mapped to the operations (the account's among them), the errors; the boxes' workflows and the connector's sandbox half reading the token from the company's secrets |
| [`host.test.ts`](host.test.ts)               | `checkHost` over the fake, the company running in this process (needs Postgres), and a rename by `hostname`                                                                                                                                                      |
| [`host-derive.test.ts`](host-derive.test.ts) | `cloud.host`: the derived-host checks, and its `hostname` at sanoma.work                                                                                                                                                                                         |
| [`database.test.ts`](database.test.ts)       | `checkDatabase` over the fake with the test Postgres as its database (needs Postgres), the type in a config and in a data file                                                                                                                                   |
| [`sandbox.test.ts`](sandbox.test.ts)         | `checkSandbox` over the fake's boxes through `cloudBackend`, the boxes named by the company, its limits and the account's, a runner of another protocol refused, the boxes discarded at close, and the declaration bound to the company                          |
| [`live.ts`](live.ts)                         | By hand: the operations against a real sanoma-ops, and the Database kit's run checks with the company database's URL (README)                                                                                                                                    |
