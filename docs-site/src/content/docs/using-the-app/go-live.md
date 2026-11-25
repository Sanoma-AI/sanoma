---
title: "Put your company online"
description: "Deploy a local company to Sanoma Cloud or your own accounts, then sign in to the hosted app."
sidebar:
  order: 8
---

Open **Hosting** in your local company app. If you see **Ready to go live**, follow the [Sanoma Cloud steps](#ready-to-go-live). To deploy on your own infrastructure accounts, open **Connect** and start with the [GitHub App](#connect-the-github-app).

## Go live

| Hosting status     | What to do                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Going live**     | Follow the linked run to see progress on the repository, database, host, and sign-in.                                                     |
| **Go live failed** | Read the run error. Choose **Retry** or **Ask the agent**. With your own accounts, **Back to the steps** lets you change the setup first. |
| **Live**           | Once the host answers, choose **Open, signed in as `<your email>`**. The local company remains your drafting copy.                        |

On the hosted instance, **Open on your Mac** opens the company repository in the desktop app.

### Ready to go live

A new company’s `resources/sanoma/infra.ts` declares Sanoma Cloud. To deploy it:

1. Check the proposed **Address**, `<address>.sanoma.work`. Once you sign in, Sanoma checks whether it’s available. The address also supplies the name for a new repository.
2. Choose **Go live**. If prompted, sign in to Sanoma in your browser and authorize the app. The sign-in works once and expires after ten minutes. Return to the app to follow the run.
3. Wait for **Live**, then open the signed-in link. Your email must be declared in the company’s people file.

The run commits any address change, creates the repository in your GitHub account, sets it as `origin`, and pushes `main` using your Git credentials. It then provisions the database and host. If an earlier attempt created the database, you can still change the address. An existing repository keeps its name.

To supply a token yourself, select **Hosting → Connect → Paste a Cloud token** and enter a token starting with `sca_`. A token supplied in the company’s `.env` takes precedence. To switch to your own providers, choose **Use your own accounts instead…**.

### Connect the GitHub App

1. Sign in to the local app. In **Hosting → Connect**, choose **Create GitHub App**. Enter your organization’s login or leave it empty for a personal account.
2. Name and create the app on GitHub. GitHub returns you to Sanoma, which stores the credentials in your configured secret store.
3. Choose **Install** for the account that will own the repository. If Sanoma reports missing permissions, update **Permissions & events** in the GitHub App settings. Accept the change on the installation too.

The app requests write access to administration, contents, pull requests, and commit statuses. It requests read access to email addresses for staff sign-in.

### Configure staff sign-in

Check **Sign-in** at the end of the connection step. Invite links work even when other methods are unavailable.

- **Email codes.** Set `login.sender` and `login.from` in `sanoma.config.ts`, then connect the sender under **Hosting → Connect**. A warning about email codes leaves deployment available.
- **GitHub.** Connect the company’s GitHub App. Sign-in with a private GitHub email requires permission to read email addresses.

For a teammate’s first visit, see [Sign in to your company](/using-the-app/sign-in/).

### Connect vendor accounts

Connect the providers shown for the database and host. A provider that uses named authentication needs a connected, explicitly declared default account. See [Manage vendor connections](/using-the-app/connections/).

Check the proposed database, region, size, and host. Sanoma prefers Neon when available. For hosting it prefers a configured Cloudflare container, then Docker, then another compatible host. Go live uses the database and host shown on the page.

For a new private repository, Sanoma provisions a read-only deploy key. The host receives the private key as `SANOMA_SOURCE_KEY` and uses it to clone the repo on startup. If the GitHub connector lacks the deploy-key resource type, setup reports it before writing files. See [Cloning a private repository](/hosting/self-hosting/#cloning-a-private-repository).

### Connect a wakeup service

If the host scales to zero, connect a [wakeup service](/hosting/wakeup/) so it can wake the worker. Sanoma prefers a connected wakeup from the host’s own vendor.

To use **Connect a wakeup service**, supply the service URL (`SANOMA_WAKEUP_URL`) and account token (`SANOMA_WAKEUP_ACCOUNT_TOKEN`). Storing the account token also creates an instance token if needed. With both settings and no connected wakeup from the host’s vendor, Go live declares `sanoma.wakeup({ host })` in `resources/sanoma/infra.ts` and supplies the host’s secrets.

### Connect an existing repository or database

From **Hosting → Connect**, choose **Connect an existing repository or database**. Enter a GitHub repository as `owner/name`, a Supabase project reference, or both. The worker reads the existing objects and writes their declarations to `resources/sanoma/infra.ts`.

Review the Supabase password declaration before applying further changes. Supabase cannot return the existing password, so Sanoma declares a generated secret. The next apply that changes the project sets a new password.

With a remote, Sanoma checks out `setup/connect-existing` and shows the diff for review. Merging that branch approves the change. Without a remote, it commits on the current checkout. The binding run records the existing objects in the lockfile without creating replacements. Setup refuses to proceed if `infra.ts` or the setup branch already exists.
