---
title: Dev mode
description: When Sanoma uses a local checkout, which package changes restart the server, and what happens when you unlink it.
sidebar:
  order: 3
---

Dev mode runs a company against a local Sanoma checkout. The `sanoma` process runs the server as a child process and restarts it when a linked package’s build changes.

## Activation

Running `sanoma` in a company repo activates dev mode in either of these cases.

- `node_modules/sanoma` or a package under `node_modules/@sanoma-ai/` links into a Sanoma checkout, as with `pnpm link`.
- `SANOMA_DEV_REPO` names the checkout.

[`sanoma dev link`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/dev/README.md) links `sanoma` and each declared `@sanoma-ai/*` package available in the checkout.

## Processes

| Process              | Behavior                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sanoma serve --dev` | Runs the company in a child process. It serves [local site edits](/sites/developing/) the same way as `sanoma`.                                   |
| `pnpm run watch`     | Runs in each linked package’s directory. For `sanoma`, the watch script runs `tsc -b --watch` for its parts and `vite build --watch` for the app. |

## Restarts

Sanoma watches the build directories each linked package ships, including `dist/`, `workflows/dist`, and `app/dist`. It skips `testing/dist` and `dev/dist` because a running company never loads them. When the dev server serves the app’s pages from the checkout for a repo with sites, those pages update in place. Changes under `app/dist/client` and `app/dist/server` then skip the restart.

After 750 milliseconds without another watched change, Sanoma restarts the child. Restarts run one at a time. If the child exits on its own, Sanoma reports the exit and waits for the next change to start it again.

## Shutdown

Ctrl+C stops the server and each package watcher. On Unix, each runs in its own process group. Sanoma sends each group `SIGTERM`, then `SIGKILL` if it is still running after five seconds. On Windows, Sanoma uses `taskkill /T /F` to stop each process tree.

If the repo started with linked packages, Sanoma checks their links in `node_modules` once a second. When all the original links are gone on two consecutive checks, it prints `dev mode: the repo no longer links <checkout>; stopping` and shuts down. This can happen after `sanoma dev unlink` or a package install. Shutdown prevents the checkout’s server from writing to the company repo’s `.sanoma/app` after it switches back to installed packages.
