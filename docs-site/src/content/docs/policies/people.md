---
title: People
description: "Declare people, groups, and agents and identify the principal Sanoma uses for each call."
sidebar:
  order: 2
---

Declare people, groups, and agents as resources of the built-in `sanoma` connector. By convention, put them in `resources/people.ts`. Sanoma loads it like any other [data file](/workflows/resources/#data-files). The example declares two people, two agents, and a finance group.

```ts
import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", email: "ada@acme.test", github: "ada-ortiz" });
export const bo = sanoma.person({ id: "bo" });
export const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
export const claudeCode = sanoma.agent({
  id: "claude-code",
  client: "https://claude.ai/oauth/claude-code-client-metadata",
});
export const finance = sanoma.group({ name: "finance", members: [ada] });
```

Declare membership on the group. An agent is in the group `agents` besides its own, with `onBehalfOf` the person whose instruction it carries; the runtime's own agents (`scenarios`, `host-check`, `schedule`, `wakeup`, which registers a wakeup, `login`, which sends sign-in codes, `renewal`, which renews OAuth grants when due, and `sanoma-chat`, which the app's chat acts as for the person chatting) are declared by no file, and no file may give a person or an agent one of their ids. They have no vendor object: no driver, no drift.

`readPeople(root)` loads them from the files that may declare them (`mayDeclarePeople`: those importing `sanoma` from `sanoma/resources`), again only when one of them changed, so a request costs a `stat` per file, and `principalOf(id, people)` is who an id is: its groups, by inverting the members, and its `onBehalfOf`.

Once a person is declared, `SanomaClient.start`, `call`, `decide`, `setCredential`, `setSecret`, `clearCredential` and `clearSecret` admit only a declared id (`not_admitted`, "`<id>` is not declared in resources/people.ts"), as the app's login admits only a declared person; while none is, any id is taken as given; while the people files have problems, nobody is admitted but the runtime's agents.

## Map an OAuth client to an agent

An agent may also act for whoever uses it. `client` names the OAuth client it stands for, one word (a hosted client's id is the URL of its metadata document), and `agentOfClient(client, people)` finds the agent of a client: none when no agent declares it and it is not built in, or when two declare it, which `sanoma check` reports as a problem (`clientClashes`) without keeping anyone from being admitted.

Claude's clients are built in (`BUILT_IN_CLIENTS` in `sanoma/workflows/shared`, the one table): `https://claude.ai/oauth/mcp-oauth-client-metadata` (Claude's apps) acts as the agent `claude-ai`, and `https://claude.ai/oauth/claude-code-client-metadata` (Claude Code) as `claude-code`, with no declaration. `clientAgentOf(client, people)` is the rule everything that resolves a client asks:

1. An agent that declares the client stands for it, built in or not, so a company's own declaration replaces the built-in agent for that client.
2. Otherwise a built-in client acts as its built-in agent, unless the company turned it off (`sanoma.agent({ id: "claude-ai", off: true })`, a declaration that is no agent) or a person or an agent it declares has the built-in agent's id without declaring its client. That id is then the company's own, and the built-in client is refused.
3. Any other client is refused until an agent declares it.

A built-in agent's id is not reserved: a declared agent may have it. It is the built-in's only when it declares the built-in's client. `sanoma check` lists what the files make of each built-in client (`builtInClientsOf`), reports an `off` on any other id, or beside a `client` or an `onBehalfOf`, as a problem of the people files, and warns of an id taken without the client, of an `off` for a built-in a declared agent replaces, and of an `off` listed in a group, which is no agent and gives the group nobody (`peopleWarnings`).

A built-in agent is a principal only for the person who signed its client in (`clientActing`, which the app calls for a client's token, and `builtInActing`): in `agents` and any declared group that lists its id, bound to the agent rules below. `admit` refuses it bare, and `agentActing` refuses its id.

## Agents acting for a person

`agentActing(agentId, person, readPeople(root))`, from `sanoma/workflows/describe`, is the principal of a declared agent acting for a declared person, `{ id, groups, onBehalfOf: person }`, with the agent's own groups and `agents`; it refuses (`not_admitted`) while the people files have problems, an id that is not a declared `sanoma.agent` (a person's, a runtime agent's, anyone undeclared), a person who is not a declared `sanoma.person`, and an agent whose `onBehalfOf` names someone else.

`admit`, and so `start`, `call` and the other client methods, apply the same check to an agent named with an `onBehalfOf` and keep it; a person's `onBehalfOf` is dropped, and an agent named without one is its declared self. The app makes this principal for a call through `/mcp` that names an agent ([the app's README](/start/agents-over-mcp/)).

**A declared agent acting for a person may do no more than that person.** The policy is asked twice about each of its calls and starts: once as the agent (its id, its groups and `agents`, `onBehalfOf` the person) and once as the person alone (their id and declared groups), and the stricter answer stands: a deny over a hold over an allow. When both hold, both are waited for, one after the other: the agent's hold first, then, once it is approved and the policy is asked again, the person's.

