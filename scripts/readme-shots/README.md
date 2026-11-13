# readme-shots

`pnpm readme:shots` refreshes the six README screenshots, then records the launch-desk intro in [`.github/assets/demo.gif`](../../.github/assets/demo.gif). `pnpm readme:shots --intro` records only the intro. Both use the running app and disposable companies, with no customer data or live service calls.

## The intro

The [storyboard](STORYBOARD.md) follows a request, a checked Git draft, code and permission review, and a marketing announcement approved before Ghost publishing and Resend email. [`intro.ts`](intro.ts) prepares the company and cleans it up; [`intro-capture.ts`](intro-capture.ts) captures the scenes; [`intro-server.ts`](intro-server.ts) runs the app and worker together.

The agent is mocked with [`@shadcn/helpers/ai-sdk`](https://ui.shadcn.com/docs/helpers/ai-sdk). [`intro-fixture.ts`](intro-fixture.ts) uses `createChat` to author each predefined tool request. A model adapter feeds those inputs through Sanoma's existing agent loop. The actual tools write and commit the files, run `sanoma check`, and produce the draft card; check results and tool outputs are not mocked. The helper pauses at unresolved tools, so each tool request is authored separately.

The Claude Code selector is shown as an available agent choice, then switched to the local demo model before sending. This is not a recording of Claude generating the app or of a signed-in subscription. Every frame labels the scripted AI, simulated Git host and simulated service calls. Build waits are condensed.

The change flow pushes to a disposable bare Git repository and uses the test Git host to open and squash-merge the change. Code review includes a separate, labelled rendering of the actual Git diff; the app's Changes page supplies the permission comparison and Publish approval. After publishing, the recorder restarts the app on the merged code and runs the new site. The capture asserts that pending and rejected announcements make no publish/send calls, and an approved announcement makes one of each. Ghost and Resend are backed by their in-memory fakes.

[`motion.ts`](motion.ts) uses Puppeteer’s `Page.record()` to capture continuous Chrome video at 1200 × 900. The request, announcement fields and approval note are typed character by character. The pointer follows actual mouse events, with a brief ring on clicks; the final scene scrolls into the ledger. Recording runs throughout each interaction. Cuts skip builds, the app restart and changes of role, with the build wait labelled as condensed.

The temporary MP4 clips are joined and converted to a 960 × 720, 15 fps looping GIF with ffmpeg. The recorder sizes Chrome's content area as well as its emulated viewport, checks each clip's dimensions, and verifies that the GIF preserves their combined duration. It reserves space below the chat composer for captions and replaces the README GIF only after the full capture and assertions succeed. Duration varies with the interactions; inspect the exported GIF rather than assuming a fixed cut length. No standalone video is published by this command.

Each invocation uses its own temporary company, Git remote, log and database. The database is `SANOMA_TEST_DATABASE_URL` with `_readme_intro_<random suffix>` appended; the draft's check runs in the person's box on this computer, on a Postgres of its own there. Chrome, the server, databases and temporary files are cleaned up on completion, failure or interruption. A failure keeps the server log and, when Chrome is available, a diagnostic screenshot beside the temporary directory.

## The screenshots

The existing [`shots.ts`](shots.ts) and [`capture.ts`](capture.ts) fixture captures `workflow.png`, `runs.png`, `inbox.png`, `run.png`, `site.png` and `data.png` at 2x. It reads the announce workflow from the root README's code block and the site page from the [app README](../../packages/sanoma/app/README.md), starts a disposable company, and runs the scheduled Ghost announcement through its approval. It then seeds two pending approvals and six outbound leads for the stills.

This older fixture uses a fake Ghost service behind the live connector, so its form still displays “Live vendors.” It remains the stable fixture for visual CI; its workflow-only animation no longer overwrites the intro GIF. Stills are copied into `.github/assets` after all six are captured. The stills phase and intro phase publish their assets independently.

## On a pull request

[`.github/workflows/visual.yml`](../../.github/workflows/visual.yml) runs on each pull request that touches what the app shows (`packages/sanoma/app`, the runtime, the launcher, the Ghost connector, the README, this folder) and comments with what its change looks like. In one job, so both render alike, it runs `shots.ts --out <dir>` on the pull request's merge base and on its head, then [`compare.ts`](compare.ts) on the two folders. For each still whose pixels changed, the comment shows its before, its after and a diff: the after faded to grey, every changed pixel red. The images go to the pull request's own branch `visual/pr-<n>`, made afresh on each run; the comment is updated in place. Nothing fails on a change, and no baseline lives in the repo.

`--out <dir>` writes the six stills to `<dir>` and leaves `.github/assets` alone; it makes no GIF and needs no ffmpeg. Before each still it rewrites in the page what a second run of the same code shows otherwise (run ids, "5s ago", step timings, dates and times) to fixed text of the same shape, so two runs of one commit match pixel for pixel. To see a change locally:

```sh
node scripts/readme-shots/shots.ts --out /tmp/before   # on main
node scripts/readme-shots/shots.ts --out /tmp/after    # on your branch
node scripts/readme-shots/compare.ts /tmp/before /tmp/after /tmp/diff ""
```

## Needs

- Postgres on 5433: `pnpm db:up`.
- Google Chrome, found where its installer puts it; or `CHROME_PATH` naming a Chrome or Chromium binary. The intro requires Chrome’s `Page.startScreenRecording` API (tested with Chrome 156). The demo types its launch time as US English lays out a date (month/day/year): Chrome is started with `--lang=en-US`, but on macOS it follows the system's language, and the run stops if the field reads the date otherwise.
- `ffmpeg` and `ffprobe` on `PATH`, except with `--out`. The intro uses a local Git repository and needs Git 2.38 or later for the simulated host’s real squash merge.

The stills database is named as a test's is: `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_readme_shots` appended. Set that per worktree, as for the tests, so two runs at once never share one.
