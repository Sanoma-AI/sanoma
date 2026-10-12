# packages/app/src/components

The app's React components: page chrome, shared display pieces, and the graph and source panels. They compose the shadcn components in `ui/` and are used by the routes.

## Contents

| Path                                 | What it is                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ui/`](ui/AGENTS.md)                | shadcn/ui base components                                                                                                                                                                           |
| [`app-sidebar.tsx`](app-sidebar.tsx) | Sidebar nav: page links, `WorkflowLinks` under Workflows, and pending-approval counts (Inbox's and each workflow's)                                                                                 |
| [`approval.tsx`](approval.tsx)       | Approval card and the approve or reject dialog                                                                                                                                                      |
| [`boundaries.tsx`](boundaries.tsx)   | Router error, not-found and pending views                                                                                                                                                           |
| [`code.tsx`](code.tsx)               | Read-only CodeMirror view of a workflow's source with line highlights; browser only                                                                                                                 |
| [`credentials.tsx`](credentials.tsx) | A connector's Credentials section: each variable's status, and Set, Replace and Clear with their form                                                                                               |
| [`common.tsx`](common.tsx)           | Shared pieces: badges (the sandbox badge too), tones, page headers, facts, op items, JSON views, a segmented control of links, lazy graph & code panels (`fill` fills a resizable panel)            |
| [`graph.tsx`](graph.tsx)             | React Flow drawing of a laid-out graph; loaded lazily                                                                                                                                               |
| [`ledger.tsx`](ledger.tsx)           | A run's ledger rows and check rows, and `show`, which scrolls to a graph node's ledger row                                                                                                          |
| [`nav-user.tsx`](nav-user.tsx)       | Sidebar footer menu for who you are and the theme                                                                                                                                                   |
| [`run-rail.tsx`](run-rail.tsx)       | The workflow page's rail: its Workflow pane, and the workflow's latest runs, filtered by `?runs=`                                                                                                   |
| [`run-strip.tsx`](run-strip.tsx)     | A Workflows card's strip: the workflow's last 12 runs as squares in their status's colour, read in the browser                                                                                      |
| [`runs-table.tsx`](runs-table.tsx)   | Every workflow's runs as a table, each row opening its run: the Workflows page's All runs                                                                                                           |
| [`scenario.tsx`](scenario.tsx)       | Why a feature file could not be read                                                                                                                                                                |
| [`who-are-you.tsx`](who-are-you.tsx) | Dialog asking for a name under the default actor resolver                                                                                                                                           |
| [`workflow.tsx`](workflow.tsx)       | A workflow's sections, its `RunButton`, the notice for a retired one, and its graph (marked with a scenario's steps, when given) above its source in one card, with a drag handle and a Code toggle |
| [`workbench.tsx`](workbench.tsx)     | `Workbench`: the one layout of a workflow page's panes: the graph card, then two columns (3 : 2) by the pane's own width                                                                            |
| [`zoom-slider.tsx`](zoom-slider.tsx) | Zoom controls for the React Flow graph                                                                                                                                                              |

## Layout conventions

- Spacing scale: `gap-6` between a page's regions, `gap-4` inside a card, `gap-3` inside a section, `gap-2` inside an item.
- Every pane of a workflow's page is a [`Workbench`](workbench.tsx): the graph card across the top, then the primary and secondary columns (3 : 2), one column while the pane itself is narrower than `@3xl`.
