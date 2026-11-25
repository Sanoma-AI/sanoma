---
title: "Workflow screens"
description: "Look up workflow tabs, URL parameters, run filters, and refresh behavior."
sidebar:
  order: 13
---

| View | App URL | What it shows |
| --- | --- | --- |
| Graph | `/workflows/<name>` | The [workflow outline](/using-the-app/graphs/#outline). `?scenario=<name>` marks operations seeded, faulted, or expected by that scenario. |
| Runs | `?view=runs` | The latest 50 runs of the workflow. `?runs=` filters them. Live and sandbox filters look within those 50. Waiting and failed each fetch the latest 50 with that status, however old. |
| Code | `?view=code` | The workflow source. Selecting a node highlights its lines, and selecting a line locates the node in the graph. |
| Scenarios | `?view=scenarios` | Each scenario’s file and step count. Select a scenario to read it, start a sandbox run, or show its expectations on the graph. |
| Run details | `/workflows/<name>/runs/<id>` | Status, starter, time, approvals, graph, ledger, and source. The list shows the first eight characters of the run ID. Hover for the full ID. |
| New run | `?new` | The live form, or a read-only sandbox form when `?scenario=<name>` is present. The older `/workflows/<name>/new` route redirects here. |

A selected run in the list has `?run=<id>`. Its card shows the input, a brief ledger trace, and any waiting request or error. Run lists refresh every two seconds while a displayed run can change, every 30 seconds otherwise, and immediately after a start or decision. The scenario list refreshes every five seconds and when the window regains focus.

The live form uses the workflow’s input schema. It accepts text, local dates and times, numbers, booleans, choices, lists, and objects one level deep. Other structures use JSON. An empty optional field is omitted. The server validates submitted values.

The inspector follows the selection between Graph and Code. A run’s selected node includes the matching ledger records and any pending approval. Closing the card clears the selection. Use **About this workflow** or **Show the run** to reopen the overview. A retired workflow keeps its run history while runs exist and has no **New run** control.
