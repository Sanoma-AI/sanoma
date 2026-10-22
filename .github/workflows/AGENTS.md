# .github/workflows

GitHub Actions workflows for the repo.

## Contents

| Path                         | What it is                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ci.yml`](ci.yml)           | CI on pushes to `main` and pull requests: starts Postgres, then runs format check, lint, typecheck, build and tests, and checks `@sanoma-ai/bridge`'s generated client is up to date |
| [`release.yml`](release.yml) | Run by hand on `main`: stages each public package whose version is not yet on npm, for a maintainer to approve; see [Release](../../README.md#release)                               |
