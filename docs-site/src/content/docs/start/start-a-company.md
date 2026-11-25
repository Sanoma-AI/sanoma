---
title: Start a company
description: "Create a company in an empty directory, run it locally, and find the files for your first workflow."
next:
  link: /start/first-workflow/
  label: Run your first workflow
prev:
  link: /start/setup/
  label: Set up a company
sidebar:
  order: 1
---

Start in a new directory on a machine with Git installed and a Git user configured. The example creates a local company called Maple Street Studio. Substitute your name and sign-in email.

```sh
mkdir maple-street && cd maple-street
npx sanoma init --name "Maple Street Studio" --you "Dana Reyes" --email dana@maplestreet.studio
```

## What init writes

`sanoma init` copies the package’s `template/` into an empty directory. Existing dotfiles are allowed. Running `sanoma` there without options also initializes and starts the company.

| File or directory | What you’ll find |
| --- | --- |
| `sanoma.config.ts` | The app’s Anthropic chat model, Resend for sign-in codes (`login.sender`), GitHub, Sanoma Cloud, and coding-agent connectors for Codex (OpenAI), OpenCode, and Pi. Claude Code and Copilot come with the Anthropic and GitHub connectors. |
| `resources/data.ts` | The Outbound board where the example `record-lead` workflow saves a lead. The template also includes the workflow’s scenario. |
| `resources/people.ts` | Your person declaration in the `admin` group. |
| `policies/policy.cedar` and `policies/changes.cedar` | Sending or publishing waits for `admin` approval. So does every change. |
| `resources/sanoma/infra.ts` | The Sanoma Cloud database and host the company will use when it goes live. Until then, a merge deploys nothing. |
| `secrets.ts` | Bootstrap key bindings and an environment binding for `SANOMA_CLOUD_TOKEN` when set, as it is on a host. |

The template also sets up the resource directory structure, `AGENTS.md`, and `.env.example`. Sanoma derives the package name from the directory name. The app displays `--name` when supplied and the package name otherwise. For the host address, `<slug>.sanoma.work`, Sanoma removes accents from the name, lowercases it, and replaces runs of other characters with dashes. It uses the directory name the same way if the company name yields no slug.

`--you` and `--email` default to Git’s `user.name` and `user.email`. The host sends sign-in codes to that email. Your person ID comes from your GitHub login if `gh` is signed in, or from your local username otherwise. Sanoma uses `founder` if that ID is empty, reserved, or already taken.

Sanoma writes independent `SANOMA_SIGNING_KEY` and `SANOMA_SECRETS_KEY` values to `.env`, keeping existing values. With no database URL it runs [its own Postgres](/hosting/postgres/). It commits the generated files on `main` as your Git user, with the message `Start a Sanoma company`. Pre-existing dotfiles stay out of the commit.

The installer uses the package manager named by `npm_config_user_agent`, defaulting to pnpm. It pins Sanoma and each template connector to their exact release versions and adds the lockfile to the first commit.

## Running it

Open the local address printed in the terminal and [run your first workflow](/start/first-workflow/). The sample uses the Outbound collection. If you also want to use chat, open the Anthropic connector page and enter your key before sending a message.

## When it stops

If Git or the Git user is missing, setup stops before writing any files. An invalid `--email` also stops setup before any write, with exit code 2. If the directory contains more than dotfiles and has no `sanoma.config.ts`, `sanoma init` refuses it and exits 2.

If dependency installation fails, the initial commit remains. Install the dependencies in that repo and run `sanoma` again.

Sanoma Cloud sign-up uses the same template. The release workflow (`release.yml`) publishes it with pinned versions and a lockfile to [Sanoma-AI/company-template](https://github.com/Sanoma-AI/company-template).
