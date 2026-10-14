# sanoma

Workflow automation like Zapier or n8n, where every workflow is code. The person who runs it works in an app: they start runs, approve what waits on them, and see each workflow as a graph and each run step by step. Behind the app, each workflow is a plain TypeScript file in the company's own repo rather than a graph stored in a vendor's database, so any developer can read it, review a change to it and take it further. It is built for the moment a workflow outgrows the person who built it and has to be handed over. We call the idea Business as Code. This TypeScript monorepo is its source-available core: the runtime, the app and the connectors, which anyone can read and self-host.

Status: early. Workflows run on [DBOS](https://dbos.dev) with Postgres: each vendor call is a durable step, approvals and sleeps survive restarts, and a lint keeps workflow code safe to replay. Before every vendor call a policy lets it through, denies it or holds it for an approver, and a ledger records each run: who started it, every call with the policy's decision and the vendor's reply, every approval, and how it ended. Versioning is automatic: each run is stamped with a hash of the workflow code it started on, and only a worker on that version resumes it (`DBOS__APPVERSION` names a version instead; see [Versions](packages/workflows/README.md#versions)). The connectors so far are listed under [Contents](#contents); keeping a company's vendor settings (card limits, time-off policies, access in tools like Mercury, Gusto and Okta) in typed files is where it is headed, not what it does today.

![The app: starting a run of announce, approving its launch copy in the Inbox, then the run finishing](.github/assets/demo.gif)

A run of the workflow below, which waits for approval, sleeps until launch and then publishes. Ghost is answered here by the connector's in-memory fake.

## What a workflow looks like

A company repo holds `sanoma.config.ts` with `workflows/` and `policies/` beside it, and the [`sanoma`](packages/sanoma/README.md) bin runs its workflows and the app. A workflow lists the vendor operations it may call, and can call nothing else. This one drafts a blog post, waits for the marketing lead, sleeps until launch, then publishes:

```ts
// workflows/announce.ts
import { ghost } from "@sanoma/connector-ghost";
import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "announce",
  trigger: "manual",
  input: z.object({ title: z.string(), body: z.string(), launchAt: z.iso.datetime({ offset: true }) }),
  uses: [ghost.post.create, ghost.post.publish, "approval", "sleep"],
  run: async (ctx, { title, body, launchAt }) => {
    const post = await ctx.ghost.post.create({ title, html: body, status: "draft" });
    await ctx.approval("Review launch copy", {
      approver: "marketing-lead",
      covers: [ghost.post.publish],
      links: [post.url],
    });
    await ctx.sleep({ until: launchAt });
    return ctx.ghost.post.publish({ id: post.id });
  },
});
```

The app draws this file as a graph before it runs, lists the approval in its Inbox, and shows each run's calls, decisions and replies in its ledger. A developer changes the workflow by changing the file. [`@sanoma/workflows`](packages/workflows/README.md) has the whole API.

![The announce workflow's page: its graph, the ghost.post.publish step selected, and the source of workflows/announce.ts](.github/assets/workflow.png)

The workflow's page: the graph is drawn from the file, and picking a step finds its line in the code.

![The Inbox with "Review launch copy" approvals waiting for marketing-lead](.github/assets/inbox.png)

The Inbox: the approvals waiting for you, with the draft's link and what approving lets through.

![A finished run of announce: its graph, the approval and its note, and its ledger with Ghost's reply](.github/assets/run.png)

A finished run and its ledger: each call with the policy's decision and the vendor's reply, and the approval with its note.

## Contents

| Path                                                        | What it is                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`packages/`](packages/AGENTS.md)                           | Core workspace packages                                                                      |
| [`sanoma`](packages/sanoma/README.md)                       | The bin a company repo runs, checks and exports itself with; what its workflows import       |
| [`@sanoma/workflows`](packages/workflows/README.md)         | Define connectors and workflows, run them durably on DBOS, and lint them                     |
| [`@sanoma/app`](packages/app/README.md)                     | Web UI over a config, started with `startApp(config)`                                        |
| [`@sanoma/testing`](packages/testing/README.md)             | `startTestWorker`, `testDatabaseUrl`, a vitest test app, vendor replay, and scenario testing |
| [`@sanoma/bridge`](packages/bridge/README.md)               | OpenTofu providers: the provider-bridge client, its fake, the resource generator             |
| [`connectors/`](connectors/AGENTS.md)                       | Vendor connectors, one workspace package each                                                |
| [`@sanoma/connector-ghost`](connectors/ghost/README.md)     | Ghost Admin API post operations and an in-memory fake                                        |
| [`@sanoma/connector-resend`](connectors/resend/README.md)   | Resend broadcast operations and an in-memory fake                                            |
| [`@sanoma/connector-bluesky`](connectors/bluesky/README.md) | Bluesky post operations and an in-memory fake                                                |
| [`@sanoma/connector-github`](connectors/github/README.md)   | GitHub resources read through its OpenTofu provider, and a replay fake                       |
| [`@sanoma/connector-stripe`](connectors/stripe/README.md)   | Stripe resources read through its OpenTofu provider, and a replay fake                       |
| [`modules/`](modules/AGENTS.md)                             | Placeholder for parts not written yet                                                        |
| [`types/`](types/AGENTS.md)                                 | Ambient type declarations shared by the packages                                             |
| [`.github/`](.github/AGENTS.md)                             | GitHub Actions CI and the README's images                                                    |
| [`.claude/`](.claude/)                                      | Agent skills for Claude Code                                                                 |
| [`.agents/`](.agents/)                                      | Vendored agent skills                                                                        |
| [`package.json`](package.json)                              | Root scripts: typecheck, build, lint, format, test, `db:up`, `bridge:download`               |
| [`tsconfig.json`](tsconfig.json)                            | Root TypeScript config: `sanoma`'s shipped options, with `@sanoma/*` paths to each `src/`    |
| [`vitest.config.ts`](vitest.config.ts)                      | Test config with aliases to the package sources                                              |
| [`docker-compose.yml`](docker-compose.yml)                  | Postgres for DBOS on port 5433                                                               |
| [`lefthook.yml`](lefthook.yml)                              | Pre-commit format and lint on staged files                                                   |
| [`.oxlintrc.json`](.oxlintrc.json)                          | Lint config                                                                                  |
| [`.oxfmtrc.json`](.oxfmtrc.json)                            | Format config                                                                                |
| [`pnpm-workspace.yaml`](pnpm-workspace.yaml)                | Workspace globs: `packages/*` and `connectors/*`                                             |
| [`skills-lock.json`](skills-lock.json)                      | Lock file for installed agent skills                                                         |

Connectors live here under `connectors/`; one moves to its own repo only when someone outside the team maintains it.

## Develop

Needs Node 24, or 26 and later (Cucumber, which runs the scenarios, does not support 25), pnpm, and Docker for the workflow tests.

```sh
pnpm install
pnpm db:up          # Postgres for DBOS on port 5433
pnpm test           # vitest, runs against the TypeScript sources
pnpm typecheck
pnpm lint && pnpm format:check
pnpm build          # compiles each package to dist/ for publishing
```

Inside the repo, `@sanoma/*` imports resolve to each package's `src/` (via `paths` in `tsconfig.json` and aliases in `vitest.config.ts`), so tests and typechecks need no build. Published packages ship the compiled `dist/`, not the sources.

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2). You may use, modify and self-host Sanoma for any purpose except offering it as a competing commercial product or service. Each version becomes available under Apache-2.0 two years after its release.

## Contributing

For repository maintenance, start with [AGENTS.md](AGENTS.md) and follow only the relevant package guide.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). Sign off every commit with `git commit -s`. See the org-wide contributing guide, code of conduct and security policy in [`Sanoma-AI/.github`](https://github.com/Sanoma-AI/.github).
