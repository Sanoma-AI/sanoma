# Working on @sanoma-ai/connector-opencode

Follow the shared [connector conventions](../AGENTS.md). The [README](README.md) has the agent and how it signs in.

## Contents

| Path                                               | What it is                                             |
| -------------------------------------------------- | ------------------------------------------------------ |
| [`src/connector.ts`](src/connector.ts)             | `opencodeOps`: no operations                           |
| [`src/agent.ts`](src/agent.ts)                     | `opencodeAgent`: OpenCode's agent part (`CodingAgent`) |
| [`src/index.ts`](src/index.ts)                     | The package root: `opencode` (`withSetup({ agent })`)  |
| [`test/connector.test.ts`](test/connector.test.ts) | The connector as the app and the runtime read it       |

## Boundaries

- Who the agent is (`id`, `title`, its mark) is `package.json`'s `sanoma.agent`, never code. Its pinned packages are the versions tried with the app's ACP client: a bump is a new install in every person's box, so try it first.
- A mark from another source carries its license in `MARKS-LICENSE` and stays listed in `files`.

Run `pnpm vitest run connectors/opencode`; it needs no key and no database.
