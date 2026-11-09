# @sanoma-ai/connector-openai

OpenAI for Sanoma: for now, Codex, OpenAI's coding agent, which the app's chat runs on a person's own ChatGPT plan.

## Usage

```sh
npm install @sanoma-ai/connector-openai
```

```ts
import { openai } from "@sanoma-ai/connector-openai";

export default defineConfig({ workflows, connectors: [openai] });
```

The connector has no operations and no models yet. It attaches a coding agent (`withSetup({ agent })`, see the [workflows README](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#usage)): the chat offers Codex on a person's own plan as the engine `acp-codex`.

## Codex

Codex runs over the Agent Client Protocol through Zed's [`codex-acp`](https://github.com/zed-industries/codex-acp) (`@agentclientprotocol/codex-acp`, pinned), installed on first use in the person's box. The person signs in with their ChatGPT account by the device code the chat's card shows; no key of the company's is used. Codex is not offered on the company's key: its `HarnessAgent` adapter runs only with every edit and command allowed, so nothing could answer them ([vercel/ai#22550](https://github.com/vercel/ai/issues/22550)).

## Testing

`pnpm vitest run connectors/openai` checks the connector as the app and the runtime read it; it needs no key and no network.

The logos are OpenAI's and Codex's marks, from [LobeHub's icon set](https://github.com/lobehub/lobe-icons) (MIT, [`MARKS-LICENSE`](MARKS-LICENSE)). They are there only to identify the service. OpenAI does not endorse this package.

### Later

OpenAI's models as a model half, and Codex on the company's key once its adapter asks before an edit or a command.
