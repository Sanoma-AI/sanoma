# @sanoma-ai/connector-opencode

[OpenCode](https://opencode.ai), the open-source coding agent, which the app's chat runs on a person's own plan.

## Usage

```sh
npm install @sanoma-ai/connector-opencode
```

```ts
import { opencode } from "@sanoma-ai/connector-opencode";

export default defineConfig({ workflows, connectors: [opencode] });
```

The connector has no operations. It attaches a coding agent (`withSetup({ agent })`, see the [workflows README](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#usage)): the chat offers OpenCode on a person's own plan as the engine `acp-opencode`.

## OpenCode

OpenCode runs over the Agent Client Protocol (`opencode acp`), from `opencode-ai` (pinned), installed on first use in the person's box, its own `postinstall` run once after. Its free models need no sign-in. For a provider's account, the person runs `opencode auth login` once on this computer, as the chat's card says: it prints nothing without a terminal.

## Testing

`pnpm vitest run connectors/opencode` checks the connector as the app and the runtime read it; it needs no key and no network.

The logo is OpenCode's mark, from [LobeHub's icon set](https://github.com/lobehub/lobe-icons) (MIT, [`MARKS-LICENSE`](MARKS-LICENSE)). It is there only to identify the project. The OpenCode project does not endorse this package.
