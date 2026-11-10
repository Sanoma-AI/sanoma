# @sanoma-ai/connector-pi

[Pi](https://github.com/earendil-works/pi), the coding agent, which the app's chat runs on a person's own plan or on the company's Anthropic key.

## Usage

```sh
npm install @sanoma-ai/connector-pi @sanoma-ai/connector-anthropic
```

```ts
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { pi } from "@sanoma-ai/connector-pi";

export default defineConfig({ workflows, connectors: [anthropic, pi] });
```

The connector has no operations. It attaches a coding agent (`withSetup({ agent })`, see the [workflows README](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#usage)): the chat offers Pi on a person's own plan as the engine `acp-pi`, and on the company's key as `pi`.

## On a person's own plan

Pi runs over the Agent Client Protocol through `pi-acp` and Pi's coding agent (`@earendil-works/pi-coding-agent`), both pinned, installed on first use in the person's box. Its sign-in is Pi's own terminal UI, so the chat's card tells the person to run `pi` once on this computer and type `/login`.

## On the company's key

Pi runs in the app's process through the AI SDK's `HarnessAgent` and its Pi adapter ([`@ai-sdk/harness-pi`](https://ai-sdk.dev), pinned, loaded only when such a turn runs), its settings under the session's home. It runs on Anthropic's `anthropic/default` model and key: the `@sanoma-ai/connector-anthropic` connector's, by contract, so install that one beside it. Without it, or without its key, the turn says what is missing. `ANTHROPIC_BASE_URL`, when the app's environment sets it, is passed on as the model's endpoint.

## Testing

`pnpm vitest run connectors/pi` checks the connector as the app and the runtime read it, and loads the adapter; it needs no key and no network.

The logo is Pi's mark, from [LobeHub's icon set](https://github.com/lobehub/lobe-icons) (MIT, [`MARKS-LICENSE`](MARKS-LICENSE)). It is there only to identify the project. The Pi project does not endorse this package.
