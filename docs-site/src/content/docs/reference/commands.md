---
title: Commands
description: "Command syntax, effects, exit codes, and the events Sanoma reports to a parent process."
sidebar:
  order: 1
---

Run company commands in the directory containing `sanoma.config.ts`. Sanoma reads `.env` there before loading the config. Variables already set in the environment take precedence. To create a company in an empty directory, use `sanoma init`.

## Command reference

| Command | Use it to |
| --- | --- |
| `sanoma` | [Start the company](#start-the-company) on this machine. |
| `sanoma init [--name] [--you] [--email]` | [Create and run a company](/start/start-a-company/) in an empty directory. |
| `sanoma worker`, `sanoma app` | [Run the worker or app separately](#worker-and-app-processes). |
| `sanoma wakeup` | Serve the [wakeup service](/hosting/wakeup/) alone, with a `/healthz` endpoint. It uses the configured database under the same rules as `sanoma worker`, and listens on `SANOMA_APP_HOST` and `SANOMA_APP_PORT` (default port 3100). |
| `sanoma check` | [Check the company repo](#check-the-company-repo) and run its scenarios. |
| `sanoma demo --out <dir>` | Empty `<dir>` and write a [static demo](/sites/demos/) of the [sites](/sites/overview/). The output includes `mount.js`, its `chunks/`, `demo.css`, the assets it names under `files/`, and `index.html`. Workflows run in the browser against connector fakes seeded from `scenarios/world.feature`. |
| `sanoma env [--check]` | Write `.env.example` with Sanoma variables and each vendor driver’s variables, descriptions, and commented-out optional entries. For CI, `--check` compares without writing. A mismatch exits 1 with `.env.example is out of date: run sanoma env`. |
| `sanoma ledger export <runId> [--out <file>]` | Write one run’s ledger as JSON lines to stdout or a file, in `jsonlLedger` format. The command reads the configured store, defaulting to Postgres. For that default, it starts local Postgres if no URL is set. |
| `sanoma describe [--as] [--url] [--agent]` | Print the running app’s `sanoma.describe` result as JSON on stdout, including company workflows, direct operations, and collections. |
| `sanoma call <name> [--input <json>] [--id <id>] [--as] [--url] [--agent]` | Send the name and input to `POST /api/call` and print the JSON result. See [terminal and agent calls](#from-a-terminal-or-an-agent). |
| `sanoma --help` | Print command usage. |

### Start the company

`sanoma` starts the worker and app in one process. In an empty directory, it first initializes a company. On startup it reads environment or mounted-file keys and appends any missing keys it generates to the ignored `.env`. Local storage needs a signing key and a storage-encryption key. An external store needs only the signing key. The command checks that Postgres answers and starts [the company’s own database](/hosting/postgres/) if no URL is set.

The worker starts promoted so it can take queued runs. The CLI prints `<name> running <workflows>` and `<name> at http://127.0.0.1:3000; ctrl-c to stop` using the [configured company name](/workflows/writing-workflows/). Missing or invalid vendor variables produce a message such as `sanoma: 2 of 5 connectors not configured yet: ghost, resend; …` before those lines. A call to an affected vendor fails and names the missing variables. Configured vendors produce no such message.

With local sites, the dev server [updates pages as you save](/sites/developing/). In [dev mode](/reference/dev-mode/), a child process hosts the server and restarts on build changes.

The worker and app use the current Git checkout as their `source`. Changes to the live checkout commit to the current branch. Draft edits go into a separate worktree at `.sanoma/drafts/<id>` on `draft/<id>`, starting at the checked-out commit. The worktree links to the repo’s `node_modules`. Git excludes that link through `.git/info/exclude` because the `node_modules/` pattern in `.gitignore` matches directories. The app runs a draft’s `sanoma check` in the person’s [coding-agent box](/start/the-app/) without the company’s database URL or credentials.

A draft stays open while `git worktree list` includes it. Merge the branch by hand when working directly with these worktrees.

### Worker and app processes

`sanoma app` builds the app with its sites. `sanoma worker` executes workflows and, with `PORT` set, listens on [the worker’s port](/hosting/self-hosting/#the-workers-port). These commands use a supplied database URL without starting or probing Postgres. Without a URL, they can use the company’s database while another `sanoma` process runs it. Otherwise they exit 2.

The worker creates the runtime and sign-in tables. Start the worker first or alongside the app. The app checks for the tables and waits up to one minute.

### Check the company repo

1. Update [`.sanoma/api.ts`](/sites/overview/) and `.sanoma/schema.cedarschema` if their contents have changed.
2. Run `tsc -p tsconfig.json` and [oxlint](/reference/files/#the-lint) in the company’s workflow, operation, resource, site, and app source directories that exist, using `.oxlintrc.json`, creating the config if missing.
3. Validate the config with `describeConfig`. Checks cover workflow imports, graph and worker constraints, resource declarations and exports, site calls to missing APIs, missing visitor `permit` rules, and host domain assignments. Check [policies](/policies/people-and-policies/) and report each problem at `file:line:col` with its policy ID.
4. If the repo has sites, build the app with them, run `tsc -p sites/tsconfig.json`, and check `content/`.
5. If the policies pass, run the scenarios against fakes on `<database>_check`. Sanoma uses local Postgres when no URL is supplied and stops it afterward if the check started it. Each failed step is a problem. This command runs scenarios directly without Vitest.

Warnings print first as `file:line:col: warning: message`. Examples include an import between apps or a public page whose entries the sitemap cannot list. Problems follow, one per line, as `file:line:col: message` or `scenario › step: message`. Problems produce exit code 1. Warnings alone allow the check to pass.

## Exit codes

Exit codes: 2 for a mistake in the call or the repo (no `sanoma.config.ts`, an unknown command or option, a bad argument, an option of another command), printed with the usage where it helps; 1 for failed checks and failures while running, and for a call `sanoma call` or `sanoma describe` sends that the app refuses or that fails, or that nothing answers; 0 otherwise. `SANOMA_APP_PORT` is the app's port (default 3000; 0 for any free port, which the printed address reports).

`SANOMA_APP_HOST` is its address (default 127.0.0.1); `SANOMA_DOMAINS` gives a [public site](/sites/public-sites/) its domain, `<site>=<hostname>[,<site>=<hostname>…]` (`www=sanoma.example`, which a host resource's `domains` sets), and a malformed one exits 2; any other address signs people in with the [staff sign-in](/sites/login/#staff-sign-in-on-a-host) (an email code through the config's `login.sender`, invite links, and GitHub once `SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET` are both set, in the environment or stored by the app's Connect page (under Hosting) when it created the GitHub App; the public sites' logins then offer visitors GitHub too, for which the App's callback URLs need `https://<site host>/auth/better-auth/callback/github`), which needs `SANOMA_SIGNING_KEY`; a missing key, or one of the GitHub pair without the other, exits 2 before anything starts, as does a problem in the policies.

## Agent addresses

There too, `SANOMA_HOSTNAME` is the hostname the app is served at over HTTPS (`app.sanoma.example`: no scheme, port or path), as a host resource's `hostname` sets it on the Cloudflare host. It is the instance's one [agent address](/start/agents-over-mcp/): agents sign in at `https://<hostname>/mcp`. An instance reached any other way (a port, an IP address, plain http) gives its own URL in `SANOMA_HOST_URL` instead (`http://10.0.0.7:3000`, with no path), which is read when there is no hostname.

A company behind a [router](/start/agents-over-mcp/#a-router-one-mcp-for-many-companies) sets `SANOMA_AGENT_URL` (the router's agent surface, `https://mcp.sanoma.example/mcp`), `SANOMA_COMPANY` (its id in the router's list) and `SANOMA_ROUTER_SECRET` (this company's own secret at the router, which the router's operator derives from its master) instead, all three: they are read first, and the router's `/mcp` is then its agent address.

An instance whose config has a `router` reads `SANOMA_ROUTER_SECRET` on any host as that router's master secret, and refuses to start when the router's hostname is `SANOMA_HOSTNAME` or a public site's domain. Either way the secret is 32 visible ASCII characters or more. A value of any of these that names no address exits 2. With none, people still sign in but no agent can: `sanoma` says so once on stderr when it starts, and `/mcp` says which variables to set.

On SIGINT or SIGTERM the app, then the worker, then the Postgres it started, stop, and the process exits 0.

## From a terminal or an agent

A workflow’s API name or `<api>.start` returns JSON containing `runId`. Use `<api>.result` for its output, `<api>.runs` to list runs, or an operation ID for an operation. Internal workflows are reserved for Sanoma. The app refuses an external start with `invalid_input` (CLI exit 1), as it does over `/mcp`.

`sanoma describe` and `sanoma call` reach a `sanoma` that is already running, over HTTP: they start no worker and need no database, only the app. An agent with a shell uses them as a person at a terminal does: `sanoma describe` says what there is, then `sanoma call hello --input '{"title":"Hi"}'` starts a run and `sanoma call hello.result --input '{"runId":"…"}'` waits for its output.

The answer is the one thing on stdout, as JSON (indented at a terminal, on one line otherwise); a refused or failed call exits 1 with the app's message on stderr, its `code`, the run it names and, for an input that does not fit, each field's problem. A call the policy holds (409, `approval_pending`) exits 1 too, with its run's id on stderr and nothing on stdout.

- **Once:** each invocation of a start or an operation's call is a new run or call. `--id <id>` (letters, digits, `_` and `-`) names it instead: the same `--id` again is the same call, not a second one, and with another input it is refused. When a request times out or its connection breaks after it was sent, the error names the id it used, to run the command again with.
- **Which company:** the nearest directory from the working one up that holds `sanoma.config.ts` (short of a `node_modules`), then the company it is in (an app in `apps/<app>/` that kept its own config is its company's), each as the main checkout has it (from a draft in `.sanoma/drafts/<id>`, the company's own directory). The first of those with a running app is the one whose app the commands ask and whose `.env` and people they read; with none running, the company's. Outside any, they exit 2, unless `--url` names the app; then `--as` is needed.
- **Which app:** `--url`; else the one the company's `.sanoma/app.json` names while its process runs, when that is an http(s) address on this machine (`sanoma`, `sanoma serve` and `sanoma app` write it, `{"url","pid"}` and `"signIn":true` for an app that listens beyond this machine, once the app listens, and remove it when they stop; one whose process is gone is ignored); else `SANOMA_APP_HOST` (default 127.0.0.1) and `SANOMA_APP_PORT` (default 3000), after `.env`.

  A `--url` with a user or a password in it is refused (exit 2). With `SANOMA_APP_PORT` empty or 0 and no running app to say where, name it with `--url` (exit 2). Two `sanoma` started on port 0 in one directory share one discovery file, the last one's: name the address with `--url` then. When nothing answers, the command exits 1 naming the address it tried and where it came from.
- **Who asks:** `--as`, a declared person's id, else one's email, else one's GitHub login (an id always wins: `--as sam` is the person `sam`, whoever's GitHub login is `sam`); else the one person `resources/` declares, as the app's picker takes them; else the person git's `user.email` names. Otherwise it exits 2 listing the people. A company that declares nobody needs `--as`.
- **For an agent:** `--agent <id>` names a declared agent (`sanoma.agent`) that makes the call on that person's behalf, as `x-sanoma-agent` does on [`/mcp`](/start/agents-over-mcp/): the policy and the ledger see the agent for the person.
- **Where:** an app on this machine, listening on this machine alone. An app on any other address (a host, or `SANOMA_APP_HOST=0.0.0.0`) asks its staff sign-in who is asking, which these commands do not give: they say so when it refuses them. Their stdout holds the answer alone, `SANOMA_EVENTS=1` or not: a failure is on stderr, never an `error` event.
- **Waiting:** `<api>.result` asks again while the run is running, a second apart at least, for up to 10 minutes; ctrl-c stops waiting (exit 130), and the run goes on.

## For a parent process

A parent process, such as a desktop shell, runs `sanoma` with `SANOMA_EVENTS=1` and reads its stdout line by line: beside the lines a person reads, each event is one JSON object on a line of its own, `{"sanoma":1,"event":…}`; logs stay on stderr.

- `{"sanoma":1,"event":"ready","url":"http://127.0.0.1:3000","sites":{"www":"http://www.localhost:3000"}}`: the app listens, right after the `at <url>; ctrl-c to stop` line, each time it starts (in [dev mode](/reference/dev-mode/), after each restart); `url` is where the app listens, on the port `SANOMA_APP_PORT` names (the free one it took, for 0), and `sites` is `{}` without public sites. `sanoma worker` has no address and prints none.
- `{"sanoma":1,"event":"error","message":"…"}`: the launcher cannot start or stop, with the message it printed on stderr, then exits 2 for a mistake in the call or the config, 1 for a failure. In dev mode a child that fails prints it too, and the launcher waits for the next build to start it again.
- `{"sanoma":1,"event":"checked","ok":false,"problems":["…"],"warnings":[]}`: `sanoma check`'s result, the lines it printed as two lists, before it exits; a check that cannot read the config ends with `error` instead. Read it rather than the printed lines: DBOS logs on stdout too.
- `{"sanoma":1,"event":"stage","stage":"template","status":"start"}`, then `"status":"done"`: a stage of starting a company (`sanoma init`, or `sanoma` in an empty directory), in this order: `template` (the files copied, named and keyed), `people` (you declared), `git` (the repository and its first commit), `install` (the package manager's install), then `database` (the company's own Postgres answering, from the `sanoma` the install brought, which then starts the worker and the app).

  A stage that fails has no `done`; an `error` follows. `database` comes on every run, not only the first, around the `database` event; none when a URL is named.
- `{"sanoma":1,"event":"database","how":"started","url":"postgresql://postgres:…@127.0.0.1:54012/sanoma","place":"this-computer"}`: the company's own [Postgres](/hosting/postgres/) answers, once, before the worker starts (in dev mode, from the parent, not each child): `how` is `created` (made first), `started`, or `answered` (another `sanoma` runs it), and `url` holds its password, so a parent never logs it. None when a URL is named.

With the variable, the end of stdin (the parent closing it, or exiting), or an error reading it, stops `sanoma` as SIGTERM does, so the parent keeps stdin open while it runs. `sanoma` never prompts and, without the variable, never reads stdin; it opens no browser. SIGTERM stops everything it started (the app, then the worker; in dev mode its child and the watch builds), then the company's own [Postgres](/hosting/postgres/) when it started it and no other client is connected, and it exits 0.
