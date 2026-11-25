---
title: "Company screens"
description: "Find people, permissions, installed apps, and hosting resources in the company app."
sidebar:
  order: 10
---

Use **People** to look up a teammate, **Permissions** to see what they may do, and **Hosting** to check resources. To deploy a local company, [put your company online](/using-the-app/go-live/).

## Home

The home page (`/`) displays the company’s name and **Set up your company** with how many of its five steps are done, each from a fact (Start the company; Connect your agent; Try the sample workflow, a finished run of a workflow of the company's own; Add a teammate, a second person; Put it online, its host bound), each not done with what does it, and **Hide**, kept in a cookie (`sanoma_home_setup`); gone once all five are done.

Under it, **Waiting on you** (the approvals you may decide, each opening in the Inbox) and **Recent runs** (the company's own latest ten, not the built-ins', with **All runs**).

## People

Open `/people` to see who can act. The page lists identities from the data files (`sanoma.person`, `.agent` and `.group`), with how many people beside the title, and the tabs **People**, **Groups** and **Agents** (`?show=`), each with how many. The problems with a declaration of theirs, or in a file that declares them, show above the table (their resources are left out, and nobody is admitted while there are any).

People lists each person's name, email (`none` without one), groups (written on each group, read back by its members), how they sign in (an email code to their email, their GitHub login, or that they cannot) and when they last signed in and how (`Never` until they do), from the ledger; Agents lists each one's name, whom it acts for, its groups (also `agents`, muted and marked built in, the group the runtime puts every agent in) and the declaration, which opens in its file on Hosting; Groups lists each group's members, then, while there are agents, the built-in `agents` with them.

A row opens over the list (`?person=<id>`, a group's name) with its file and export (opening it on Hosting) and its declaration's form (below): its fields from the type's schema, as declared, its id (a group's name) read-only, as the policy and the groups name it, and a group's members read-only, since they name declared people.

On a host, each person's row, and their open card, has **Invite link** (only someone in `admin` makes one, and only for someone with an email declared; otherwise it is disabled and says why), which mints a one-use link that signs them in and shows it in a card, **Invite link for `<name>`**, with **Copy**, to send them however you like; a new link replaces their last.

## Permissions

Open `/permissions` to see how the policy evaluates calls for someone in no group, in each group (the declared ones, `agents` and `visitors`) and `anonymous` (Anonymous, a public page with nobody signed in), across, for the start of each workflow, with each operation it uses under it, and each operation a person may call directly down, with the policy beside the page's title: Cedar, its files, its version and how many groups, workflows and operations the grid has, and a notice when the policies do not hold, as they then refuse every call.

Each cell is the policy's answer for someone in that group alone (an agent acting for someone, so a hold for `on-behalf-of` asks "whom it acts for"; a visitor, denied a start and a direct call no `permit` names, and allowed an operation in a run), the input unknown: allow (muted), hold (with whom it asks), deny, or depends (the input decides); a hold, a deny or a depends opens the rule behind it in a sheet (its id, its file, its `@title` or `@reason`, and for a hold whom it asks), with Show the rule.

While the policy's files are in more than one folder (the root's `policies/` and an app's), the tabs **All**, **Yours** and one per app (`?app=`) pick a folder: its files, and the grid's rows in it (its workflows, and its collections' operations; the vendors' at the root), and under the grid each folder's files sit under its heading. Under the grid, each policy file is shown read-only, titled by its path, as a workflow's Code tab shows its source (plain: the app has no Cedar grammar); Show the rule marks that rule's lines there.

Nothing here is edited: the rules are `policies/*.cedar`, and the people and groups People lists. With a remote, a line under the grid says what the repository's host enforces on `main`: a pull request and the `sanoma` check, or what it lacks and why, in the host's words.

## Apps

Open `/apps` to browse three lists of company apps. The title shows the total. Select an app’s name to open its page. **Yours**: the apps of its own (no source), each with its folder and what it holds (workflows, collections, sites). **Taken**: those merged from a source repository (`app.ts`'s `source`), each with its source, linked, and how many commits it is behind that source (fetched by the worker when it starts and after each push to `main`, or why it cannot tell).

**Available**: the apps on GitHub not taken yet (the repositories with the topic `sanoma-app`, through the built-in `sanoma.apps.list`, called as you once the page knows who you are, so the policy decides it and GitHub never holds up the rest of the page), Sanoma's own first, each with its tier (Official, Vendor verified or Community, from Sanoma's claims, `sanoma/claims`), whether Sanoma reviewed it, its description and license, its README, a solution's demo (**Try it**) and **Add**.

**New app**, **Add** and **Update** open the chat with a prompt for the agent ("Make an app that ", "Take the app from `<url>` into this company with take_app, …", "Update the app in apps/`<name>`/ from its source with update_app, …"), which drafts the change on a branch of its own; when GitHub cannot be searched, a notice says why and the repo's apps show all the same.

**An app** (`/apps/<name>`) is its parts in one card: its header has, for a taken app, how far behind its source it is, **Source** and **Update**; then a line saying where it lives, and a section each for its **Sites** (its pages, what they call, who sees them), **Collections** (key and fields, opening the grid), **Workflows** (the operations each may call with their effects, its last run, its runs), **Policies** (each file under its `policies/`, how many rules and their reasons, to the Permissions grid) and **Scenarios** (each feature file under it, how many scenarios, of which workflows).

People never sit in an app: they are declared at the root, on People.

## Hosting

Open `/hosting` to check where the company runs and which vendor resources its data files declare. On top, a card per slot: Repository, Database, Host, Wakeup and Agent box (the sandbox the coding agents' boxes are opened in), each the declared resource whose type meets that contract (`resourceTypes[].capabilities`; the repository is the one the host clones), with its name, type, its plain declared fields, its binding and the latest drift verdict (with the fields that differ, and Adopt), the host's with where the last apply that made it says it answers and how it stays up, from its type (`resourceTypes[].host.lifetime`): Always on, or Stops when idle, what is due while it sleeps started by the Wakeup, or, with no Wakeup declared, a notice that none wakes it, so going live declares none and the host stays up.

For a host that derives (`cloudflare.host`), its card also shows, read-only, what apply gives it (`hostDerived`, by `deriveHosts` as apply runs it, nothing minted): the runtime image, the repository and branch it runs, the public sites' domains it attaches, and each key it is given, stored or not and since when: `SANOMA_SIGNING_KEY` (or, when the config binds none, the host's own, `SANOMA_HOST_SIGNING_KEY`, generated into the store at its create), `SANOMA_SECRETS_KEY` with the built-in store, `SANOMA_SOURCE_KEY` and the wakeup's token; never a value.

The agent box's card says whether each key its connector takes is set, with a link to the connector page where it is; a live instance that declares no sandbox says what to declare instead (on Sanoma Cloud, `cloud.sandbox({})`, with nothing to set; elsewhere `agent37.instance({})` and its key), since its coding agents refuse to run without one. While no host and no database are declared, and while going live has bound its repository but not yet its host (`resources/sanoma/infra.ts`), going live's steps show above them (**Go live**, below).

### Resources and bindings

Under them, **Other resources**: each other resource the data files declare (people are on People, collections on Data; its name, type and vendor, the declaration it comes from, which opens in its file below the table, marked, and the vendor object the lockfile binds it to, its id cut short), with the latest drift check's verdict: clean, drifted (with each field that differs, as declared and as the vendor holds it, shown under its row), gone, absent (not bound yet, and whether its identity found an object), error (and why), or not checked.

Bindings in the lockfile that no data file declares are listed under the table, each with its key, type and id: apply asks whether to forget each or delete its object.

### Apply, adopt, and edit

**Apply** starts the built-in `apply` workflow on every declaration, and goes to its run; the config registers it beside drift. Apply holds its plan for a person: wherever an approval's details carry one, the Inbox and the run show it as the change view: problems in the data files, each change to the lockfile apply did not make in plain words ("points store at a different project: abcdefgh… → wxyzabcd…"), then the steps by action: creates with their planned fields (what the vendor fills in is "known after apply"), updates and replaces with the fields that differ (and, for a replace, the fields that cannot change in place), binds (found by identity, or given), gone objects and orphaned bindings with the question each asks, and the unchanged, folded.

Each drifted field has **Adopt**, which writes the value the vendor holds, as that check's report has it, into the data file (`setFields`: only that declaration changes), commits it when the worker is given a `source` (the company's repository; without one it only writes the file), as an `adopt` run in the worker, and starts a drift check, which reads the file as it now is.

