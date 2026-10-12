# packages/app/src/routes/workflows

The pages under `/workflows`: the list of the config's workflows and the page for one workflow, with its runs.

## Contents

| Path                          | What it is                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`$name/`](%24name/AGENTS.md) | `/workflows/:name`: one workflow's page: its header, the rail of its runs, and its About, New run and run panes |
| [`index.tsx`](index.tsx)      | `/workflows`: every workflow in the config, with its graph and a Run button opening its New run pane            |
| [`route.tsx`](route.tsx)      | Layout for `/workflows`, with no component: sets the "Workflows" breadcrumb and page title                      |
