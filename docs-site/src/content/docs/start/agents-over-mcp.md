---
title: Agents over MCP
description: "Connect an MCP client to a company, identify who acts on each call, and route multiple companies through one address."
sidebar:
  order: 5
---

Connect a client such as Claude Code to the company’s `/mcp` endpoint. Sanoma supports the Model Context Protocol (MCP) over Streamable HTTP, including MCP 2026-07-28 and 2025-era clients. The server keeps no session. The login identifies the person, policy decides each call, and the ledger attributes recorded actions to that identity.

On your own machine, identify the person with the `x-sanoma-actor` header. For Claude Code, add the following entry to `.mcp.json`.

```json title=".mcp.json"
{
  "mcpServers": {
    "acme": { "type": "http", "url": "http://127.0.0.1:3000/mcp", "headers": { "x-sanoma-actor": "ada" } }
  }
}
```

To have the calls made by an agent on the person's behalf, declare the agent in `resources/people.ts` (`sanoma.agent({ id: "claude-code", client: "https://claude.ai/oauth/claude-code-client-metadata" })`, [People](/policies/people/)) and name it in the `x-sanoma-agent` header beside `x-sanoma-actor` (either may be URI-encoded): `"headers": { "x-sanoma-actor": "ada", "x-sanoma-agent": "claude-code" }`.

Every tool call is then the agent's acting for Ada: the policy sees the agent, in its groups and `agents`, with `onBehalfOf` Ada (so an `@hold("on-behalf-of")` waits for her), and is asked again as Ada alone, the stricter answer standing, so the agent may do no more than she may ([People](/policies/people/)); `get_run`, the ledger, the run's trace and the Inbox say `claude-code for ada`.

A name that is not a declared agent (a person's, one of the runtime's own agents', `sanoma-chat`, the app's chat's own, among them, a built-in client's agent that no file declares, anyone undeclared), or an agent declared to act for someone else, is refused (403, `not_admitted`). Ada may approve a hold on a run her agent started for her.

The policy decides an agent's start of any workflow as it does Ada's (a `forbid` on `workflow:drift` for `agents` refuses it, not Ada); its start of one of the runtime's own workflows that does not only read (`apply`, say; `drift` and `plan` only read) also waits for a person in `admin`, unless a `permit` for agents lets it. Without the header, the calls are the person's, as above.

## Sign in to a hosted company

