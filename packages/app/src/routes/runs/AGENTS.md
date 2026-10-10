# packages/app/src/routes/runs

The pages under `/runs`: the list of runs and the page for one run.

## Contents

| Path                     | What it is                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`$id.tsx`](%24id.tsx)   | `/runs/:id`: one run with its status, ledger, approvals and workflow graph, and a sandbox run's badge and checks |
| [`index.tsx`](index.tsx) | `/runs`: a table of recent runs, sandbox runs badged, with a button to start one                                 |
| [`route.tsx`](route.tsx) | Layout for `/runs`, with no component: sets the "Runs" breadcrumb and page title                                 |
