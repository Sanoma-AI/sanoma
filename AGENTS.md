# Working in Sanoma

Read this file, then only the package guidance relevant to the task. The [README](README.md) owns product context and [development setup](README.md#develop).

## Package map

| Working on                                              | Read next                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime, policies, approvals, ledger, workflow analysis | [workflows](packages/workflows/AGENTS.md)                              |
| Web app, HTTP API, forms, graphs                        | [app](packages/app/AGENTS.md)                                          |
| Test workers, fakes, recorded HTTP replay, scenarios    | [testing](packages/testing/AGENTS.md)                                  |
| Provider bridge, schema generation, provider replay     | [bridge](packages/bridge/AGENTS.md)                                    |
| Vendor connectors                                       | [connector conventions](connectors/AGENTS.md), then the vendor package |

Source and test directory maps live below each package. Open them when navigating that area; do not read every descendant guide up front.

## Shared development rules

- Use Node 24+ and the pnpm version in [package.json](package.json). Run commands from the repository root unless noted.
- Workspace imports resolve to source in [tsconfig.json](tsconfig.json) and [vitest.config.ts](vitest.config.ts). Keep both mappings aligned when changing package entry points; published exports resolve to `dist/`.
- Run the affected package's tests and relevant root checks from [README.md](README.md#develop). [CI](.github/workflows/ci.yml) defines the full check sequence.
- For a new task, use [start-task](.agents/skills/start-task/SKILL.md). For a PR, use [create-pr](.agents/skills/create-pr/SKILL.md). Those skills own issue, worktree, and PR procedures. Sign off commits as described in [Contributing](README.md#contributing).

## Documentation boundaries

- `README.md` explains purpose, installation, usage, and public behavior. `AGENTS.md` contains a short map, maintenance constraints, and relevant checks. Link to details rather than repeat them.
- Put shared rules at the nearest common ancestor and package-specific rules in that package. Add deeper guidance only for a distinct boundary or a useful local map.
- Keep separate files at the root and package level. For a small directory index where the audiences need exactly the same content, use `AGENTS.md` as the source and a relative `README.md -> AGENTS.md` symlink. Do not symlink a long user manual into automatically loaded guidance.
- Package READMEs are regular files so package archives include them. Keep full API examples there, not in ancestor agent instructions.
