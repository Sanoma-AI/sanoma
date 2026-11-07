# packages/app/src/routes/workflows/$name/runs

The runs of one workflow, each its own page under the workflow's.

## Contents

| Path                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$id.tsx`](%24id.tsx) | `/workflows/:name/runs/:id`: one run: its header (crumbs Workflows / the workflow / Run and its id's start, its status pill, who started it and when, New run, or a change's Review), then the run's `WorkflowView` (its banner, the graph with the run's facts and approvals floating over it, Ledger with a sandbox run's checks, and Code); a run of another workflow redirects to its own (in `beforeLoad`, before the layout loads) |
