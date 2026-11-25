---
title: People and policies
description: "How people, agents, and groups connect a company’s sign-in rules to its Cedar policies."
sidebar:
  order: 1
---

Company repos define identities and permissions separately. A [people declaration](/policies/people/), conventionally `resources/people.ts`, identifies the people and agents who use the app and the groups they belong to. The [Cedar policies](/policies/policies/) in `policies/*.cedar` decide which actions those identities can take.

## An example

```ts title="resources/people.ts"
import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", email: "ada@acme.test", github: "ada-ortiz" });
export const bo = sanoma.person({ id: "bo" });
export const editor = sanoma.group({ name: "editor", members: [ada] });
```

```cedar
// policies/policy.cedar
@hold("editor")
@title("Review before it goes out")
forbid (principal, action in [Sanoma::Action::"effect:publish", Sanoma::Action::"effect:send"], resource)
unless { principal in Sanoma::Group::"editor" || principal == Sanoma::Principal::"login" };
```

In this example, Bo’s publish or send call waits for an editor. Ada belongs to `editor`, so the rule lets her call proceed. The `unless` clause also exempts `login`. That runtime agent sends sign-in codes through the built-in `login-code` workflow when the config declares `login: { sender, from }`. Holding its send would block code sign-in, and `sanoma check` reports that condition.

## Who signs in

Bo and Ada sign in as the people declared in the company. When Bo starts a run, its actor is Bo. That identity matters again when the run asks for approval. The runtime checks whether the person deciding belongs to the requested group and, when another person can decide, keeps the starter from approving their own run. See [who can decide an approval](/workflows/approvals/#who-approves).

## What a policy decides

If Bo sends a draft for publication, the editor rule holds the call. Ada can approve it because she belongs to `editor`. A matching `forbid` without `@hold` denies the call instead. The ledger records the decision so a reader can trace it back to the rule.

A public visitor also needs permission to start the workflow. Granting that permission leaves the company’s rules in effect for calls inside the run. The [Cedar policy reference](/policies/policies/) gives the action and principal forms for staff, visitors, and agents.

## Writing and testing policies

To exercise this rule in a scenario, start with `Given bo is acting` and check `Then ghost.post.publish was held for group "editor"`. Run `npx sanoma check` to validate the policy and run the scenario. The generated schema is in `.sanoma/schema.cedarschema`. See [scenario steps for policy and actors](/reference/scenario-steps/#resources-policy-and-actors).

## Agents on a host

An agent connected over MCP can act for a signed-in person. The run records the agent as its actor and whom it represents. See [how an agent acts for a person](/policies/people/#agents-acting-for-a-person) and [which MCP clients can connect](/start/agents-over-mcp/#built-in-claude-clients).
