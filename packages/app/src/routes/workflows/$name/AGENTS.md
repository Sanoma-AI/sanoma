# packages/app/src/routes/workflows/$name

One workflow's page: a layout with its header and the rail of its runs, around the pane the URL picks. A retired workflow, one the config no longer has, keeps its page while it has runs; its Workflow pane says it is gone. Each pane is a `WorkflowView` (see [components](../../../components/AGENTS.md#layout-conventions)); the layout's search (`?runs=`, `?new`, `?scenario=`) holds on either.

## Contents

| Path                      | What it is                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`runs/`](runs/AGENTS.md) | `/workflows/:name/runs/:id`: one run of the workflow                                                                                                              |
| [`index.tsx`](index.tsx)  | `/workflows/:name`: the Workflow pane: the outline (marked with `?scenario=`'s scenario), About or New run in the inspector, the source under Code                |
| [`new.tsx`](new.tsx)      | `/workflows/:name/new`: redirects the old New run URL to `/workflows/:name?new` with its search as it is (`?scenario=` and `?runs=`)                              |
| [`route.tsx`](route.tsx)  | Layout for `/workflows/:name`: loads the workflow, its source, scenarios and rail; the header with New run (`?new`), and the runs rail (`?runs=`) beside the pane |
