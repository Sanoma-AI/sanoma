---
title: "Use chat in the app"
description: "Open a chat, call a workflow, or choose a coding agent."
sidebar:
  order: 9
---

Open **Chat** in the sidebar. A conversation can run workflows or prepare edits to the repository. When the agent changes files, [review the draft](/using-the-app/changes/) before saving it.

## Navigation and chat

The screens share one shell: down the left, the bar, and beside it the chat column, then the page. The bar has **Chat** first, then the sections and the sites' tiles in their groups, each an icon in a tile with its label under it, the current one filled (Inbox badged with how many approvals are pending), and at its foot the menu under your initials.

**Chat** folds the chat column away and opens it again, and the app opens it as you left it on your next visit (it keeps that in a cookie, `sanoma_chat`, so the server renders the page with it open or folded from the first paint); until then it is open where it sits beside the page and folded where it would lie over it.

### Start a chat

The column is your chat with the agent: your latest chat (the others, and **New chat**, at its top), your messages at the right, its replies under them with the steps it took as a checked list, and at its foot the composer, carrying the page you are on.

Until the agent is connected (our loop without its model's key, and no engine chosen), a new chat shows **Connect your agent**: **Your Claude plan** (recommended; **Sign in with Claude** starts Claude Code's sign-in at once), **Your ChatGPT plan** through Codex (on a live instance **An OpenAI API key**, not offered yet, since OpenAI's plan sign-in is this computer's), **An API key** (the Anthropic connector's page) and **More agents** (Copilot, OpenCode, Pi); **Agent…** in the menu at the bar's foot shows them again.

The engine chosen there or in the composer is the one your new chats open on, kept in a cookie (`sanoma_engine`). Once it is connected, the agent speaks first in your first chat (titled Getting started): who it is, what it read in the company (its workflows, connectors and people) and a few suggested asks, each a button that sends it in the chat; after a sign-in it asked for, it speaks once that is done. A reply that ends with suggested asks (after a change, two next ones) shows them the same way, never as text.

### Workflow calls from chat

The agent has `/mcp`'s five tools too ([Agents over MCP](/start/agents-over-mcp/)): it reads the company's description, looks something up, starts a workflow, reads a run and waits for one.

It makes each call as the runtime's agent `sanoma-chat` acting for you: the policy sees `sanoma-chat`, in `agents`, with `onBehalfOf` you, and is asked again as you alone, the stricter answer standing, so the chat may do no more than you may; its start of one of the runtime's own workflows that does not only read waits for a person in `admin`, as any agent's does; a company's policy holds or forbids it by `principal in Sanoma::Group::"agents"` or `principal == Sanoma::Principal::"sanoma-chat"`; the ledger, the run's trace and the Inbox say `sanoma-chat for ada`, and you may approve a hold on a run it started for you.

Only the app's worker makes this principal, for the person whose chat turn it is: `x-sanoma-agent` refuses `sanoma-chat`, no sign-in admits it, and acting for no one it is nobody. What it starts runs the company's merged workflows on the live instance, never the chat's draft, which runs nowhere until it is saved.

A call or start the policy holds shows its approval's card in the reply (or who it waits for, with the Inbox's link), and the tool waits for the decision (ten minutes at most on Sanoma, fifteen seconds on Pi or Claude Code), then answers with the run, or that it still waits, with its id and whose decision it waits for; a stop ends any wait. Once such a run is decided, the reply shows what became of it in place of the card, and the agent is told so in its next turn.

A run that started and then failed is answered with its id, that it failed and why (the step reads **Started … : the run failed**), not as a start that was refused, so the agent does not start it a second time. Each call's id is the chat's, its turn's and the tool call's, and each reply records its turn, so a restart that cut a start short answers from the run it left rather than having the agent start it again.

What this changes for an existing chat: a lookup is asked of the policy as `sanoma-chat` as well as you, its driver sees `sanoma-chat` as the principal, and a held one is named for it (`call:sanoma-chat:…`); a workflow the chat starts whose calls select a connection that belongs to a person (a connection rule's) is refused, since the run's actor is `sanoma-chat`, not its owner.

### Chat history and engine selection

The chat is kept in the company's database: a restart loses the turn under way, not the chat or the draft, and **Continue** picks up. The model is the first connector with a model half, its default; without its key, the reply says so with a link to its connector page.

A new chat's composer picks its engine, each with its mark (a coding agent's from its connector), which the chat keeps, the agent with the account it runs on, and names at its top: **Sanoma** (our own loop, the default), or an existing coding agent on the company's Anthropic key, **Pi** or **Claude Code**, driven through the AI SDK's `HarnessAgent` in the person's box, one per person per company, kept across restarts: in the sandbox the company declares (one `agent37.instance` in a data file, which going live writes into `resources/sanoma/infra.ts` once Agent37's key is stored; on Sanoma Cloud, `cloud.sandbox({})`, whose boxes Sanoma Cloud opens with the company's Cloud token), each box an Agent37 instance its connector opens, else, on this computer, a directory of its own (`.sanoma/agent-home/boxes/<box>`); a live instance that declares none refuses the coding agents, the reply saying what to declare, so no agent ever runs inside the live instance.

### Coding-agent sessions

Each turn opens the box, brings the chat's draft into the box's clone (`repo/`) as a git bundle, which carries commits and the branch alone (no remote, no token, no secret of the company's), and runs `pnpm install --frozen-lockfile --ignore-scripts` there with the box's own pnpm (never the one a `packageManager` field names) on the first turn and whenever the lockfile changed, so the box keeps a second `node_modules` of its own.

Pi and Claude Code get `/mcp`'s five tools as host tools (`HarnessAgent`'s `tools`), run in the worker as for Sanoma: Pi runs in the worker, and Claude Code's bridge offers them to it as an MCP server inside its own process that sends each call back over the bridge's socket, so no URL, token or secret of the instance reaches the box.

