# @sanoma-ai/connector-anthropic

Anthropic's Claude models for the app's agent, through the [AI SDK](https://ai-sdk.dev)'s Anthropic adapter ([`@ai-sdk/anthropic`](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)), on the company's own API key.

## Usage

```sh
npm install @sanoma-ai/connector-anthropic
```

```ts
import { anthropic } from "@sanoma-ai/connector-anthropic";

export default defineConfig({ workflows, connectors: [anthropic], policy });
```

The connector has no operations. It attaches a model half (`withSetup({ model })`, see the [workflows README](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#usage)): the app makes one AI SDK registry over every connector with one, where Anthropic's models are `anthropic/<model-id>`, such as `anthropic/claude-sonnet-5-5`, and `anthropic/default` is `ANTHROPIC_DEFAULT_MODEL` (`claude-opus-5-5`), until a config can choose one.

## The key

| Variable            | What it is                                               |
| ------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | An API key, from the API Keys page of the Claude Console |

The driver declares it, with no operations, so the app's connector page asks for it and stores it encrypted. The model half reads it at each request, the environment's first, then the stored one: a key set on the page is used from the next call, unless the environment sets one, which wins. Without one, a call fails with the AI SDK's `LoadAPIKeyError`, "anthropic is not configured: ANTHROPIC_API_KEY (…); set it on the connector page", and sends nothing. A key that cannot be read (the database down) fails the call alike, not retried. `ANTHROPIC_BASE_URL`, the adapter's own, points it at another endpoint: read from the app's environment once, when its registry is made, so a change needs a restart.

## Claude Code

The connector also gives the app's chat Claude Code, a coding agent (`withSetup({ agent })`): on a person's own plan as the engine `acp-claude-code`, over the Agent Client Protocol through `@agentclientprotocol/claude-agent-acp` (pinned), installed on first use in the person's box and signed in with their Claude account in the chat; and on the company's key as `claude-code`, through the AI SDK's `HarnessAgent` and its Claude Code adapter (`@ai-sdk/harness-claude-code`, pinned, loaded only when such a turn runs), on `anthropic/default` and `ANTHROPIC_API_KEY`. Its bridge installs Claude Code under the person's box's home on its first start there.

## Testing

`pnpm vitest run connectors/anthropic` runs the model half over a stubbed `fetch`, and loads Claude Code's adapter without starting it, so no request leaves the machine and no key is needed.

The logo the app shows is Anthropic's mark, from [Simple Icons](https://simpleicons.org/?q=anthropic) (CC0), in dark or light; Claude Code's is from [LobeHub's icon set](https://github.com/lobehub/lobe-icons) (MIT, [`MARKS-LICENSE`](MARKS-LICENSE)). They are there only to identify the service. Anthropic does not endorse this package.

### Later

A config field choosing the model, other model connectors (Bedrock, OpenRouter, OpenAI), and a token budget.
