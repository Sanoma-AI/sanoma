# Working in Sanoma

Read this file, then only the package guidance relevant to the task. The [README](README.md) owns product context and [development setup](README.md#develop).

Describe Sanoma the way the [README's opening](README.md#sanoma) does, and claim only what exists today.

## Package map

| Working on                                                                       | Read next                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The `sanoma` package and bin: run, check, export a company repo; its parts below | [sanoma](packages/sanoma/AGENTS.md)                                    |
| Runtime, people, Cedar policies, approvals, ledger, workflow analysis            | [workflows](packages/sanoma/workflows/AGENTS.md)                       |
| Web app, server functions, forms, graphs                                         | [app](packages/sanoma/app/AGENTS.md)                                   |
| Dogfooding a checkout from a company repo: `sanoma dev`                          | [dev](packages/sanoma/dev/AGENTS.md)                                   |
| Better Auth: the visitor login and staff sign-in                                 | [better-auth](packages/sanoma/better-auth/AGENTS.md)                   |
| The desktop shell (Electron) that runs a company folder in a window              | [desktop](packages/desktop/AGENTS.md)                                  |
| Test workers, fakes, recorded HTTP replay, scenarios                             | [testing](packages/sanoma/testing/AGENTS.md)                           |
| Provider bridge, schema generation, provider replay                              | [bridge](packages/sanoma/bridge/AGENTS.md)                             |
| Invoice models, calculations, industry adapters and PDF rendering                | [invoices](packages/invoices/AGENTS.md)                                |
| Vendor connectors                                                                | [connector conventions](connectors/AGENTS.md), then the vendor package |

Source and test directory maps live below each package. Open them when navigating that area; do not read every descendant guide up front.

## Shared development rules

- Use Node 26 or later and the pnpm version in [package.json](package.json). Run commands from the repository root unless noted.
- Workspace imports resolve to source in [tsconfig.json](tsconfig.json) and [vitest.config.ts](vitest.config.ts). `sanoma` and its subpaths do through the `sanoma-source` condition each entry of its `exports` carries, so a new entry needs only its condition; the other packages through `paths` and `resolve.alias`, kept aligned. Published, exports resolve to `dist/`.
- Run the affected package's tests and relevant root checks from [README.md](README.md#develop). [CI](.github/workflows/ci.yml) defines the full check sequence.
- Before implementation or investigation, use [start-task](.agents/skills/start-task/SKILL.md). For a PR, use [create-pr](.agents/skills/create-pr/SKILL.md). For a merge, use [merge-pr](.agents/skills/merge-pr/SKILL.md). For a new connector, use [build-connector](.agents/skills/build-connector/SKILL.md). Those skills own issue, worktree, and PR procedures. Sign off commits as described in [Contributing](README.md#contributing).

## Documentation boundaries

- For README prose and other product copy, use [copywriting](.agents/skills/copywriting/SKILL.md).
- `README.md` explains purpose, installation, usage, and public behavior. `AGENTS.md` contains a short map, maintenance constraints, and relevant checks. Link to details rather than repeat them.
- Put shared rules at the nearest common ancestor and package-specific rules in that package. Add deeper guidance only for a distinct boundary or a useful local map.
- Keep separate files at the root and package level. For a small directory index where the audiences need exactly the same content, use `AGENTS.md` as the source and a relative `README.md -> AGENTS.md` symlink. Do not symlink a long user manual into automatically loaded guidance.
- Package READMEs are regular files so package archives include them. Keep full API examples there, not in ancestor agent instructions.
