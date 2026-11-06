# Working on @sanoma-ai/connector-agent37

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the instance type, the boxes, the key, what it costs, errors and the live run.
- [Source map](src/AGENTS.md): the instance type, the API client and the backend.
- [Test map](test/AGENTS.md): the replayed driver, and the backend against Agent37 on this machine.

The resource type is a record (apply makes nothing at Agent37); the work is the sandbox half, `agent37Backend`, which the app calls with the declaration's fields (`SandboxContext.declared`). Keep a box's commands on the runner (`runnerBox` from `@sanoma-ai/workflows`): Agent37's REST `exec` is buffered and has no stdin, which an agent's process needs, so it only writes the runner in and starts it.

Run `pnpm vitest run connectors/agent37`: it needs no account. `test/live.ts` is by hand, on a funded workspace (README, "Running it live").