A declaration's literal fields are written from a form too: **Edit**, beside the file a declared resource opens in (`?edit`), and a row of People open, draw the declaration's form (`components/declaration-form.tsx`): its type's schema's fields (less those only the vendor sets or never reads back), as the data file declares them, a field that names another declared resource and a person's, agent's or group's identity read-only.

**Save** sends the fields you changed (a `patch` run, `{ at: { file, export }, fields }`, for a declaration the description names: a resource, a collection, a site or an app; it sets fields and removes none, so an emptied one is refused on the form) through the same writer, which parses the file and changes literals only: a field the file computes (a name or reference, a call, a spread) or a declaration that is no object literal is refused with the writer's reason (`invalid_input`, with the `field`), which the form shows under that field, read-only from then on, and stays the code's to change.

Under the form, where it landed: **Saved as a change**, linking to its review, or saved to the file and the commit; a refusal (a 403) shows its reason. The form shows the declaration as the files hold it: the app makes its description again on the next request once a file it loaded changes (`liveDescription`), and a Save or an Adopt reads the config again, so what was saved shows on People, Hosting and Data at once.

Where a Save lands: when the repository drafts and its remote has a connector's remote half, it is a change (**Changes**, above): the fields set in a draft of its own, `ui-<8 hex>`, committed there as you ("Change `<fields>` of `<export>`") and sent for review, the answer being the change's run, whose page is `/changes/<id>`; a change to the rules (a people file) waits for `admin` as any change to them does.

Without a remote it is written and committed in the checkout as Adopt is, a people file (or a file one imports) only by someone in `admin` (403 for anyone else, since nothing would review it). Adopt and Save write the checkout one at a time.

### Check for drift

**Run drift** starts the built-in `drift` workflow, which reads the data files as they are then; the page reads the drift runs as a workflow's Runs tab does, every 2 seconds, links to the latest run, and shows the report of the latest that finished. Problems in the data files show under the tables, each at its file, line and column, since their resources are left out: those the app found when it started, and any the last check found.

The declared list is the description's, made again once a data file, the lockfile or a folder they are in changes, so a declaration written since opens without a restart; the public sites' hosts and logins stay as the app started.
