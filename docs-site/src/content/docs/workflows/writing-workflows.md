---
title: "Write a workflow"
description: "Use the Ghost connector to create a draft and test the workflow in a sandbox."
sidebar:
  order: 1
---

This workflow takes a title, creates a draft in Ghost, and returns the post. You’ll need a company repository with [Sanoma installed](/start/install/).

## Register Ghost in the company

Run `npm install @sanoma-ai/connector-ghost` in the repository. In `sanoma.config.ts`, import `ghost` from `@sanoma-ai/connector-ghost` and add it to the `connectors` array alongside the company’s other connectors.

## Define the workflow

Create `workflows/draft-post.ts`. The CLI discovers the default export when it loads the repo. The `input` schema requires a title. The `uses` list declares the operation the workflow can call.

```ts title="workflows/draft-post.ts"
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "draft-post",
  trigger: "manual",
  input: z.object({ title: z.string().min(1) }),
  uses: [ghost.post.create],
  run: (ctx, { title }) => ctx.ghost.post.create({ title, html: "<p>Ready for review.</p>" }),
});
```

`ghost.post.create` creates a draft by default. You can look up its input fields, defaults, and output in the [Ghost operation reference](/reference/connectors/ghost/).

## Test it in a sandbox

Create `scenarios/draft-post/create.feature` with one example.

```gherkin
Feature: Draft a post
  Scenario: Prepare a launch draft
    When draft-post runs with
      | title | Launch notes |
    Then ghost.post.create was called with
      | title | Launch notes |
    And the run succeeds
```

Start the app with `npx sanoma` from the repo root. Open **Workflows**, select `draft-post`, then choose **New run → Sandbox → Prepare a launch draft**. Select **Start sandbox run**. If your company’s policy holds the call, [review the approval](/using-the-app/approvals/) before checking the result.

Open **Ledger** and find `ghost.post.create`. Its input includes the title `Launch notes`, and its output has the status `draft`. The connector’s fake holds this post for the run.

## Related interfaces

- <a id="a-connector-and-a-workflow" href="/building-connectors/define-a-connector/#a-connector-and-a-workflow">A connector and a workflow</a>
- <a id="triggers" href="/reference/workflow-runtime/#triggers">Triggers</a>
- <a id="describing-the-vendor" href="/building-connectors/define-a-connector/#describing-the-vendor">Describing the vendor</a>
- <a id="drivers-and-fakes" href="/building-connectors/define-a-connector/#drivers-and-fakes">Drivers and fakes</a>
- <a id="setup-halves" href="/building-connectors/setup/#setup-halves">Setup halves</a>
- <a id="visitor-sign-in" href="/building-connectors/setup/#visitor-sign-in">Visitor sign-in</a>
- <a id="models-git-hosts-and-coding-agents" href="/building-connectors/setup/#models-git-hosts-and-coding-agents">Models, Git hosts, and coding agents</a>
- <a id="webhooks" href="/building-connectors/setup/#webhooks">Webhooks</a>
- <a id="the-config" href="/reference/workflow-runtime/#the-config">The config</a>
- <a id="what-the-config-finds-by-convention" href="/reference/workflow-runtime/#what-the-config-finds-by-convention">What the config finds by convention</a>
- <a id="targets" href="/building-connectors/define-a-connector/#targets">Targets</a>
- <a id="what-the-ledger-records" href="/workflows/ledger/#what-the-ledger-records">What the ledger records</a>
- <a id="people-and-the-client" href="/reference/workflow-runtime/#people-and-the-client">People and the client</a>
- <a id="running-it" href="/reference/workflow-runtime/#running-it">Running it</a>

<a id="output-for-the-starter-alone" href="/reference/workflow-runtime/#output-for-the-starter-alone">Restrict workflow output fields to the starter</a>
