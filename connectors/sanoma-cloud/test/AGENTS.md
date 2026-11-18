# connectors/sanoma-cloud/test

Tests for the Sanoma Cloud connector: the driver against a stand-in for sanoma-ops's api, and the Host and Database contracts' conformance kits over the fake.

## Contents

| Path                                         | What it is                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`driver.test.ts`](driver.test.ts)           | `cloudDriver` against `POST /api/call` in this process: the requests, the workflows' answers mapped to the operations (the account's among them), the errors |
| [`host.test.ts`](host.test.ts)               | `checkHost` over the fake, the company running in this process (needs Postgres), and a rename by `hostname`                                                  |
| [`host-derive.test.ts`](host-derive.test.ts) | `cloud.host`: the derived-host checks, and its `hostname` at sanoma.work                                                                                     |
| [`database.test.ts`](database.test.ts)       | `checkDatabase` over the fake with the test Postgres as its database (needs Postgres), the type in a config and in a data file                               |
| [`live.ts`](live.ts)                         | By hand: the operations against a real sanoma-ops, and the Database kit's run checks with the company database's URL (README)                                |
