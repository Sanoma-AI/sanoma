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

The connector has no operations. It attaches a model half (`withSetup({ model })`, see the [workflows README](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)): the app makes one AI SDK registry over every connector with one, where Anthropic's models are `anthropic/<model-id>`, such as `anthropic/claude-sonnet-5-5`, and `anthropic/default` is `ANTHROPIC_DEFAULT_MODEL` (`claude-opus-5-5`), until a config can choose one.

## The key

| Variable            | What it is                                               |
| ------------------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | An API key, from the API Keys page of the Claude Console |

The driver declares it, with no operations, so the app's connector page asks for it and stores it encrypted. The model half reads it at each request, the environment's first, then the stored one: a key set on the page is used from the next call. Without one, a call fails with the AI SDK's `LoadAPIKeyError`, "anthropic is not configured: ANTHROPIC_API_KEY (…); set it on the connector page", and sends nothing. `ANTHROPIC_BASE_URL`, read by the adapter, points it at another endpoint.

## Testing

`pnpm vitest run connectors/anthropic` runs the model half over a stubbed `fetch`, so no request leaves the machine and no key is needed.

The logo the app shows is Anthropic's mark, from [Simple Icons](https://simpleicons.org/?q=anthropic) (CC0), in dark or light. It is there only to identify the service. Anthropic does not endorse this package.

### Later

A config field choosing the model, other model connectors (Bedrock, OpenRouter, OpenAI), and a token budget.
