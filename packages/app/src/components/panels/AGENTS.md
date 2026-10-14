# packages/app/src/components/panels

The panels of the sidebar ([`app-sidebar.tsx`](../app-sidebar.tsx)): each lists a section beside the section bar, docked, peeking over the page while the sidebar is folded, or in the phone's sheet. Each is a fragment of `SidebarHeader`, `SidebarContent` and `SidebarFooter`, and reads its own queries, so a poll draws the panel again and not the page.

## Contents

| Path                                         | What it is                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`panel.tsx`](panel.tsx)                     | `usePanel` (the panel the URL picks), where a panel shows and how its links close the peek or sheet (`usePanelPlace`), and the header every panel shares, with its Collapse or Pin button |
| [`workflows-panel.tsx`](workflows-panel.tsx) | The Workflows section: New workflow, Find a workflow, those waiting on an approval with their counts, the rest by their last run, and See all                                             |
| [`workflow-panel.tsx`](workflow-panel.tsx)   | Inside a workflow: ← Workflows, its Workflow pane, its runs filtered by `?runs=` (the open one marked), and All runs                                                                      |
| [`inbox-panel.tsx`](inbox-panel.tsx)         | The Inbox: For you or Everyone (`?show=`), their approvals (the open one marked), Decided today, and All decided; `useInbox` and `useDecided`, which the Inbox page opens one from        |

## Maintenance

- A link in a panel calls `usePanelPlace().close` as it is followed.
- A section's panel peeks only from the bar, while the sidebar is folded on a wider screen; Resources and Connectors have none.
