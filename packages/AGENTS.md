# packages

The workspace packages that make up Sanoma's core: the workflow runtime, the web app and the test helpers. Vendor connectors live in `connectors/`.

## Contents

| Path                                | What it is                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`app/`](app/AGENTS.md)             | `@sanoma/app`: web UI and JSON API over a config, started with `startApp(config)`                    |
| [`testing/`](testing/AGENTS.md)     | `@sanoma/testing`: `startTestWorker`, `testDatabaseUrl` and the connectors' fakes for workflow tests |
| [`workflows/`](workflows/AGENTS.md) | `@sanoma/workflows`: define connectors and workflows, run them durably on DBOS, and lint them        |
