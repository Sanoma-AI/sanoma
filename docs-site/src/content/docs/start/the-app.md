---
title: "Use your company’s app"
description: "Sign in, run workflows, review requests, and find the screen you need."
sidebar:
  order: 1
---

Open the app at your company’s address. If this is your first visit, [sign in to your company](/using-the-app/sign-in/).

| What do you need to do?                              | Where to start                                              |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Start a workflow or find out why a run stopped       | [Start and inspect a workflow run](/using-the-app/runs/)    |
| Decide a request waiting on you                      | [Review an approval](/using-the-app/approvals/)             |
| Add rows from a spreadsheet                          | [Import records from a CSV](/using-the-app/import-records/) |
| Check an agent’s edits before they reach the company | [Review a draft change](/using-the-app/changes/)            |
| Share a local company with teammates                 | [Put your company online](/using-the-app/go-live/)          |

The app opens on **Home**. Open **Inbox** for approvals or **Workflows** for a workflow’s graph, code, and runs. Each [company site](/sites/overview/#sites) has a tile. Setup includes **People**, **Hosting**, **Connectors**, and **Apps**. **Data** appears when the company has collections or sites. **Permissions** appears when the repo has policies in `policies/*.cedar`.

The badge at the foot of the sidebar shows the company’s state. Hover over it to see the database host. The app derives the badge from existing facts, so viewing it leaves an idle host asleep.

| Badge              | Meaning                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Local**          | The company runs on this computer.                                                                            |
| **Going live…**    | Deployment is in progress.                                                                                    |
| **Go live failed** | The last deployment run or its host step failed.                                                              |
| **Live**           | The host is bound, or you’re viewing the hosted instance. The local copy then shows **Live · drafting copy**. |

Older links still resolve. `/resources` opens `/hosting` with its `?resource=` selection. `/setup` and its subpages open the corresponding Hosting pages. `/runs` opens All runs and `/runs/<id>` opens the run under its workflow. `/start?workflow=<name>` opens New run for that workflow or reports an unknown workflow. `/start` alone opens `/workflows`.

## Screen directory

### Workflows and runs

- <a id="workflow-screens" href="/using-the-app/runs/#workflow-screens">Workflow screens</a>
- <a id="workflows" href="/using-the-app/runs/#workflows">Workflows</a>
- <a id="start-a-live-or-sandbox-run" href="/using-the-app/runs/#start-a-live-or-sandbox-run">Start a live or sandbox run</a>
- <a id="inspect-a-run" href="/using-the-app/runs/#inspect-a-run">Inspect a run</a>
- <a id="run-graph" href="/using-the-app/graphs/#run-graph">Run graph</a>
- <a id="outline" href="/using-the-app/graphs/#outline">Outline</a>

### Inbox, changes, and company setup

- <a id="inbox" href="/using-the-app/approvals/#inbox">Inbox</a>
- <a id="changes" href="/using-the-app/changes/#changes">Changes</a>
- <a id="home" href="/using-the-app/company-settings/#home">Home</a>
- <a id="people" href="/using-the-app/company-settings/#people">People</a>
- <a id="permissions" href="/using-the-app/company-settings/#permissions">Permissions</a>
- <a id="apps" href="/using-the-app/company-settings/#apps">Apps</a>
- <a id="hosting" href="/using-the-app/company-settings/#hosting">Hosting</a>
- <a id="resources-and-bindings" href="/using-the-app/company-settings/#resources-and-bindings">Resources and bindings</a>
- <a id="apply-adopt-and-edit" href="/using-the-app/company-settings/#apply-adopt-and-edit">Apply, adopt, and edit</a>
- <a id="check-for-drift" href="/using-the-app/company-settings/#check-for-drift">Check for drift</a>

### Collection screens

- <a id="data" href="/using-the-app/records/#data">Data</a>
- <a id="edit-a-collection" href="/using-the-app/records/#edit-a-collection">Edit a collection</a>
- <a id="paste-and-review-a-range" href="/using-the-app/records/#paste-and-review-a-range">Paste and review a range</a>
- <a id="column-width-and-sort-order" href="/using-the-app/records/#column-width-and-sort-order">Column width and sort order</a>
- <a id="change-a-column" href="/using-the-app/records/#change-a-column">Change a column</a>
- <a id="review-a-schema-change" href="/using-the-app/records/#review-a-schema-change">Review a schema change</a>
- <a id="edit-a-record-and-inspect-its-history" href="/using-the-app/records/#edit-a-record-and-inspect-its-history">Edit a record and inspect its history</a>
- <a id="import-records" href="/using-the-app/import-records/">Import records</a>

### Hosting and connections

- <a id="connectors" href="/using-the-app/connections/#connectors">Connectors</a>
- <a id="connection-management" href="/using-the-app/connections/#connection-management">Connection management</a>
- <a id="connection-methods-and-renewal" href="/using-the-app/connections/#connection-methods-and-renewal">Connection methods and renewal</a>
- <a id="secret-storage" href="/using-the-app/connections/#secret-storage">Secret storage</a>
- <a id="go-live" href="/using-the-app/go-live/#go-live">Go live</a>
- <a id="connect-the-github-app" href="/using-the-app/go-live/#connect-the-github-app">Connect the GitHub App</a>
- <a id="configure-staff-sign-in" href="/using-the-app/go-live/#configure-staff-sign-in">Configure staff sign-in</a>
- <a id="connect-vendor-accounts" href="/using-the-app/go-live/#connect-vendor-accounts">Connect vendor accounts</a>
- <a id="connect-a-wakeup-service" href="/using-the-app/go-live/#connect-a-wakeup-service">Connect a wakeup service</a>
- <a id="ready-to-go-live" href="/using-the-app/go-live/#ready-to-go-live">Ready to go live</a>
- <a id="connect-an-existing-repository-or-database" href="/using-the-app/go-live/#connect-an-existing-repository-or-database">Connect an existing repository or database</a>

### Chat and navigation

- <a id="navigation-and-chat" href="/using-the-app/chat/#navigation-and-chat">Navigation and chat</a>
- <a id="start-a-chat" href="/using-the-app/chat/#start-a-chat">Start a chat</a>
- <a id="review-draft-edits" href="/using-the-app/changes/#review-draft-edits">Review draft edits</a>
- <a id="workflow-calls-from-chat" href="/using-the-app/chat/#workflow-calls-from-chat">Workflow calls from chat</a>
- <a id="chat-history-and-engine-selection" href="/using-the-app/chat/#chat-history-and-engine-selection">Chat history and engine selection</a>
- <a id="coding-agent-sessions" href="/using-the-app/chat/#coding-agent-sessions">Coding-agent sessions</a>
- <a id="use-a-personal-agent-subscription" href="/using-the-app/chat/#use-a-personal-agent-subscription">Use a personal agent subscription</a>
- <a id="sign-in-to-an-agent" href="/using-the-app/chat/#sign-in-to-an-agent">Sign in to an agent</a>
- <a id="layout-on-smaller-screens" href="/using-the-app/chat/#layout-on-smaller-screens">Layout on smaller screens</a>
- <a id="display-preferences" href="/using-the-app/chat/#display-preferences">Display preferences</a>
