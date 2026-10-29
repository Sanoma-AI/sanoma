# readme-shots

`pnpm readme:shots` retakes the README's pictures in [`.github/assets/`](../../.github/assets/) from the running app: `demo.gif` (1200×800, about 24 s) and seven stills at 2x, `workflow.png`, `runs.png`, `inbox.png`, `run.png`, `site.png`, `board.png` and `data.png`. Run it after a change to the app's look, then look at what changed before committing it.

## What one run does

1. Builds what the preview loads from `dist/` (`workflows`, `connector-resend`, `testing`, `app`, `sanoma`) when a package's `dist/` is older than its `src/`.
2. Writes a company repo named `acme` to a temporary directory: a dog walker's. [`company/`](company/) copied in whole (the `clients` collection in `resources/data.ts`, and the Clients board, `sites/clients`, its clients by where their invoice is), `workflows/invoice.ts` read from the README's "What a workflow looks like" block, a config that answers Resend with its in-memory fake behind the live connector, so the form still shows Live vendors, and a second site, `sites/billing`, its page read from the [packages/app README](../../packages/app/README.md)'s `sites/billing/routes/index.tsx` block (the kit's `PageHeader`, `Region` and `Facts`, and invoice's `RunForm` from `sanoma/site`).
3. Runs `sanoma serve` there on its own database and a free port, its output in a log file beside that directory. It saves six clients as dana through the runtime's client (`SanomaClient`), as the app saves a record. In Chrome, it records the GIF's storyboard (dana presses Send invoice on Ada Park's card on the board, the owner approves the invoice in the Inbox, the run sends it and waits a week to chase it, and the board shows it sent). It starts two more runs as dana through the client, as the app does, and once they wait on the owner, takes the stills as the owner, the chat column folded but in `inbox.png` (`runs.png` is invoice's Runs tab with the demo's run open, `site.png` the billing site's page, `board.png` the Clients board, `data.png` the clients grid sorted by invoice with a client open in its form).
4. Makes the GIF with ffmpeg and, once all eight are made, copies them into `.github/assets/` under temporary names and renames each into place: a failed run leaves the ones there as they were.
5. Closes Chrome, stops the server, drops the database and removes the temporary directory and the log, also when a step fails or on Ctrl-C (which exits 130). A failure keeps the log and prints its path, with its last 40 lines when the app did not start or a run did not move on.

It takes about a minute ([`capture.ts`](capture.ts) has the storyboard; [`shots.ts`](shots.ts) the rest).

## On a pull request

[`.github/workflows/visual.yml`](../../.github/workflows/visual.yml) runs on each pull request that touches what the app shows (`packages/app`, the runtime, the launcher, the Ghost connector, the README, this folder) and comments with what its change looks like. In one job, so both render alike, it runs `shots.ts --out <dir>` on the pull request's merge base and on its head, then [`compare.ts`](compare.ts) on the two folders. For each still whose pixels changed, the comment shows its before, its after and a diff: the after faded to grey, every changed pixel red. The images go to the pull request's own branch `visual/pr-<n>`, made afresh on each run; the comment is updated in place. Nothing fails on a change, and no baseline lives in the repo.

`--out <dir>` writes the seven stills to `<dir>` and leaves `.github/assets` alone; it makes no GIF and needs no ffmpeg. Before each still it rewrites in the page what a second run of the same code shows otherwise (run ids, "5s ago", step timings, dates and times) to fixed text of the same shape, so two runs of one commit match pixel for pixel. To see a change locally:

```sh
node scripts/readme-shots/shots.ts --out /tmp/before   # on main
node scripts/readme-shots/shots.ts --out /tmp/after    # on your branch
node scripts/readme-shots/compare.ts /tmp/before /tmp/after /tmp/diff ""
```

## Needs

- Postgres on 5433: `pnpm db:up`.
- Google Chrome, found where its installer puts it; or `CHROME_PATH` naming a Chrome or Chromium binary. The demo types its launch time as US English lays out a date (month/day/year): Chrome is started with `--lang=en-US`, but on macOS it follows the system's language, and the run stops if the field reads the date otherwise.
- `ffmpeg` on `PATH`, except with `--out`.

The database it creates and drops is named as a test's is: `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_readme_shots` appended. Set that per worktree, as for the tests, so two runs at once never share one.
