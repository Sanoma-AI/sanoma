---
title: The wakeup service
description: "Wake a stopped worker when its next scheduled run or sleep deadline is due."
sidebar:
  order: 6
---

A worker can stop while it waits for a schedule or a sleep deadline. The wakeup service keeps the deadline and calls `GET {url}/wake` when it arrives. If the response is outside the 2xx range, the service retries after 1 second, then 2, then 4, up to 5 minutes between attempts. It keeps trying until the instance acknowledges the wake.

Run `sanoma wakeup` for a standalone service. To serve its routes inside `sanoma serve`, set `wakeup: true` in the config, as sanoma-ops does for its customers. The service uses two tables in its database, `sanoma_wakeup_accounts` and `sanoma_wakeup_instances`. It stores only the SHA-256 hash of each token.

## Accounts and instances

Create an account with `sanoma wakeup account <label>`, which prints `{"id","token"}` on stdout. The programmatic equivalent is `mintAccount(label)` on [`startWakeupService`](/hosting/hosts/#the-wakeup-service). The account token (`swa_…`) manages registrations. Each company mints its own instance token through `/setup` as `SANOMA_WAKEUP_TOKEN`. It starts with `swi_` followed by at least 43 base64url characters.

| Request                                        | Token    | Result                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /wakeup/instances` with `{ url, token }` | Account  | Registers the instance and returns `201 { id }`. Registering the same instance token under the same account updates the URL and returns `200 { id }`. A URL change clears the pending wake. An instance token owned by a different account returns 409. |
| `GET /wakeup/instances/{id}`                   | Account  | Shows the registration.                                                                                                                                                                                                                                 |
| `DELETE /wakeup/instances/{id}`                | Account  | Removes the registration.                                                                                                                                                                                                                               |
| `PUT /wakeup/wake` with `{ at }`               | Instance | Replaces the deadline and returns 204. The instance sends this before stopping.                                                                                                                                                                         |

A wake resumes the worker if it has stopped. An early or duplicate wake can therefore start an idle worker but cannot start the scheduled work twice merely by waking it. Responses use JSON and `no-store`. An unknown or missing token returns 401, access to another account’s instance returns 403, and an invalid request body returns 400.

## Using it from a company

In a config with a host type, use `import { sanoma } from "sanoma/resources"` and declare `sanoma.wakeup({ host })`. The runtime supplies this resource. Enter the service URL and account token in `/setup` (`SANOMA_WAKEUP_URL` and `SANOMA_WAKEUP_ACCOUNT_TOKEN`). When you go live, Sanoma declares this resource if the host vendor has no wakeup service of its own. The host receives `SANOMA_WAKEUP_URL` and the instance’s `SANOMA_WAKEUP_TOKEN`.
