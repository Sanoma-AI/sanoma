# packages/app/src/routes/api

The JSON API routes, mounted under `/api`. They sit beside the pages and call the same server core, and `../api.ts` wraps them so every failure answers as JSON.

## Contents

| Path                           | What it is                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| [`runs/`](runs/AGENTS.md)      | Routes under `/api/runs`: list, start, detail and approval decisions                |
| [`$.ts`](%24.ts)               | Any other `/api` path, by any method: a JSON 404 instead of the page                |
| [`config.ts`](config.ts)       | `GET /api/config`: the config description without workflow sources                  |
| [`scenarios.ts`](scenarios.ts) | `GET /api/scenarios`: the scenarios in the config's feature files, with their steps |
