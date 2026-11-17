---
title: Files sanoma writes
description: "sanoma env keeps .env.example the manual of the variables."
sidebar:
  order: 2
---

`sanoma env` keeps `.env.example` the manual of the variables: `SANOMA_DATABASE_URL`, `SANOMA_APP_PORT`, `SANOMA_APP_HOST`, `SANOMA_HOSTNAME`, `SANOMA_HOST_URL`, a router's `SANOMA_AGENT_URL`, `SANOMA_COMPANY` and `SANOMA_ROUTER_SECRET`, and the GitHub sign-in variables first, with their defaults, then a block per vendor in the connectors' order, each variable its driver's `env` declares with its `.describe()` text. A required variable is `NAME=`; an optional one is commented out, `# NAME=`, with `Optional.` before its description. The same config gives the same text, which `--check` compares byte for byte. Copy bootstrap inputs to `.env` (ignored by git). Store-backed credential reads use `secrets.bindings` to select an environment variable explicitly; there is no environment-first fallback. Connector pages write to the selected store. Drivers still using their own `env` declarations remain a separate path until migrated to named authentication.

## The lint

`sanoma check` lints `workflows/`, `resources/`, `sites/` and `apps/`, those that exist, with oxlint, run in the repo's root on the repo's own `.oxlintrc.json`, so an editor's oxlint reads the same file and the rules' `workflows/**` globs match against the root. `sanoma check` writes that file when there is none:

```json
{
  "extends": ["./node_modules/sanoma/oxlint.json"]
}
```

`sanoma/oxlint.json` is self-contained (it extends nothing): `sanoma/workflows`'s rules (the clock, randomness, the network, the environment, the imports a workflow may make, with its plugin inside `sanoma`; data files are held to no lint, since Sanoma loads them and reports what does not load), a site's (client code only: no `*.server.*` file or route `server` handlers, no import of the runtime, a connector, Postgres, DBOS, Node's modules or TanStack Start, where server functions and middleware come from, the app only through `sanoma/site` and `sanoma/ui`, no relative import out of `sites/`, no import by a path from the root (`/…`: a file at a fixed address goes in the site's `public/` folder) or by a `#` import, no `virtual:` module (content comes through `content`), no `process` or `require`; types may be imported from anywhere; `sites/__virtual.ts`, the build's listing, aside) and the rules this repo holds its own code to. Add your own rules beside the `extends`; `sanoma check` leaves an existing file alone.

## Template files

`sanoma/init` is how `sanoma init` writes a company's own facts into the company template's files, as plain functions over text that a workflow or a site's page can import too (to apply them to a repository's files read with `github.repository.files`, say): `declareFounder(text, creator)` writes the `founder` in `resources/people.ts` as `creator` (a `Creator`: `id`, and `name`, `github` or `email` when known), `declareName(text, name)` writes `name` first in `sanoma.config.ts`, and `declareSlug(text, slug)` puts the slug in place of the template's `"company"` in `resources/sanoma/infra.ts` (`INFRA`), in the Cloud names and the address. Each throws when the file is not shaped as the template's.

## Generated files

| File                                                  | Written by                                | Commit it                                 |
| ----------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `.env.example`                                        | `sanoma env`                              | yes                                       |
| `.oxlintrc.json`                                      | `sanoma check`, when missing              | yes                                       |
| `sites/__virtual.ts`                                  | `sanoma` and `sanoma check`, with sites   | yes                                       |
| `sites/tsconfig.json`                                 | `sanoma` and `sanoma check`, when missing | yes                                       |
| `.sanoma/api.ts` (the sites' typed `api`)             | `sanoma` and `sanoma check`               | no (`.sanoma/`)                           |
| `.sanoma/content.ts` (the sites' typed `content`)     | `sanoma` and `sanoma check`, with sites   | no (`.sanoma/`)                           |
| `.sanoma/app/` (the route tree, its tsconfig, builds) | `sanoma` and `sanoma check`, with sites   | no (`.sanoma/`, and its own `.gitignore`) |
