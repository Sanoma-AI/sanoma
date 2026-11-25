---
title: Install in a repository
description: "Install Sanoma and a connector in an existing repository, then configure TypeScript and add workflows."
next:
  link: /start/first-workflow/
  label: Run your first workflow
prev:
  link: /start/setup/
  label: Set up a company
sidebar:
  order: 2
---

Use Node 26 or later. From the repository root, install Sanoma and the connectors your company will use. This example uses Ghost.

```sh
npm install sanoma @sanoma-ai/connector-ghost
```

<a id="what-comes-with-it" href="/reference/workflow-runtime/#package-dependencies">Package dependencies and Node type versions</a>

## The layout

Add Sanoma’s configuration at the repository root. If the repo already has a TypeScript configuration, keep its existing project files in `include` when adding Sanoma’s directories.

```json title="tsconfig.json"
{
  "extends": "sanoma/tsconfig.json",
  "include": [
    "sanoma.config.ts",
    "workflows",
    "operations",
    "resources",
    "apps/*/app.ts",
    "apps/*/workflows",
    "apps/*/operations",
    "apps/*/resources"
  ]
}
```

```ts
// sanoma.config.ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";

export default defineConfig({ connectors: [ghost] });
```

## Workflows

If the repo already has workflow files, the CLI discovers their default exports when it loads the config. To add one, follow [Write a workflow](/workflows/writing-workflows/). It uses the Ghost connector you just installed and includes a scenario that checks the result.

## Open the app

Run `npx sanoma` from the repository root and open the address it prints. Select **Workflows** to find a workflow by name. For a guided exercise with the starter company’s sample data, [run your first workflow](/start/first-workflow/).

## Other repository files

- <a id="what-a-file-imports" href="/reference/repository-imports/">Imports by file type</a>
- <a id="collections" href="/workflows/collections/">Declare a collection in resources/data.ts</a>
