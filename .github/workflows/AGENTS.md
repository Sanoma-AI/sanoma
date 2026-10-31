# .github/workflows

GitHub Actions workflows for the repo.

## Contents

| Path                                         | What it is                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`gcp-live.yml`](gcp-live.yml)               | Explicit GCP/OIDC verification against disposable administrator-provisioned resources; separate from ordinary CI and no service-account private keys.                                                                          |
| [`ci.yml`](ci.yml)                           | CI on pushes to `main` and pull requests: starts Postgres, then runs format check, lint, typecheck, build and tests, and checks `@sanoma-ai/bridge`'s generated client is up to date                                           |
| [`visual.yml`](visual.yml)                   | Pull requests that touch what the app shows: one comment with each changed README still's before, after and diff; see [readme-shots](../../scripts/readme-shots/README.md#on-a-pull-request)                                   |
| [`desktop.yml`](desktop.yml)                 | The desktop shell's smoke test on changes to `packages/desktop`: Electron under xvfb opens a fixture company with a fake launcher (Playwright); and its unit tests on Windows                                                  |
| [`release.yml`](release.yml)                 | Run by hand on `main`: publishes each public package whose version is not yet on npm, then pushes the runtime image `ghcr.io/sanoma-ai/runtime:<sanoma version>` when ghcr.io lacks it; see [Release](../../README.md#release) |
| [`desktop-release.yml`](desktop-release.yml) | Run by hand on `main`: builds the unsigned macOS desktop app (arm64 and x64, dmg and zip) and uploads it to a draft GitHub Release `desktop-v<version>`; see [Desktop (preview)](../../README.md#desktop-preview)              |
