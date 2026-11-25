---
title: "Connector setup interfaces"
description: "Look up the optional interfaces for database preparation, login, models, Git hosts, agents, and webhooks."
sidebar:
  order: 2
---

Attach these interfaces when a connector participates in a company service such as visitor sign-in or hosting. The [connector guide](/building-connectors/define-a-connector/) covers the driver and fake used for workflow calls.

## Setup halves

A connector that keeps tables on the company's database (a login's) attaches how to make them, as `prepare`: `withSetup(connector, { prepare: async (databaseUrl) => … })`, a `DatabasePreparation` the worker runs at its start, after the runtime's own tables, with the database's direct URL (never a pooler's: an advisory lock is one connection's); idempotent, and safe for two workers at once. The app never makes a connector's tables, since on a host it may run where it must not migrate: a login opened before the worker prepared them refuses.

`startWorker`'s `prepare` option adds preparations no config names, as the `sanoma` bin adds the staff login's.

### Visitor sign-in

A connector that signs visitors in to a public site attaches a login half too, as `login`: `withSetup(connector, { login: (context) => half })`. The app calls it once per public site whose `site.ts` names the connector (`defineSite({ public: true, login: "<vendor>" })`), when it starts, with a `LoginContext` (`database()`, the client's pool, the app's one on Node and the request's own on a Worker, so a half keeps an instance per pool and nothing else across requests; a key of its own derived from `SANOMA_SIGNING_KEY` to sign its cookies with, a vendor's secrets, the site's origins, `sendCode(email, code)` when the config names a `login.sender`, and `social`, the company's GitHub App's OAuth client when the app is given it), on the tables its `prepare` made.

The `LoginHalf` it makes (see its type) answers the provider's stable subject for a request, with the email and the GitHub login when it verified them, never a principal: the app makes the visitor's principal from it, so a connector cannot set a visitor's groups. A visitor's address, for rate limits, is the `CLIENT_IP_HEADER` header the app sets, never `X-Forwarded-For`. One vendor's connectors attach one `login`, as for a driver.

[`sanoma/better-auth`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/better-auth/README.md) is one, email and password (and an email code, with a sender) on the company's database; it also exports `betterAuthStaffLogin`, the staff sign-in the app uses on a host (`LoginContext.staff`: who is declared, the GitHub client, and where a sign-in is recorded). The app makes it as it starts and sends it every request to the site's own host ([public sites](/sites/public-sites/)).

### Models, Git hosts, and coding agents

A model connector attaches a model half, as `model`: `withSetup(connector, { model: (context) => provider })`, an AI SDK provider (`ProviderV4` from `@ai-sdk/provider`) with the vendor's adapter as the transport. The app makes it for its model registry, once per resolved config and client (again after one that throws), where its models are `<vendor>/<model-id>`; it answers `languageModel("default")` with the connector's own default.

Its `ModelContext` gives it the secrets as a login's does (the selected store and explicit bindings), which it reads when a model is called; its driver declares the key in `env`, with no operations if it needs none. One vendor's connectors attach one `model`. [`@sanoma-ai/connector-anthropic`](https://www.npmjs.com/package/@sanoma-ai/connector-anthropic) is one.

A git host's connector attaches a remote half, as `remote`: `withSetup(connector, { remote: () => half })`, a `RemoteHalf` made once per resolved config and kept in `ResolvedConfig.remotes` by vendor; `remoteFor(remotes, url)` finds the one whose `matches` reads a clone URL, with the repository.

`open(repo, { secrets })` gives a `SourceHost`: the repository's pull requests (find, open, squash-merge at a head, close), the `sanoma` commit status, and `enforcement(base)`, whether the host refuses a change to the branch that is not a merge (`HostEnforcement`); its `token(prefer)` is what a push signs in with.

`webhook(request, { secrets })` verifies a delivery and says what happened (`RemoteEvent`: a branch pushed, a pull request closed); `owners({ secrets })` lists the accounts the company's app on the host is installed on, and `permissions({ secrets })` what that app may do, as the host lists it (both optional, undefined or empty without the app's keys). It reads its tokens through `secrets` when called, as a model half does. One vendor's connectors attach one `remote`.

[`@sanoma-ai/connector-github`](https://www.npmjs.com/package/@sanoma-ai/connector-github#remote-half) is one.

A connector whose vendor makes a coding agent attaches it, as `agent`: `withSetup(connector, { agent: { own, onKey } })`, a `CodingAgent` the app's chat runs. Who the agent is is its package.json's, as the vendor's is: `"sanoma": { …, "agent": { "id", "title", "mark"?, "markDark"? } }`, its mark SVG files in the package (the logo's when it names none) (`VendorInfo.agent`, which `defineConnector` checks: an id of lowercase letters, digits and dashes, never `loop` or `acp-…`; marks as logos are).

`own` (`OwnAgent`) runs it on a person's own plan over the Agent Client Protocol: the packages installed for it on first use (each pinned, without install scripts), a `setup` script to run once installed, its ACP bin and arguments, how the person signs in from the chat (`AgentSignIn`), and the `hosts` it reaches from the box (its sign-in, its model's API).

