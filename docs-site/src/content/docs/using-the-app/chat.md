---
title: "Use chat in the app"
description: "Open a chat, call a workflow, or choose a coding agent."
sidebar:
  order: 9
---

Open **Chat** in the sidebar. Ask the agent to run a workflow or draft a change to the repository. Workflow calls use the company’s merged code. To put a draft into use, [review and save it](/using-the-app/changes/).

## Navigation and chat

Select **Chat** again to close the chat column. The app remembers your choice. The menu under your initials contains your agent and display settings.

### Start a chat

1. Choose **New chat** at the top of the chat column. If you see **Connect your agent**, choose an account. **Your Claude plan** starts Claude Code sign-in. On your computer, **Your ChatGPT plan** connects Codex. **An API key** opens the Anthropic connector.
2. For Copilot, OpenCode, or Pi, choose **More agents**. You can reopen these choices later from **Agent…** under your initials.
3. Type your request or select a suggested question. The agent can see which page you’re on. Its reply lists the steps it took.

Your first **Getting started** chat suggests questions based on your company’s workflows, connectors, and people.

### Workflow calls from chat

Chat can look up company information, start a workflow, inspect a run, or wait for its result. The company’s policy checks both the chat agent (`sanoma-chat`) and you. The stricter decision applies. The ledger and Inbox identify the actor as, for example, `sanoma-chat for ada`.

If a call needs approval, the reply shows the request or a link to the Inbox. You can decide a request from your chat if you qualify as its approver. The Sanoma engine waits up to ten minutes for a decision. Pi and Claude Code wait up to fifteen seconds. If that time expires, the reply identifies the pending run and its approver. You can stop the wait.

If a run starts and then fails, the reply gives the run ID and the error. A restart can use that ID to find the run again. For details, see [who can approve a run](/workflows/approvals/#who-approves) and the [MCP tools](/start/agents-over-mcp/#available-tools).

Only the app’s worker can act as `sanoma-chat` on your behalf. If a workflow requires a connection owned by you, the call is refused because the agent is the actor. By default, a chat request to start a built-in workflow that changes company state waits for admin approval.

### Chat history and engine selection

Open the menu at the top of the chat to return to an earlier conversation. The company database keeps the chat and its draft through a restart. Choose **Continue** to resume an interrupted turn.

Choose an engine in the composer when you start a chat. That chat keeps the engine and account you chose. The app remembers your choice for new chats.

- **Sanoma** uses the default model from the first connector that provides one. If its key is missing, the reply links to the connector.
- **Pi** and **Claude Code** can use the company’s Anthropic key. They work on a copy of the draft in your coding sandbox, called a box.
- **Your own plan** uses your personal subscription. Available agents depend on the installed connectors and where the company runs.

### Coding-agent sessions

A hosted company needs a [sandbox](/hosting/hosts/#sandboxes) to offer coding agents. Each person has a box that persists across restarts. On a local machine, Sanoma can use a directory under `.sanoma/agent-home/boxes/` instead.

The agent receives a Git bundle of the draft, without the company’s remote URL or Git credentials. On the first turn and whenever the lockfile changes, the box runs `pnpm install --frozen-lockfile --ignore-scripts`. At the end of the turn, Sanoma commits the edits as you, brings them back to the draft, and runs `sanoma check` in the box with its own database.

One turn uses your box at a time. If the box is busy, wait for the turn or draft check to finish and send your message again. A box failure during a turn can lose that turn’s edits.

On the company key, Pi and Claude Code can call the same company tools as Sanoma through the worker. Sanoma restricts edits to the clone, excludes `.git` and `node_modules`, and refuses shell commands requested through these tools. Use the Sanoma engine to take or update an app. Claude Code reads files directly as the machine’s user. Its first install needs pnpm 11, Bash, and about 760 MB. Keep its token-protected bridge port behind a firewall.

### Use a personal agent subscription

Choose **Your own plan** in a new chat. Depending on the installed connectors, you can select Copilot, OpenCode, Pi, Claude Code, or Codex. Hosted instances omit Pi and OpenCode from this menu because their personal sign-in requires a local terminal.

Personal agents use your vendor subscription. They work in a clone of the draft and do not receive Sanoma’s company tools or credentials. Allow 150–340 MB per agent for the first install. Its installation and sign-in persist under `.acp` in your box. On a shared local machine, agents run as the same operating-system user and may be able to read another person’s sign-in.

### Sign in to an agent

Follow the instructions on the sign-in card. Copilot and Codex give you a link and a device code. Claude Code can ask you to paste a code back into the card. Pi gives you a command to run on your computer. After sign-in, send your message again.

The app restricts file requests that personal agents send through it. An agent’s own tools can behave differently. For example, OpenCode can edit files and run commands in the clone directly. Review the resulting draft and its checks before saving.

### Layout on smaller screens

At widths of 1024 pixels and up, chat sits beside the page. At narrower widths it overlays the page. Below 768 pixels the chat column is hidden. Use the menu at the top to open navigation.

### Display preferences

Open the menu under your initials to change the theme or choose **Density → Compact**. Compact reduces spacing and control sizes while keeping the text size. The browser remembers your settings.

In the [desktop app](https://github.com/Sanoma-AI/sanoma/blob/main/packages/desktop/README.md), this menu also lists open companies. Select one to switch, or choose **Add company…** to open another.
