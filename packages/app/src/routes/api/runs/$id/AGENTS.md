# packages/app/src/routes/api/runs/$id

The JSON API routes for a single run, mounted under `/api/runs/:id`.

## Contents

| Path                                | What it is                                                     |
| ----------------------------------- | -------------------------------------------------------------- |
| [`approvals/`](approvals/AGENTS.md) | `POST /api/runs/:id/approvals/:approvalId` decides an approval |
| [`index.ts`](index.ts)              | `GET /api/runs/:id`: one run with its ledger and approvals     |
