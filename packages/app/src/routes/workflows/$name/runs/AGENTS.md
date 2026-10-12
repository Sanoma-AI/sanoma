# packages/app/src/routes/workflows/$name/runs

The runs of one workflow, each a pane of its workflow's page.

## Contents

| Path                   | What it is                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`$id.tsx`](%24id.tsx) | `/workflows/:name/runs/:id`: one run with its status, checks, graph, ledger and approvals; a run of another workflow redirects to its own (in `beforeLoad`, before the layout loads) |