On a host, an MCP client signs in through the company's own staff sign-in, which is an OAuth 2.1 authorization server for `/mcp` ([Better Auth's](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/better-auth/README.md#agents-signing-in)). The instance has one agent address, set by `SANOMA_HOSTNAME`, the hostname the app is served at over HTTPS: `https://<hostname>/mcp`, with the sign-in at `https://<hostname>/auth/better-auth` as its issuer.

Without a hostname it is set by `SANOMA_HOST_URL`, the instance's own URL: a Cloudflare host's Worker has its workers.dev URL there, and an instance reached at a port, an IP address or over plain http names itself there (`SANOMA_HOST_URL=http://10.0.0.7:3000`). Tokens are issued for that address alone and the metadata names it, whatever host a request arrives on.

With neither variable the sign-in serves no OAuth, which `sanoma serve` says once when it starts: `/mcp` still answers a signed-in person's browser, and answers a client 401 with no challenge and an `error` that names both variables.

For Claude Code, run `claude mcp add --transport http acme https://acme.example/mcp`, substituting your company’s URL. The first unauthenticated request returns 401. Its `WWW-Authenticate` header points to `https://<hostname>/.well-known/oauth-protected-resource/mcp`, even when the request reached the app by another name. This metadata identifies the authorization server.

The client opens staff sign-in in your browser. Sign in by email code if you have no session, then review which client and agent are requesting permission to act for you. Clients with a loopback redirect, including Claude Code, request consent on every sign-in because another local program could use the same name. A client with its own HTTPS redirect asks once while it continues to represent the same agent. If the mapping changes, existing tokens are refused until you consent to the new agent.

The client gets an access token for that address's `/mcp` alone, and each tool call is the agent's acting for that person, exactly as with `x-sanoma-agent` above.

### Built-in Claude clients

Claude's clients are built in on every company, so they need no declaration. Each is known by the URL of its client ID metadata document and acts as a built-in agent, in the group `agents`, for the person who signed it in:

| Client                                                     | Client id                                             | Built-in agent |
| ---------------------------------------------------------- | ----------------------------------------------------- | -------------- |
| Claude's apps: claude.ai, Claude Desktop and Claude mobile | `https://claude.ai/oauth/mcp-oauth-client-metadata`   | `claude-ai`    |
| Claude Code                                                | `https://claude.ai/oauth/claude-code-client-metadata` | `claude-code`  |

The consent page names the built-in agent and says it is built in to Sanoma and that the company has not turned it off. A policy written for `agents` reaches a built-in agent as it reaches any agent, and one may name it (`principal == Sanoma::Principal::"claude-code"`), so a company can forbid or hold its calls by policy alone. `sanoma check` and the People page's Agents tab list each built-in client and whether the company accepts it.

A company changes this in `resources/people.ts`, read at each request like the rest of the people:

```ts title="resources/people.ts"
// Claude Code acts as the company's own agent instead of the built-in one.
export const claudeCode = sanoma.agent({
  id: "claude-code",
  client: "https://claude.ai/oauth/claude-code-client-metadata",
  onBehalfOf: ada,
});

// Claude's apps are turned off: refused as an undeclared client is.
export const noClaude = sanoma.agent({ id: "claude-ai", off: true });
```

- **Replace it.** An agent that declares a built-in client stands for that client, under any id, with its own groups and `onBehalfOf`. The built-in agent then does not act.
- **Turn it off.** `sanoma.agent({ id: "<the built-in agent's id>", off: true })` turns that built-in off. The declaration is no agent, and `off` on any other id, or beside a `client` or an `onBehalfOf`, is a problem `sanoma check` reports.
- **An id already taken.** A person or an agent with a built-in agent's id that does not declare its client keeps that id, and the built-in client is refused while it does; `sanoma check` warns. So `sanoma.agent({ id: "claude-code", client: "claude-code" })` still works on this machine as before, and Claude Code is refused on a host until the agent names the client's URL.

### Other clients and bearer tokens

Any other client is let in only as an agent `resources/people.ts` declares for it, by its client id (`sanoma.agent({ id, client })`). A built-in client turned off is refused the same way at authorize, the token endpoint and `/mcp`, with words that say it is turned off rather than where to declare it.

A client no agent declares is refused when it asks to sign in, with a page that says where agents are declared and shows the client's id, to declare only for a client you chose to connect yourself (a link anyone sends can name any client); a token is refused (403, `not_admitted`) as soon as its agent's declaration goes or its built-in is turned off, and one for another host's `/mcp`, expired or not this company's is a 401 that sends the client to sign in again.

A token is taken at `/mcp` alone, as `Authorization: Bearer` (the scheme in any case); a DPoP token is not one (the sign-in issues none), and gets the same 401. The client can end its refresh token itself (RFC 7009 revocation, with its client id alone); signing out of the app's sign-in does not, since that grant is the client's, not the browser's. A browser with a signed-in session still reaches `/mcp` as the person. The `x-sanoma-actor` header means nothing on a host, and `x-sanoma-agent` is refused there (400). An API token (`sca_…`) acts as a visitor and is refused.

## Available tools

It has five tools, as the person or the agent acting for them, the same the app's chat has (`src/server/catalog.ts`, one definition for both):

| Tool        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe`  | What `sanoma.describe` answers through `POST /api/call`: each workflow it may start, the company's and the runtime's (name, api name, title, trigger, input as JSON Schema; `builtin` for the runtime's, `readOnly` for one that only reads, such as `drift` and `plan`), each operation that may be called directly, a company operation's among them (id, effect, description, input and output) and each collection. It leaves out the internal workflows, which only Sanoma starts, and the policy, file paths and source, the resources' declared values, secret bindings, connections and the database's host |
| `lookup`    | Calls an operation that may be called directly and whose effect is read; any other is `invalid_input`. A call the policy holds is `approval_pending`, with the `runId` of its run                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `get_run`   | A run's workflow, status, who started it, when, its approvals and its error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait_run`  | Waits up to 20 s (`waitMs`) for the run to end: `{ runId, status: "finished", output }`, the workflow's `opaque` fields `"<name>"` unless the agent started the run, for the same person; `{ runId, status: "waiting for approval", waitsFor }` at once while it is held, naming whose decision it waits for; or `{ runId, status: "running" }` while it has not ended |
| `start_run` | Starts a workflow, by the name or api name `describe` lists, with its input: `{ runId }`. `drift` checks the declared resources against their vendors and `plan` says what `apply` would do, both changing nothing; `apply` makes them so. The policy decides the start, as it does any start; an agent's start of one of the runtime's workflows that does not only read, such as `apply`, waits for an admin (see [Approvals](/workflows/approvals/)). An internal workflow, such as `call` or `save-draft`, is `invalid_input`, as is a name `describe` does not list                                            |

`start_run` and `lookup` take an optional `id` (letters, digits, `_` and `-`, at most 200), as the app's own calls send one. Send a new one for each call and the same one on a retry: a start with an id it already has answers that run (the run's id is the `id`) when the workflow, input, person and agent are the same, and is refused (`invalid_input`) when they are not; a held lookup retried with its id is the same held run, so it files one approval.