A coding agent reads the repository's `AGENTS.md` itself; its file edits are allowed inside the clone and refused outside it (by their real paths in the box, where the files are) or under `.git` or `node_modules`, its shell commands are refused, each with the reason shown as a refused step (so taking or updating an app is the Sanoma engine's) (Claude Code reads files itself, as this machine's user: only its edits and commands ask); at the end of its turn its edits are committed in the clone as the person, brought back to the draft as a bundle, and the draft checked in the box (`sanoma check` in the clone, with no database URL or credential of the company's, so on a Postgres of its own).

One turn runs in a box at a time: a second, from another of the person's chats, is refused until the first ends, and a draft's check (Review's, or the Sanoma engine's) waits for it; a box that fails mid-turn loses that turn's edits, and says so. Claude Code's first turn in a box installs it under the box's home (about 760 MB, 40 s), which needs pnpm 11 and bash on the `PATH`; its bridge listens on all interfaces, guarded by a token, so keep that port behind a firewall.

### Use a personal agent subscription

Under **Your own plan**, the composer offers a person's own coding agent, on their own subscription, driven over the Agent Client Protocol by the app's own client in the person's box, on its clone of the chat's draft: **Copilot**, **OpenCode** (its free models need no sign-in), **Pi**, **Claude Code** and **Codex**, as far as their connectors are installed. A live instance offers no coding agent while it declares no box, and not **OpenCode** or **Pi** on a person's plan, whose sign-in is a command run once on the person's own computer.

A person's own agent spends that person's plan under their vendor's terms, which Sanoma neither checks nor changes. It gets none of `/mcp`'s tools: the Agent Client Protocol gives an agent only MCP servers it reaches itself, a process or a URL with its credential in the box, and the box holds no remote URL, git token or company secret of the instance's, only the turn's model key. ACP's MCP transport over the agent's own connection, not yet stable, is how it would get them.

The agent runs in the person's box (on a laptop, a directory of this machine) with an environment of its own: its `HOME` is `.acp` in that box (`.sanoma/agent-home/boxes/<box>/.acp`, kept across restarts), so a sign-in is kept for that person and never the company's (every person's agent runs as this machine's user, so on an instance several people share, what an agent runs itself can reach another person's sign-in), and none of the app's or this machine's credentials reach it (no token variables; `gh`, `security` and the browser openers refuse on its `PATH`).

Its first turn on a machine installs it there (`.acp/<agent>`) with the pnpm on the `PATH` (the desktop shell ships its own), in 10 to 45 s and 150 to 340 MB each. So `.sanoma/agent-home/boxes` holds a box for each person of the company: its home is Pi's and Claude Code's on the company's key (whose session's files are the clone's and that home's only, never its `.acp`; Claude Code's own reads and the commands a bridge runs are this machine's user's), and its `.acp` the person's own agents' (their `HOME`, installs and sign-ins, given only to that person's agents).

The `harness`, `acp` and `people` directories of earlier versions are no longer read: delete them by hand.

### Sign in to an agent

When the vendor asks the person to sign in, the reply is a sign-in card: the vendor's link and code (Copilot's and Codex's device flows), with a field for a code the vendor asks to have pasted back (Claude Code's), or, for Pi, whose sign-in needs a real terminal, the command to run once on this computer; the app opens no link and enters no code, the card keeps neither once it ends, and after signing in the person sends the message again.

The agent's requests to read or edit a file are allowed inside the clone and refused outside it or under `.git` or `node_modules`, as are its requests to run a command and anything else it asks for, each with the reason as a refused step (it is never given an always-allow); the files it reads and writes through the app are the clone's only.

What it runs in the app's terminal, and what its own tools do without asking (OpenCode edits and runs commands inside the clone without asking), are its own: the commit brought back to the draft and its checks, at the end of the turn, are the gate.

### Layout on smaller screens

From 1024 px wide the column sits beside the page; narrower, it lies over the page; on a phone (under 768 px) there is none, and the bar is a sheet over the page, opened from the menu button atop it, that closes as you follow a link or tap beside it. Each page starts with its title, with what it counts beside it and the pages above it as links (Workflows, then the workflow's title, on a run's page), its actions at the end of the row; then, on a page with views, pill tabs, each a URL; then one card.

What you open from a list, an approval, a run, a scenario or a graph's node, floats over the card's right in a card of its own, and sits above the list (under a graph) while the page's card is too narrow.

### Display preferences

**Density**, in the menu at the bar's foot under the theme, switches the page to **Compact**, a tighter density for people who live in the app: the page a quarter tighter in every padding, gap and control (its icons too; the text keeps its size), half the gap between a page's regions, a lower graph card and source (a floating card keeps its width). The browser remembers the density in a cookie (`sanoma_density`), so the server renders the page in it from the first paint.

The menu at the bar's foot, under your initials, has who you are (and Change name, under the default resolver), the theme (light, dark or the system's, which the browser remembers) and the density.

Inside the [desktop app](https://github.com/Sanoma-AI/sanoma/blob/main/packages/desktop/README.md)'s window it also lists the companies open there, this one checked: choosing another switches the window to it, and **Add company…** shows the desktop app's start screen (`src/lib/desktop.ts`, over the `window.sanomaDesktop` the desktop app gives the page; in a browser there is none, and the menu has no Companies).

The screens are built with [shadcn/ui](https://ui.shadcn.com) components (`src/components/ui`, from `components.json`) on Tailwind CSS, in the theme `src/style.css` holds: Sanoma's palette in light and dark, IBM Plex Sans and Mono (Fraunces for display), and 28 px controls.
