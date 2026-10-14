# readme-shots

`pnpm readme:shots` retakes the README's pictures in [`.github/assets/`](../../.github/assets/) from the running app: `demo.gif` (1200×800, about 27 s) and three stills at 2x, `workflow.png`, `inbox.png` and `run.png`. Run it after a change to the app's look, then look at what changed before committing it.

## What one run does

1. Builds what the preview loads from `dist/` (`workflows`, `connector-ghost`, `testing`, `app`, `sanoma`) when a package's `dist/` is older than its `src/`.
2. Writes a company repo named `acme` to a temporary directory: `workflows/announce.ts` read from the README's "What a workflow looks like" block, and a config that answers Ghost with its in-memory fake behind the live connector, so the form still shows Live vendors.
3. Runs `sanoma serve` there on its own database and a free port, then in Chrome: records the GIF's storyboard (dana starts a run with a launch time about a minute away, marketing-lead approves it in the Inbox, the run sleeps and finishes), seeds two more runs waiting on marketing-lead, and takes the stills.
4. Makes the GIF with ffmpeg and writes all four to `.github/assets/`.
5. Stops the server, drops the database and removes the temporary directory, also when a step fails.

It takes about a minute and a half, most of it the run's sleep until its launch minute ([`capture.ts`](capture.ts) has the storyboard; [`shots.ts`](shots.ts) the rest).

## Needs

- Postgres on 5433: `pnpm db:up`.
- Google Chrome, or Chromium: `CHROME_PATH` names its binary (default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
- `ffmpeg` on `PATH`.

`SANOMA_PREVIEW_DATABASE_URL` names the database it creates and drops (default `postgresql://postgres:dbos@localhost:5433/sanoma_preview_readme_shots`): never point it at one you keep.
