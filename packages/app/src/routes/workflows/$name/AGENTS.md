# packages/app/src/routes/workflows/$name

One workflow's page: a layout with its header and the rail of its runs, around the pane the URL picks.

## Contents

| Path                      | What it is                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`runs/`](runs/AGENTS.md) | `/workflows/:name/runs/:id`: one run of the workflow                                                                                                 |
| [`index.tsx`](index.tsx)  | `/workflows/:name`: About: the graph beside the source, the Test control over its scenarios (`?scenario=`), and what it may call                     |
| [`new.tsx`](new.tsx)      | `/workflows/:name/new`: New run: the start form for the workflow's input                                                                             |
| [`route.tsx`](route.tsx)  | Layout for `/workflows/:name`: loads the workflow, its source, scenarios and runs; the header with Run, and the runs rail (`?runs=`) beside the pane |
