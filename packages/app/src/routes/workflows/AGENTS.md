# packages/app/src/routes/workflows

The pages under `/workflows`: the overview, a table of the config's workflows or every run, and the page for one workflow, whose runs the sidebar's panel lists.

## Contents

| Path                          | What it is                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$name/`](%24name/AGENTS.md) | `/workflows/:name`: one workflow's page: its header with New run, and its Workflow and run panes, each a `WorkflowView`                                                                                                                                                         |
| [`index.tsx`](index.tsx)      | `/workflows`: a row per workflow (how it starts, its vendors, its last run, what waits), `?filter=` picking them (waiting, failed last run, built-in), All runs and New workflow in its header; or `?view=runs`: every run as a table, `?status=` and `?workflow=` filtering it |
| [`route.tsx`](route.tsx)      | Layout for `/workflows`, with no component: sets the "Workflows" breadcrumb and page title                                                                                                                                                                                      |
