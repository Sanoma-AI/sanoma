# Marketing example

One workflow, [`announce`](workflows/announce.ts): draft a blog post and a newsletter, wait for the marketing lead to approve, sleep until the launch time, then publish the post, send the newsletter and post to Bluesky.

The vendors are fakes for now, and their state is written to `.sanoma/fake-vendors.json`. Real Ghost, Resend and Bluesky drivers come next.

## Run it

From the repo root, run `pnpm install` and `pnpm db:up` (Postgres in Docker on port 5433). Then, in this folder:

```sh
pnpm sanoma worker                      # leave running
pnpm sanoma run announce --set title="Acme Pro is here" --set body="<p>Hello</p>" --set launchAt=+2m
pnpm sanoma runs                        # the run waits for marketing-lead
pnpm sanoma approve <run-id> --as marketing-lead
pnpm sanoma show <run-id>               # each step and what the vendor returned
```

Stop the worker during the sleep (even with `kill -9`) and start it again: the run picks up where it left off, and nothing is published twice.
