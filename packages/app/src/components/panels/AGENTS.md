# packages/app/src/components/panels

The panels of the sidebar ([`app-sidebar.tsx`](../app-sidebar.tsx)): each lists a section beside the section bar, docked, peeking over the page while the sidebar is folded, or in the phone's sheet. Each is a fragment of `SidebarHeader`, `SidebarContent` and `SidebarFooter`, and reads its own queries, so a poll draws the panel again and not the page.

## Contents

| Path                                         | What it is                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`panel.tsx`](panel.tsx)                     | `usePanel` (the panel of the route's `staticData.section`), the header every panel shares (with its Collapse or Pin button), a row (`PanelRow`), the foot's link, the empty text, and `ACTIVE` |
| [`workflows-panel.tsx`](workflows-panel.tsx) | The Workflows section: New workflow, Find a workflow, those waiting on you with their counts, the rest by their last run, and See all                                                          |
| [`workflow-panel.tsx`](workflow-panel.tsx)   | Inside a workflow: ← Workflows, its Workflow pane, its runs filtered by `?runs=` (the open one marked), and All runs                                                                           |
| [`inbox-panel.tsx`](inbox-panel.tsx)         | The Inbox: For you or Everyone (`?show=`), their approvals (the open one marked), Decided today, and All decided, read with `lib/inbox.ts` as the Inbox page is                                |
| [`data-panel.tsx`](data-panel.tsx)           | The Data section: each collection by its title (the open one marked), and all of them at its foot                                                                                              |
| [`sites-panel.tsx`](sites-panel.tsx)         | The Sites: each of the company's sites under its title (and icon) with its pages (`useSites`), the open one marked                                                                             |

## Maintenance

- A panel's links need no handler: a link followed in the sheet or the peek closes it, from one click handler on each (`app-sidebar.tsx`).
- A route names its section in `staticData.section`, and a site's page is under Sites; Resources and Connectors have no panel. Sites and Data show in the bar only when there are sites or collections. A section's panel peeks from the bar on a wider screen whenever no panel is docked: the sidebar folded, or a page with no panel.
