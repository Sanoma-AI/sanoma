# readme-shots

`pnpm readme:shots` retakes the README's pictures in [`.github/assets/`](../../.github/assets/) from the running app: `demo.gif` (1200×800, about 27 s) and three stills at 2x, `workflow.png`, `inbox.png` and `run.png`. Run it after a change to the app's look, then look at what changed before committing it.

## What one run does

1. Builds what the preview loads from `dist/` (`workflows`, `connector-ghost`, `testing`, `app`, `sanoma`) when a package's `dist/` is older than its `src/`.
2. Writes a company repo named `acme` to a temporary directory: `workflows/announce.ts` read from the README's "What a workflow looks like" block, and a config that answers Ghost with its in-memory fake behind the live connector, so the form still shows Live vendors.
3. Runs `sanoma serve` there on its own database and a free port, its output in a log file beside that directory. In Chrome, it records the GIF's storyboard (dana starts a run with a launch time about a minute away, marketing-lead approves it in the Inbox, the run sleeps and finishes). It starts two more runs as dana through the runtime's client (`SanomaClient`), as the app does, and once they wait on marketing-lead, takes the stills.
4. Makes the GIF with ffmpeg and, once all four are made, copies them into `.github/assets/` under temporary names and renames each into place: a failed run leaves the ones there as they were.
5. Closes Chrome, stops the server, drops the database and removes the temporary directory and the log, also when a step fails or on Ctrl-C (which exits 130). A failure keeps the log and prints its path, with its last 40 lines when the app did not start or a run did not move on.

It takes one and a half to two minutes, most of it the run's sleep until its launch minute (30 to 90 s away) ([`capture.ts`](capture.ts) has the storyboard; [`shots.ts`](shots.ts) the rest).

## Needs

- Postgres on 5433: `pnpm db:up`.
- Google Chrome, found where its installer puts it; or `CHROME_PATH` naming a Chrome or Chromium binary. The demo types its launch time as US English lays out a date (month/day/year): Chrome is started with `--lang=en-US`, but on macOS it follows the system's language, and the run stops if the field reads the date otherwise.
- `ffmpeg` on `PATH`.

The database it creates and drops is named as a test's is: `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_readme_shots` appended. Set that per worktree, as for the tests, so two runs at once never share one.
