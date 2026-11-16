# connectors/agent37/src

Source of `@sanoma-ai/connector-agent37`: the instance type, the driver and fake of its record, and the sandbox backend that opens boxes and drives them through Sanoma's runner.

## Contents

| Path                             | What it is                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`connector.ts`](connector.ts)   | `instance` (the resource type, which meets the `Sandbox` contract), Agent37's shapes, `DEFAULTS`, `BASE`, `wanted`, the `box` operations' schemas and `agent37Ops`                                                                                     |
| [`operations.ts`](operations.ts) | `instanceOperations`: the type's operations, a declaration's record, over a list of instances; shared by the driver and fake                                                                                                                           |
| [`api.ts`](api.ts)               | `agent37Api`: the Sandbox API on `fetch` (instances, their lifecycle, signed links, exec, templates), each failure a `DriverError`                                                                                                                     |
| [`backend.ts`](backend.ts)       | `agent37Backend`: the `SandboxBackend`, a box opened by `openInstance` (an instance found by its metadata, made from the box image's workspace template by default, `boxTemplate`, woken or started, its runner started, pnpm put in), slept by `stop` |
| [`driver.ts`](driver.ts)         | `agent37Driver`: the operations with `AGENT37_API_KEY` from the environment, the `box` ones over `openInstance` and signed links                                                                                                                       |
| [`fake.ts`](fake.ts)             | `fakeAgent37`: an Agent37 with no instances and boxes in memory, for sandbox runs                                                                                                                                                                      |
| [`resources.ts`](resources.ts)   | The `./resources` entry: `agent37.instance`, the constructor a data file declares the boxes with                                                                                                                                                       |
| [`index.ts`](index.ts)           | The package root: `agent37` with its driver, fake and sandbox half attached (`withSetup`)                                                                                                                                                              |