`/mcp` only answers requests: a 2026-07-28 client's `subscriptions/listen` is refused at once (JSON-RPC `-32603`), since the tools never change. A refusal of a tool call is a tool error whose structured content is the error body above, with its `status`. A visitor is refused (403), as is a request from a page on another site, told by its `Sec-Fetch-Site` or `Origin` header, so a page elsewhere cannot act with this browser's name; a public site's host has no `/mcp` (404). An MCP client sends neither header and needs no CSRF token.

## A router: one `/mcp` for many companies

An instance can serve a router: one address, such as `https://mcp.acme.example/mcp`, that the agents of many companies connect to, while each company stays on its own host with its own sign-in. The router is stateless. It checks no token, signs nothing, and keeps no credential, session or cache. It finds which company a request is for and sends the request on. The company's own staff sign-in stays the only authority: it signs every token and checks every call.

Turn it on in the config of the instance that serves it:

```ts
export default defineConfig({
  connectors: [],
  router: {
    hostname: "mcp.acme.example",
    companies: { collection: "companies", url: "url", live: { field: "status", is: "live" } },
  },
});
```

- `hostname` is the one host the router answers on, over HTTPS. Its issuer is `https://<hostname>` and its agent surface `https://<hostname>/mcp`.
- `companies.collection` names one of this instance's [collections](/workflows/collections/). A record's key is the company's id (letters, digits, `-` and `_`), and its `url` field (another field with `companies.url`) is that company's base URL: an `https` origin with no path, user or query, such as `https://acme.sanoma.example`. Plain `http` is taken only for this machine (`localhost`, `127.x.x.x`, `::1`). A record with any other URL is not routed to.
- `companies.live` is optional: only records whose `field` is `is` (or one of a list) are routed to. Without it, every record with a URL is.
- `SANOMA_ROUTER_SECRET`, in the app's environment, is the router's master secret: 32 visible ASCII characters or more. On a `cloudflare.host`, apply binds it from the stored secret of that name ([below](#on-cloudflare)). It is sent to no one. Each company gets its own secret, derived from the master and the company's id ([below](#each-companys-secret)). Without it the router forwards nothing and its routes answer 503; one that is shorter, or holds a space or a character outside ASCII, stops `sanoma serve` at its start (on a Worker it is logged and no router is served).

`sanoma check` refuses a `router` whose hostname is no hostname, whose collection the company does not have, or whose fields the collection lacks. The router reads the list on each request, through the app's own client, with no policy asked and nothing recorded (`SanomaClient.routedCompany`, which answers only a company's URL and whether it is routed to): it is the runtime's own read, not a person's. A company is found by its exact id, never by a host a request names, so the router contacts no address outside the list.

Whoever may write the companies collection controls where each company's agent traffic goes: authorization codes, refresh tokens, access tokens and every `/mcp` call for a company are sent to the URL its record holds. Give the write to that collection, in the policy, only to the people and workflows that provision companies.

The router's hostname is its own: `sanoma serve` refuses to start when it is `SANOMA_HOSTNAME` or a public site's domain (`SANOMA_DOMAINS`); a Worker logs it and serves no router.

### Router endpoints

On the router's hostname the app serves these routes and nothing else (any other path is a 404, `/healthz` and the sign-in among them), ahead of every login. On the Worker, the hostname is one more host it answers beside `SANOMA_HOSTNAME` and the sites' domains, and a `cloudflare.host` attaches it ([below](#on-cloudflare)).

| Route                                           | What it answers                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728's metadata: `{ resource: "<router>/mcp", authorization_servers: ["<router>"], bearer_methods_supported: ["header"] }`. Also at `/.well-known/oauth-protected-resource`                                                                                                                                                                                                                                                                              |
| `GET /.well-known/oauth-authorization-server`   | RFC 8414's metadata for the issuer `<router>`: `authorization_endpoint`, `token_endpoint` and `revocation_endpoint` at `<router>/authorize`, `/token` and `/revoke`, and the same scopes, grants, `S256`, `none` and Client ID Metadata Document support a company's own document names. No `jwks_uri`: the router has no keys                                                                                                                               |
| `GET /authorize`                                | A page that asks "Which company?", with one field for the company's id. Submitted, it is a GET with `company=<id>` and the client's own query, answered with a 302 to `<that company's URL>/auth/better-auth/oauth2/authorize?<the client's query, unchanged>`. An id that is not listed gets the page again, saying so (404), never a redirect; one that is listed and not routed to now gets the page saying that company is not available right now (503) |
| `POST /token`                                   | The form, unchanged, sent to the company named before the first `.` of its `code` (or its `refresh_token`, for a refresh), at `/auth/better-auth/oauth2/token`; that company's status, body and headers back. No such company: 400 `invalid_grant`. No code or token, or no form: 400 `invalid_request`. A form larger than 4 MB: 413, read no further than that                                                                                             |
| `POST /revoke`                                  | The same for the form's `token`, sent to the company's `/auth/better-auth/oauth2/revoke`. A token that names no listed company is answered 200 with no body: RFC 7009 treats a token the server does not know as revoked already                                                                                                                                                                                                                             |
| `GET`, `POST`, `DELETE /mcp`                    | With a bearer, the call goes to the company its `sanoma_company` claim names, read from the token without checking it, with the method, `Authorization`, `Accept`, `Content-Type` and MCP's own headers, and the body sent on as it arrives, never read or held by the router; the answer is passed back as it streams. Without one: a 401 naming the router's metadata. A bearer that names no listed company: 401 `invalid_token`                          |

A company that is in the list but not routed to now (its `live` field says so, or its URL is not one the router sends to) is answered 503 `temporarily_unavailable` with `Retry-After: 60` on `/token`, `/revoke` and `/mcp`. A client keeps its tokens and asks again; it is never told they are no good.

A token request and a revocation carry the caller's address (`x-sanoma-router-client-ip`) and that company's secret (`x-sanoma-router-secret`). A `/mcp` call carries neither, since nothing at a company's `/mcp` reads them. No forwarded request carries the caller's cookies. A redirect from a company is not followed and not passed on (502), as is a company that does not begin to answer in 30 seconds; an answer that has begun streams as long as it does. When the caller disconnects, the request to the company ends too.

### Each company's secret

The router never sends its master secret. It sends each company that company's own:

```txt
secret = HMAC-SHA256(key = master secret, message = company id), as lower-case hex
```

Both are taken as UTF-8, and the result is 64 characters. Whoever provisions a company computes it once and sets it as that company's `SANOMA_ROUTER_SECRET`, for example with `printf %s acme | openssl dgst -sha256 -hmac "$MASTER" -r | cut -d' ' -f1`. In code it is `routerSecretFor(master, company)` from `sanoma/workflows`. A company's secret that leaks lets its holder name a caller's address at that company's token endpoint, and nothing at any other company; it says nothing of the master.

The one variable holds the master on the instance that serves the router and a company's own secret on an instance behind one. An instance that serves a router and is also listed behind that same router would need both, which is not supported: its token endpoint then counts every caller the router forwards as the router's one address.

A company behind a router has the router's `/mcp` as its agent address. Set three variables on it; they are read before `SANOMA_HOSTNAME` and `SANOMA_HOST_URL`:

```sh
SANOMA_AGENT_URL=https://mcp.acme.example/mcp   # the router's agent surface
SANOMA_COMPANY=acme                             # this company's id in the router's list
SANOMA_ROUTER_SECRET=…                          # this company's own secret at the router
```

On a `cloudflare.host`, declare them as `agents` instead ([below](#on-cloudflare)).

That company then:

- signs tokens as the router (`iss` is `https://mcp.acme.example`, `aud` its `/mcp`), and names itself in each access token (`sanoma_company`);
- puts `acme.` in front of every authorization code and refresh token it sends out, and takes one back only with it, so a code or token without the tag, or with another company's, gets `invalid_grant` and spends nothing;
- refuses at `/mcp` a token whose `sanoma_company` is not its own (401 `invalid_token`), whoever signed it;
- serves no RFC 8414 document of its own, and names the router's metadata in its RFC 9728 document and in `/mcp`'s 401;
- keeps authorize, the sign-in and the consent on its own host, where its cookie is. Authorize there takes the router's `/mcp` as its `resource`, and nothing else;
- counts its token endpoint's and its revocation's rate limit by the address the router names, only for a request that carries this company's secret (compared in constant time). On every other route (the sign-in, an email code, the consent, which a browser reaches itself) and without the secret, that header is ignored and the limit counts the connection's own address.

What the tag does not do: it is not a credential. Anyone can write a token that names any company, and the router will send it there, where that company's sign-in refuses it. The router stops nothing a company would not stop itself.

### On Cloudflare

A [`cloudflare.host`](/hosting/hosts/) sets both sides up; nothing is set on the Worker by hand.

A company behind a router declares `agents` on its host:

```ts
// resources/sanoma/infra.ts
import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";

export const host = cloudflare.host({
  name: "acme",
  database: store,
  agents: {
    url: "https://mcp.acme.example/mcp", // SANOMA_AGENT_URL
    company: "acme", // SANOMA_COMPANY
  },
});
```

`sanoma check` refuses a `url` that is not a router's `/mcp` and a `company` that is no id. The instance that serves the router declares nothing more: its config's `router.hostname` is enough, and apply attaches that hostname to the Worker as a custom domain, beside the app's `hostname` and the sites' domains.

Either way the host is given one secret, stored as `SANOMA_ROUTER_SECRET`: this company's own secret for a company behind a router, the master secret for the company that serves one. Give the name a value where apply runs by binding it to a variable in `sanoma.config.ts` and setting that variable (in `.env` on your machine; on the host the Worker passes it to the runtime itself):

```ts title="sanoma.config.ts"
export default defineConfig({
  connectors: [cloudflare],
  secrets: { bindings: { SANOMA_ROUTER_SECRET: { env: "SANOMA_ROUTER_SECRET" } } },
});
```

Without a value apply reports the problem and leaves the host out of its plan; it never uploads the Worker without the secret, and the Hosting page lists the secret as not stored. Apply refuses a value no router could send before it changes anything, and never shows it. Plans, states and the ledger hold the URL, the company and the secret's name.

Take `agents` out of the data file, or `router` out of the config, and the next apply uploads the Worker without the bindings and detaches the router's hostname. Three things are problems in `sanoma check`: a host with `agents` in a company whose config has a `router` (the one variable cannot hold both secrets); a router's hostname that is a declared host's `hostname` or a site's domain; and, at apply, two hosts that derive in a config with a `router`, since both would attach its hostname.

A config with a `router` takes one such host today. A declared host of another type (`docker.container`, say) gets a warning: it attaches no hostname and is given no secret, so route the hostname and set the variable yourself. A container that is running keeps the environment it started with, so after changing `agents` alone, or the secret's value, advance the host's `configurationRevision`. The connector's [README](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/cloudflare/README.md#the-agents-router) has the requests and the refusals.

Not verified yet: no real Claude client has completed a sign-in that starts at the router's host and continues on a company's. The tests drive the whole flow with their own client, on Node and (for discovery and one `/mcp` call) on workerd. The Cloudflare host's bindings and the router's hostname are tested on its fake and on replies written from Cloudflare's API reference, not on a live account.
