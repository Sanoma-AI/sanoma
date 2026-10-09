# packages/app/src/routes/workflows

The pages under `/workflows`: the list of the config's workflows and the page for one workflow.

## Contents

| Path                       | What it is                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`$name.tsx`](%24name.tsx) | `/workflows/:name`: one workflow, its graph beside its source, with a button to start it, and its scenarios to pick and Test (`?scenario=`) |
| [`index.tsx`](index.tsx)   | `/workflows`: every workflow in the config, with its graph and a button to start it                                                         |
| [`route.tsx`](route.tsx)   | Layout for `/workflows`, with no component: sets the "Workflows" breadcrumb and page title                                                  |