`onKey` (`KeyAgent`) runs it on the company's key through the AI SDK's `HarnessAgent`: its adapter, loaded when first used (`harness(auth, home)`), whether it takes the model qualified and runs a bridge, the `hosts` what it runs in the box reaches, and the model it runs on by contract, `model`, the vendor of the model connector whose `<vendor>/default` and key (the variables that connector's driver declares) the app passes it, never a dependency on that connector; `baseUrl` names the variable the app passes on from its environment for the model's endpoint.

`ResolvedConfig.agents` holds them by the agent's id (`InstalledAgent`: who it is, its vendor and its parts; two vendors may not give one id, and a connector with an `agent` whose package.json names none is refused), and `describeConfig` lists them as `agents` (`AgentEntry`: id, vendor, title, mark as `data:` URLs, `own`, `once` when its own plan's sign-in is a command run once on the person's computer, and `onKey.model`). The chat names one `acp-<id>` on a person's plan and `<id>` on the company's key.

[`@sanoma-ai/connector-anthropic`](https://www.npmjs.com/package/@sanoma-ai/connector-anthropic) gives Claude Code, `-github` Copilot, `-openai` Codex, `-opencode` OpenCode and `-pi` Pi.

## Webhooks

`SanomaClient.follow(event)` starts the built-in `follow` workflow on what a webhook says happened (the app's `POST /webhooks/<vendor>` calls it for each event it verified), as the runtime's agent `host-check`, with the run id `follow:<sha256 of the event>`: one run per event, however often it is delivered, and `start` refuses a `follow` under another id or actor. The worker runs it over its repository (`WorkerOptions.source`): an event of another repository, or on a worker with none, is ignored (the run's output says why).

A push to `main` fast-forwards the checkout, then starts apply on the declared hosts the lockfile binds (`ResolvedConfig.hosts()`; a host not bound yet waits for going live, whose apply makes it) as `host-check`, as the run `deploy:<head>`, so a merge made outside Sanoma deploys too: nothing without a host, nor while a change is merging or deploying, which applies `main` itself; when the checkout cannot follow `main`, the run fails, saying why, and deploys nothing.

A push to `draft/<id>` while the change of `id` is open brings the host's commits into the draft (`Source.follow` on its branch, a fast-forward) and tells the change `commits`; a closed pull request of `draft/<id>` tells it `merged` (with the merge commit) or `closed`. The change run checks a merge or a close on the host before it believes it. A delivery repeated does nothing more: the run id, a draft already at the head, and the event's key (`changeEvent`'s `key`, an idempotency key of its message) see to it.

`host-check` is not the Publish approval's approver, so it withdraws nothing: a change waiting on Publish reads the event when Publish is decided.
