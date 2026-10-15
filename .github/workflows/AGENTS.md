# .github/workflows

GitHub Actions workflows for the repo.

## Contents

| Path                         | What it is                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ci.yml`](ci.yml)           | CI on pushes to `main` and pull requests: starts Postgres, then runs format check, lint, typecheck, build and tests, and checks `@sanoma-ai/bridge`'s generated client is up to date |
| [`release.yml`](release.yml) | Publishes the public packages to npm on a `v*` tag; see [Release](../../README.md#release)                                                                                           |
