# @sanoma-ai/desktop

The Sanoma desktop shell, for people who will not open a terminal: it opens a company folder, runs that company's own `sanoma` launcher (the one in its `node_modules`), and shows the app in a window. Private: it is never published to npm.

It adds nothing to the product. The window shows the same app `sanoma` serves at `http://127.0.0.1:<port>`, and the app does not know it is inside the shell. There is no second UI, no runtime concept and no agent here.

## Run it from the checkout

```sh
pnpm install
pnpm --filter @sanoma-ai/desktop start                 # the start window
pnpm --filter @sanoma-ai/desktop start ~/Companies/acme  # or open a company at once
```

`start` downloads Electron's binary the first time (a plain `pnpm install` skips it: `allowBuilds` in `pnpm-workspace.yaml`), builds the shell, fills `stage/` (`scripts/stage.ts`: the pinned Node, `scripts/download-node.ts`, and a copy of the pnpm running the script), and opens it. A company to try it on: `pnpm dlx sanoma` in an empty folder, with Postgres answering at the URL in its `.env`.

`pnpm --filter @sanoma-ai/desktop run test:e2e` is the smoke test: it builds and stages as `start` does, then starts the shell with Playwright (no browsers to install) on a copy of `test/fixtures/company`, whose `pnpm install` links a fake launcher. The company's window must show the app on the Node the shell ships (inside the template's `engines`), and closing it must stop the launcher. CI runs it on Linux under xvfb for changes to this package (`.github/workflows/desktop.yml`); the root `pnpm test` runs the unit tests only.

`pnpm --filter @sanoma-ai/desktop dist:dir` builds the app, unpacked, into `release/` (`electron-builder.yml`). Packaging, releases and the update check come later (#286).

## What it does

- **Opens a company**: a folder with a `sanoma.config.ts`, from the start window (Open folder…, Recent), File → Open Company… or Open Recent, the command line, a second launch (which hands the folder to the running shell and focuses its window) or a folder dropped on the Dock icon. A folder iCloud syncs gets a warning, as does the Intel build on Apple silicon.
- **Installs and starts it**: `pnpm install --prefer-offline` in the folder (when that fails but `node_modules/sanoma` is there, it goes on with a warning), then the launcher `node_modules/sanoma`'s `bin` names, in a process group of its own, with `SANOMA_EVENTS=1` and `SANOMA_APP_PORT` set (which win over the company's `.env`), and `PATH` starting at the shims in `<userData>/bin`: `node` and `pnpm` run the Node and the pnpm the shell ships, whatever the computer has, then the system's `PATH` and Homebrew's.
- **Knows when it is ready** from the launcher's `ready` event, or, for a launcher without events (sanoma 0.6.0 and before), its `<app> at <url>; ctrl-c to stop` line or the first answer from `/healthz`.
- **Shows the app**: one window per company, with storage of its own (`persist:company-<hash of the folder>`), sandboxed, with no preload. Each company keeps its port across starts (`<userData>/companies.json`; a new free one when it is taken), so the page remembers who you are. Links to the app, its public sites (`<name>.localhost:<port>`) and GitHub (the GitHub App's setup returns to the app) stay in the shell; any other web link opens in the default browser.
- **Stops it**: closing the window, Company → Restart and Quit close the launcher's stdin and send SIGTERM to its group, then SIGKILL after 10 seconds; Quit waits for every company. A launcher that stops on its own is not restarted: the start window shows why (exit code 2 is a problem with the config), its last 200 log lines and Start again.
- **Logs**: each start's output, timestamped, in `~/Library/Logs/Sanoma/<company>.log`, the previous start's kept as `.1.log` (Company → Show Log, Help → Show Logs Folder). An event line's URLs lose their password first (the `database` event's carries the cluster's).
- **Starts a new company** (File → New Company…, or New company… in the start window): in an empty folder, chosen or made in the dialog (it starts where the last company is, else the home folder; a folder iCloud syncs gets a warning first), it runs the launcher's own init, `pnpm dlx sanoma`, with the shims and the environment of a run. Its output streams into the start window; it commits, installs, and then serves the company it started, whose window opens as an opened company's does. Until a launcher with embedded Postgres is on npm, that needs a Postgres at the URL in `.env` (or Docker); otherwise the start window shows the launcher's own error.
- **Clones a company** (File → Clone Company…, or Clone… in the start window): the start window asks for the repository's address, then a dialog for the folder to clone into; the system git clones it without ever prompting (`GIT_TERMINAL_PROMPT=0`, ssh in batch mode), so a public repository, or one the OS credential helper knows, works. A failed sign-in says so in one line (signing in with GitHub comes later, #286 D6). Then it opens.
- **Checks git first**: on macOS, `xcode-select -p`; without Apple's command line tools a dialog offers their installer and Check Again. Before New and Clone, a missing `user.name` or `user.email` is asked for once in the start window and set with `git config --global` (the launcher's init commits as them).
- **Gets updates** (Company → Get Updates): only when the company has an `origin`, is on `main` and has nothing of its own (no change in the tree, untracked files included, and no commit GitHub does not have); otherwise it refuses in one line and changes nothing. It fetches `origin`'s `main`, says when there is nothing new, else stops the company, fast-forwards `main` (`git merge --ff-only origin/main`, a `git pull --ff-only` without a second fetch) and starts it again, which installs its packages; the window stays.

Not yet: packaging and releases, the shell's own updates, GitHub sign-in, Windows, signing.

## Why it ships a Node

Electron's own Node (24.22 in Electron 45) serves a company, but `sanoma check` crashes in it: oxlint's JS plugins pass the source through memory outside V8's heap, which Electron's V8 sandbox refuses. So the shell carries the official Node 24 (`scripts/download-node.ts`, sha256-pinned) in its resources, runs the launcher with it, and points the `node` shim at it, for whatever the company runs.
