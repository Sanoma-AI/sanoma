# Working on @sanoma-ai/connector-pi

Follow the shared [connector conventions](../AGENTS.md). The [README](README.md) has the agent and how it signs in.

## Contents

| Path                                               | What it is                                       |
| -------------------------------------------------- | ------------------------------------------------ |
| [`src/connector.ts`](src/connector.ts)             | `piOps`: no operations                           |
| [`src/agent.ts`](src/agent.ts)                     | `piAgent`: Pi's agent part (`CodingAgent`)       |
| [`src/index.ts`](src/index.ts)                     | The package root: `pi` (`withSetup({ agent })`)  |
| [`test/connector.test.ts`](test/connector.test.ts) | The connector as the app and the runtime read it |

## Boundaries

- Who the agent is (`id`, `title`, its mark) is `package.json`'s `sanoma.agent`, never code. Its pinned packages are the versions tried with the app's ACP client: a bump is a new install in every person's box, so try it first.
- On the key, Pi runs on the Anthropic connector's model by contract (`onKey.model`), never by importing it: connectors never depend on each other. `@ai-sdk/harness-pi` is pinned exactly at the version whose `@ai-sdk/harness` the app pins, and imported only in `harness`, by a name the bundler leaves alone.
- A mark from another source carries its license in `MARKS-LICENSE` and stays listed in `files`.

Run `pnpm vitest run connectors/pi`; it needs no key and no database.
