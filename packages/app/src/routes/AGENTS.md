# packages/app/src/routes

The TanStack Router file routes of the app. Each file is served at the URL its path implies; `/api` holds the JSON API and the rest are pages.

## Contents

| Path                                  | What it is                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`api/`](api/AGENTS.md)               | The JSON API under `/api`                                                                   |
| [`connectors/`](connectors/AGENTS.md) | Pages under `/connectors`: the connector list and one connector                             |
| [`runs/`](runs/AGENTS.md)             | Pages under `/runs`: the run list and one run                                               |
| [`workflows/`](workflows/AGENTS.md)   | Pages under `/workflows`: the workflow list and one workflow                                |
| [`__root.tsx`](__root.tsx)            | Root route: the HTML shell, navigation, breadcrumbs and actor name prompt around every page |
| [`api.ts`](api.ts)                    | Layout for `/api`: middleware that answers any failure as JSON                              |
| [`inbox.tsx`](inbox.tsx)              | `/inbox`: every pending approval, newest first                                              |
| [`index.tsx`](index.tsx)              | `/`: redirects to `/runs`                                                                   |
| [`resources.tsx`](resources.tsx)      | `/resources`: the declared resources, their drift and data-file problems, and Run drift     |
| [`start.tsx`](start.tsx)              | `/start`: choose a workflow and fill its input to start a run                               |
