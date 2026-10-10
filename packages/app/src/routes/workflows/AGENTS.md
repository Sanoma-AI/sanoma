# packages/app/src/routes/workflows

The pages under `/workflows`: the home, a card per workflow of the config or every run as a table, and the page for one workflow, with its runs.

## Contents

| Path                          | What it is                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$name/`](%24name/AGENTS.md) | `/workflows/:name`: one workflow's page: its header, the rail of its runs, and its About, New run and run panes                                                      |
| [`index.tsx`](index.tsx)      | `/workflows`: a card per workflow (its vendors, run strip, waiting approvals, Test, Run and outline), or `?view=runs`: every run as a table, `?status=` filtering it |
| [`route.tsx`](route.tsx)      | Layout for `/workflows`, with no component: sets the "Workflows" breadcrumb and page title                                                                           |
