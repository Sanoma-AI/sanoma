# packages/app/src/routes/api/runs

The JSON API routes for runs, mounted under `/api/runs`.

## Contents

| Path                      | What it is                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`$id/`](%24id/AGENTS.md) | Routes for one run: its detail and its approvals                                                          |
| [`index.ts`](index.ts)    | `GET /api/runs` lists recent runs; `POST /api/runs` starts one (or a scenario's sandbox run) as the actor |