In the person's question an `@hold("on-behalf-of")` is addressed to the person, as in the agent's, rather than refused for want of whom they act for. So a `forbid` or `@hold` naming the person or one of their groups reaches their agent, and a rule naming `agents` still reaches the agent and not the person.

So is `sanoma-chat`, the runtime's agent the app's chat acts as, and never acting for no one (`admit` refuses it bare): the app's worker makes it acting for the person whose chat turn it is (`chatAgentActing`), never a request (`x-sanoma-agent` refuses it), and a company's policy reaches it by `principal in Sanoma::Group::"agents"` or `principal == Sanoma::Principal::"sanoma-chat"`. So is a built-in client's agent (`claude-ai`, `claude-code`), acting for the person who signed its client in.

Anyone else, the runtime's other agents and an agent acting for no one among them, is asked once, as before.

The agent's groups still apply to it: a rule on one of them reaches the agent, and an `unless` it would pass lets it through only where the person passes too; `sanoma check` warns of an agent with no fixed `onBehalfOf` in a declared group (`peopleWarnings`), since whoever names it acts in that group through it. A person may approve a hold on a run their own agent started for them, since the run's actor is the agent (see [Approvals](/workflows/approvals/)).

Today the connections a call may use and a direct write's `updated_by` are keyed on the actor's id, the agent's, not the person's.

## Visitors and API tokens

A visitor of a public site is a principal too, which no data file declares: `visitorPrincipal(login, subject)` is one signed in through a visitor login (`visitor:<login>:<subject>`, in the group `visitors`), and `ANONYMOUS_PRINCIPAL` the one a page with nobody signed in runs as (`anonymous`, in no group); `isVisitor(principal)` tells either by its id. `admit` takes a visitor's id whatever the files say and stamps its groups, never the ones given; the staff logins (a sign-in) admit none, and a visitor sets no credential and decides no approval.

So `visitors` and `anonymous` are no group's name, and `anonymous` and the `visitor:…` form no person's or agent's id (`readPeople` reports them, as it does `agents`).

A script or another service acts through an API token: `client.tokens.mint({ subject, groups })` makes one, `sca_` and 32 random bytes in base64url, and returns `{ id, token }`, the token shown this once (only its SHA-256 is kept, in `sanoma_api_tokens`); `subject` is whom it acts for (`visitor:better-auth:<id>`, say).

A public site's host takes it as `Authorization: Bearer <token>`, and the request acts as `token:<id>` in the token's `groups` (admission keeps them, where a visitor's are stamped `visitors`), with no email; `client.tokens.revoke({ id })` ends it, and an unknown or revoked token is a 401.

## Signing in on a host

The app on a host signs people in by an email code, an invite link, or GitHub ([the app's README](/sites/login/#staff-sign-in-on-a-host)). The code goes out through the operation the config names as `login.sender`, a connector's send that takes `{ from, to, subject, text }`, from the address it names as `login.from` (`login@acme.example` or `Acme <login@acme.example>`), on a domain the sender's vendor has verified ([`resend.domain`](https://www.npmjs.com/package/@sanoma-ai/connector-resend#sending-domain) declares one):

```ts
import { resend } from "@sanoma-ai/connector-resend";

export default defineConfig({
  connectors: [resend],
  login: { sender: resend.emails.send, from: "Acme <login@acme.example>" },
  // …
});
```

With one, the runtime registers the built-in workflow `login-code` (so a company workflow may not be named that), which the app starts as the agent `login` with the code sealed under `SANOMA_SIGNING_KEY` together with the email it is for (`sealLoginCode(to, code)`, so a copy of a run's input mails it to nobody else); its one call mails "Your `<company>` sign-in code", under the policy and in the ledger like any send, the mail's `text` recorded as `<text>`.

A policy that holds sends exempts it (`unless { … || principal == Sanoma::Principal::"login" }`): otherwise `describeConfig` reports a problem on `policies`, naming the policy and the fix. `resolveConfig` refuses a sender that is no connector's operation, does not send, has no driver, or takes no email from `login.from`, and a `login.from` that is missing or no email address.

Each sign-in and each invite is a ledger record outside any run (`signin.recorded { person, method }` under `signin:<person>`, `invite.minted { person, by, expiresAt }` under `invite:<person>`), written by `client.recordSignIn(person, method)` and `client.recordInvite(person, { by, expiresAt })`; `client.lastSignIns(people)` reads when each last signed in and how, and `client.lastInvite(person)` who minted their latest invite, when and until when (`{ by, at, expiresAt }`, undefined while none was), which the invite's landing page names.

`sealInvite({ email })` seals an invite request for five minutes under `SANOMA_SIGNING_KEY` (`openInvite` opens one), which an instance holding the same key answers with a one-use invite link at `POST /auth/invite`.
