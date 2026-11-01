# packages

The workspace packages that make up Sanoma's core: the workflow runtime, the web app and the test helpers. Vendor connectors live in `connectors/`.

## Contents

| Path                                      | What it is                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`app/`](app/AGENTS.md)                   | `@sanoma-ai/app`: web UI over a config, started with `startApp(config)`                                                     |
| [`bridge/`](bridge/AGENTS.md)             | `@sanoma-ai/bridge`: OpenTofu providers: the provider-bridge client, its fake, the resource generator                       |
| [`desktop/`](desktop/AGENTS.md)           | `@sanoma-ai/desktop` (private): the desktop shell, which runs a company folder's own launcher and shows the app in a window |
| [`dev/`](dev/AGENTS.md)                   | `@sanoma-ai/dev`: `sanoma-dev`, which links a contributor's own Sanoma repo to a checkout, unlinks it, and updates it       |
| [`invoices/`](invoices/AGENTS.md)         | `@sanoma-ai/invoices`: shared invoice validation, exact calculations, industry adapters and React PDF rendering             |
| [`postgres-bin/`](postgres-bin/AGENTS.md) | `@sanoma-ai/postgres-<platform>`: the PostgreSQL 18 server for each platform, filled at pack time from zonky's jars         |
| [`sanoma/`](sanoma/AGENTS.md)             | `sanoma`: the bin a company repo runs, checks and exports itself with, and the surface its workflows import                 |
| [`testing/`](testing/AGENTS.md)           | `@sanoma-ai/testing`: `startTestWorker`, `testDatabaseUrl`, a vitest test app, vendor replay, and scenario testing          |
| [`workflows/`](workflows/AGENTS.md)       | `@sanoma-ai/workflows`: define connectors and workflows, run them durably on DBOS, and lint them                            |
