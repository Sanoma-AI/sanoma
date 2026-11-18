---
title: The wakeup service
description: "An instance whose worker stops when nothing can run (a host that scales to zero) still has what is due at a time."
sidebar:
  order: 6
---

An instance whose worker stops when nothing can run (a host that scales to zero) still has what is due at a time: a schedule's next run, a sleep until a date. The wakeup service keeps that time for it while it is stopped, and calls the instance's `GET {url}/wake` then; any answer but a 2xx is tried again (after 1 s, 2 s, 4 s and so on, at most 5 minutes apart) until one is, so a wake is late at worst, never lost. `sanoma wakeup` runs it on its own; a config with `wakeup: true` runs it inside `sanoma serve` instead, its routes in the app (as sanoma-ops does for its customers). It keeps its two tables, `sanoma_wakeup_accounts` and `sanoma_wakeup_instances`, in that database, and only the sha256 of each token.

## Accounts and instances

Whoever runs it mints an account with `sanoma wakeup account <label>`, which prints `{"id","token"}` on stdout (or `mintAccount(label)` on [`startWakeupService`](/hosting/hosts/#the-wakeup-service)); its token (`swa_…`) registers instances: `POST /wakeup/instances { url, token }` takes the instance's own token (`swi_` and 43 or more base64url characters), which the company minted (`/setup` does, as `SANOMA_WAKEUP_TOKEN`), and answers `201 { id }`; posted again by the same account, the token names the same instance, now at the URL given, and answers `200 { id }` (its registered wake kept only when the URL is unchanged), and another account's is a 409; `GET` and `DELETE /wakeup/instances/{id}` with the account's token show and remove one. Before it stops, the instance sends `PUT /wakeup/wake { at }` with its own token, which names it: a 204, which replaces what it registered. A wake is resume if stopped, so one that a retry or a replaced registration sends early or twice starts at most a worker with nothing to do. Every response is JSON and `no-store`; a missing or unknown token is a 401, another account's instance a 403, a bad body a 400.

## Using it from a company

A company uses one through the runtime's own wakeup, `sanoma.wakeup({ host })` (`import { sanoma } from "sanoma/resources"`), which every config with a host type has, no connector installed: `/setup` asks for the service's URL and an account's token (`SANOMA_WAKEUP_URL`, `SANOMA_WAKEUP_ACCOUNT_TOKEN`), and going live declares it when the host's own vendor has no wakeup of its own, the host given `SANOMA_WAKEUP_URL` and `SANOMA_WAKEUP_TOKEN`.
