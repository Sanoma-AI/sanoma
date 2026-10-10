# packages/app/src/components

The app's React components: page chrome, shared display pieces, and the graph and source panels. They compose the shadcn components in `ui/` and are used by the routes.

## Contents

| Path                                 | What it is                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| [`ui/`](ui/AGENTS.md)                | shadcn/ui base components                                                                                                 |
| [`app-sidebar.tsx`](app-sidebar.tsx) | Sidebar nav with page links and the pending-approval count                                                                |
| [`approval.tsx`](approval.tsx)       | Approval card and the approve or reject dialog                                                                            |
| [`boundaries.tsx`](boundaries.tsx)   | Router error, not-found and pending views                                                                                 |
| [`code.tsx`](code.tsx)               | Read-only CodeMirror view of a workflow's source with line highlights; browser only                                       |
| [`common.tsx`](common.tsx)           | Shared pieces: badges (the sandbox badge too), tones, page headers, facts, op items, JSON views, lazy graph & code panels |
| [`graph.tsx`](graph.tsx)             | React Flow drawing of a laid-out graph; loaded lazily                                                                     |
| [`scenario.tsx`](scenario.tsx)       | The Test control (Test and the menu choosing a scenario), a scenario's card, and why a feature file could not be read     |
| [`nav-user.tsx`](nav-user.tsx)       | Sidebar footer menu for who you are and the theme                                                                         |
| [`who-are-you.tsx`](who-are-you.tsx) | Dialog asking for a name under the default actor resolver                                                                 |
| [`workflow.tsx`](workflow.tsx)       | A workflow's sections and its graph beside its source                                                                     |
| [`zoom-slider.tsx`](zoom-slider.tsx) | Zoom controls for the React Flow graph                                                                                    |
