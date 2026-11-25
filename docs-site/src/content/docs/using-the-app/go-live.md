---
title: "Put your company online"
description: "Choose a host, configure how staff sign in, and check the deployment."
sidebar:
  order: 8
---

Open **Hosting** in the company running on your computer. The panel shows which setup your company uses.

- **Sanoma Cloud.** Under [Ready to go live](#ready-to-go-live), check the proposed address, then choose **Go live**. Follow the sign-in prompt if it appears.
- **Your own accounts.** Open **Connect**. Connect the GitHub App and vendor accounts, check staff sign-in, and follow the steps for your repository, database, and host. You can [connect an existing repository or database](#connect-an-existing-repository-or-database).

Follow the deployment run from **Hosting**. When the host answers, open the signed-in link to check your company at its hosted address.

## Go live

Open `/hosting` while the company is local, or go to `/hosting/connect`. On top of Hosting, a panel by the company's state, the host's health asked once as the page opens (not as a link to it is hovered, nor as the window regains focus; every few seconds while going live, and until a host just bound answers), with at most one ask every ten seconds: while Local, **Ready to go live** when `resources/sanoma/infra.ts` declares Sanoma Cloud (below), else the steps; **Going live** with its lines (repository, database, host, sign-in) and its run; **Go live failed** with the run's error, **Retry** and **Ask the agent** (on Sanoma Cloud, Retry is Ready to go live's Go live again; on your own accounts, **Back to the steps** too); **Live** with whether the host answers, on this computer that this is a drafting copy and, once the host answers, **Open, signed in as `<your email>`** (below), and on the hosted instance **Open on your Mac** (the desktop app, opening the company's repository).

The steps' first, **Connect**, connects the company's GitHub and the vendors of its database, host and wakeup. When how far going live is cannot be read, its steps say why in their place, with Try again, and the rest of Hosting shows as ever.

### Connect the GitHub App

**Create GitHub App** (with an organization's login, or empty for your personal account) goes to `/setup/github/manifest`, a page that posts the App's manifest to GitHub (administration, contents, pull requests and commit statuses: write; push and pull request events, its webhook at the app's `/webhooks/github`, on unless the app is on this machine; its OAuth callback the staff sign-in's `/auth/better-auth/callback/github`, and email addresses: read, for the verified email), with its state and who asked in a signed, httpOnly cookie (nobody signed in is sent back here, told to say who they are first).

You name and create the App on GitHub's page; GitHub sends you back to `/setup/github/callback`, which checks the state, exchanges the code (`POST /app-manifests/{code}/conversions`) and writes the App's id, slug, client id and secret, webhook secret and private key through the selected store as who asked (`SANOMA_GITHUB_APP_ID`, `SANOMA_GITHUB_APP_SLUG`, `SANOMA_GITHUB_CLIENT_ID`, `SANOMA_GITHUB_CLIENT_SECRET`, `SANOMA_GITHUB_WEBHOOK_SECRET`, `SANOMA_GITHUB_APP_PEM`), then comes back here saying how it went (sign-in uses the new client once the app restarts on a host beyond this machine).

### Configure staff sign-in

Step 1 ends with **Sign-in**, how people will sign in on the host (ready, or invite links only): you, signed in from this machine when the host starts (or, while the people file declares no email for you, to declare one), an email code through the config's `login.sender` once its connector is connected, GitHub through the company's App once its client is stored (and, when the App lacks the permission to read email addresses, which a sign-in with a private GitHub email needs, that Connect says what to add), and invite links always.

While the email code is not ready, it has a `warning · not blocking` badge and the ways to fix it: name a sender in `sanoma.config.ts`, or connect the one named on Hosting › Connect, and, without GitHub, connect the GitHub App. A sender whose connector Connect does not list gets a row of its own there. When the config names a sender, going live gives the host its driver's variables among the host's `secrets` (`RESEND_API_KEY`; the address it sends from is the config's `login.from`).

Once the host answers, **Open, signed in as `<your email>`** asks the host for an invite for the email the people file declares for you, sealed with the signing key it shares (the host's own, `SANOMA_HOST_SIGNING_KEY`, when the config binds none), and opens it.

The page then shows the App's slug with **Install**, and, from GitHub's listing of the App, read as the App with its stored keys (at most every ten minutes, two seconds allowed), the permissions the manifest asks for that it lacks, as an App made before the manifest asked for them, or by hand, may: set them in the App's settings under Permissions & events, then accept the update on its installation.

### Connect vendor accounts

Vendors with named authentication use the same connection forms as their connector pages, instead of the old per-vendor token controls. Going live requires an explicitly declared default account that is connected; a sole connected account does not become a default automatically. Other bootstrap inputs, including the wakeup service's URL and account token, remain separate.

Going live chooses by contract among the config's types whose vendor is connected (for the database and the host, a vendor this page does not connect counts as connected; the page names the vendors still to connect, and refuses a database or host other than the one it showed): the database (Neon's project first, else the first type that meets the `Database` contract, with its regions, which it holds the choice to, and size), the host (Cloudflare's container once its required connection is ready, else Docker's, else the first host; any host but Docker runs `ghcr.io/sanoma-ai/runtime:<the sanoma version the company installs>`, which Cloudflare copies into its account's registry at apply) and the wakeup (a connected one that wakes that host, the host's own vendor's first: Cloudflare's alarm before `sanoma.wakeup`).

The repository is private, so going live also makes a new deploy key, its private half stored as the host's `SANOMA_SOURCE_KEY` (among its `secrets`, never shown) and its public half declared after the repository as a read-only `github.repository_deploy_key`, which the apply that makes the repository adds to it, and the host's apply waits for (a file written before deploy keys, or by **Connect an existing repository**, declares none, and its host clones as before); a GitHub connector with no such type is named among what is missing before anything is written.

Every start of the host clones with it ([Cloning a private repository](/hosting/self-hosting/#cloning-a-private-repository)).

### Connect a wakeup service

When the config declares a host type, the page also offers **Connect a wakeup service**, for scale to zero: the [wakeup service](/hosting/wakeup/)'s URL, `SANOMA_WAKEUP_URL` (Sanoma's, or your own `sanoma wakeup`), and an account's token there, `SANOMA_WAKEUP_ACCOUNT_TOKEN`, both optional. Storing the account's token also mints the instance's own, `SANOMA_WAKEUP_TOKEN`, unless one is stored, and never shows it.

With both stored and no wakeup of the host's own vendor connected, going live writes the runtime's own wakeup (`export const wakeup = sanoma.wakeup({ host })`, imported from `sanoma/resources`) into `resources/sanoma/infra.ts` after the host, mints `SANOMA_WAKEUP_TOKEN` when none is stored, and gives the host it (and `SANOMA_WAKEUP_URL`, for `sanoma.wakeup`) among its `secrets`, so the one apply of the host and the wakeup gives the worker on the host what it registers with; removing the line and answering its orphaned binding **delete** on Hosting deletes the instance.

### Ready to go live

**Ready to go live** (on `/hosting`, on this computer, while `resources/sanoma/infra.ts` declares Sanoma Cloud and nothing of it is made, as a new company's template does). The company's **Address**, `<address>.sanoma.work`, which is also the name of the repository the Cloud makes: the one the file declares (the host's `hostname`), which you can change, also after a try that made the database (the company is bound by its id, so it moves to the new address as its host is made, and its repository keeps its name); once you are signed in to Sanoma, it is checked at the Cloud (available, yours already, or taken).

**Go live** signs you in to Sanoma first when this app has no Cloud token: it opens www.sanoma.work's sign-in in your browser, where you sign in and allow it, and the browser comes back to `/hosting/sanoma/callback` on this app, which stores the token (`SANOMA_CLOUD_TOKEN`) and says you can go back to the app; the app goes live once it sees the token. A sign-in lasts ten minutes and works once.

Then going live (the built-in `go-live-cloud`) writes a changed address into the file and commits it, has the Cloud make the company's repository in your GitHub account (through the Sanoma.work GitHub App), sets it as `origin` and pushes `main` with git's own sign-in, then makes the database and the host and waits for them. **Paste a Cloud token** stores one from your account at sanoma.work instead (Hosting › Connect, only a token that starts with `sca_`), and **Use your own accounts instead…** shows going live's steps (`?own`): going live there writes the file again.

A Cloud token set in the company's `.env` is used as it is; the app cannot replace it. Once the host answers, **Open, signed in as `<your email>`** asks Sanoma Cloud for the sign-in link.

### Connect an existing repository or database

**Connect an existing repository or database** (`/hosting/existing`, linked from the connect page): takes a GitHub repository (`owner/name`, its owner required) and/or a Supabase project's ref, reads each through its type's import (in the worker, as a `connect-existing` run, before any declaration names it; apply's own import, when it binds, is in the ledger), and writes `resources/sanoma/infra.ts` from what was read: the repository's owner, name, description and visibility; the project's name, organization and region, with its database password declared as a generated secret, which Supabase never reads back, so the next apply that changes the project sets a new one.

In a repository without a remote, the file is committed where the checkout is; with one, on a new branch, `setup/connect-existing`, checked out, and the page shows the diff: merging it is the approval. Then the run starts apply as its child with `bind` and `only` for those declarations, which binds them in the lockfile (committed on the same branch) and creates nothing. Refused when `infra.ts` or the branch is there already.

Named authentication uses the connection forms below. A connector that still declares only an `env` schema retains its separate credential fields; those are not account selectors. Named connections never gain an environment-first fallback or process-wide credential swapping.
