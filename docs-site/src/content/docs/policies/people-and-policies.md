---
title: People and policies
description: "resources/people.ts declares who uses the company's app, the agents that act in it and the groups (people), and policies/.cedar who may do what (policies)."
sidebar:
  order: 1
---

`resources/people.ts` declares who uses the company's app, the agents that act in it and the groups ([people](/policies/people/)), and `policies/*.cedar` who may do what ([policies](/policies/policies/)):

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

The `login` in its `unless` is the runtime's agent that sends sign-in codes (the built-in `login-code` workflow, when the config names `login: { sender, from }`): a policy that held its send would keep everyone from signing in by code, and `sanoma check` says so.

## Who signs in

Only a declared person signs in to the app (on this machine by picking their name; on a host by an email code to their `email`, an invite link, or GitHub by their verified email, then their `github` login), starts a run, calls an operation or decides an approval, and nobody decides an approval on a run they started while someone else in the group could (a founder alone in a group decides their own, and the ledger says so).

## What a policy decides

Everything is allowed unless a `forbid` refuses it: one with `@hold` waits for that group's or person's approval, one without is denied with its `@reason`. A visitor of a public site, in the group `visitors` (or `anonymous`, when nobody is signed in), is the exception: it may start a run or call an operation directly only where a `permit` names it (`permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:signup", resource);`; the one other `permit` a policy file may hold is for agents), and inside a run it started its calls are allowed as anyone's, the forbids still holding.

## Writing and testing policies

Write them against `.sanoma/schema.cedarschema`, which `sanoma check` and `sanoma` write from the config: each operation's id as an action in its effect's group, `workflow:<name>` for a run's start, the groups the people file declares, and each operation's input as `context.input`. `sanoma check` reports a policy problem at its place and runs no scenario until there are none; `sanoma` refuses to start on one. A scenario runs as the agent `scenarios` unless it says who is acting (`Given bo is acting`, `Given a visitor is acting`, `Given a visitor "hopper@example.com" with GitHub "hopper" is acting`, `Given anonymous is acting`), and checks the policy with `Then ghost.post.publish was held for group "editor"` and `Then <op> was denied with "<reason>"`. The app's Permissions page shows what the policies answer for each group.

## Agents on a host

On a host, an AI agent's client signs a person in to [`/mcp`](/start/agents-over-mcp/) and acts for them as an agent. Claude's clients (claude.ai, Claude Desktop, Claude mobile and Claude Code) are built in: they need no declaration and act as the agents `claude-ai` and `claude-code`, in the group `agents`, so a policy for `agents` reaches them. To replace one with an agent of your own, declare its client (`sanoma.agent({ id: "claude-code", client: "https://claude.ai/oauth/claude-code-client-metadata" })`); to turn one off, `sanoma.agent({ id: "claude-ai", off: true })`. Any other client is refused until an agent declares it. `sanoma check` lists each built-in client and whether the company accepts it, on stderr (`built-in client: …`).
