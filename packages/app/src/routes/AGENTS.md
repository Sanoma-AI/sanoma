# packages/app/src/routes

The TanStack Router file routes of the app: its pages. Each file is served at the URL its path implies; any other path gets the not-found page.

## Contents

| Path                                  | What it is                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`connectors/`](connectors/AGENTS.md) | Pages under `/connectors`: the connector list and one connector                                                                               |
| [`runs/`](runs/AGENTS.md)             | Redirects from the old `/runs` URLs to their pages under `/workflows`: All runs, or the run                                                   |
| [`workflows/`](workflows/AGENTS.md)   | Pages under `/workflows`: the home (a card per workflow, or every run) and one workflow's page                                                |
| [`__root.tsx`](__root.tsx)            | Root route: the HTML shell, navigation, breadcrumbs, density, name prompt, and the page column (a page's regions, `gap-(--gap-region)` apart) |
| [`inbox.tsx`](inbox.tsx)              | `/inbox`: approvals for you, all waiting or decided (`?show=`), listed beside the one open (`?approval=`)                                     |
| [`index.tsx`](index.tsx)              | `/`: redirects to `/workflows`, a card per workflow                                                                                           |
| [`resources.tsx`](resources.tsx)      | `/resources`: the declared resources, their drift and data-file problems, and Run drift                                                       |
| [`start.tsx`](start.tsx)              | `/start`: redirects old links to a workflow's page (`?workflow=`) or `/workflows`                                                             |
