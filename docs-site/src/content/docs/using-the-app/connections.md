---
title: "Manage vendor connections"
description: "Find the connector a workflow uses and manage its accounts and credentials."
sidebar:
  order: 7
---

Open **Connectors** and select the vendor. Check the installed operations and the accounts available to them. For the names a workflow can select in code, see [named connections](/workflows/credentials/#named-connections).

## Connectors

The connector list shows the title, logo, and ID of each vendor supplying operations to the config (never the built-in `sanoma` and `data`, which call nothing outside: a workflow's vendors and New run's "Calls … for real" leave them out too), how many operations it has and how many workflows use it, and, when its drivers declare environment variables, whether it is configured or how many variables it needs, each linking to its page, under Installed, with its tier (Official for an `@sanoma-ai/` package, else Community).

Under Available, the connector packages on npm that the config does not install, found by the `sanoma-connector` keyword and shown by the `sanoma` field of each one's latest version (title, and logo files the server reads from jsDelivr and checks as an installed connector's are, shown as images only), with its tier, description and version; nothing is stored, and npm is read at most every 10 minutes. Choosing one opens the steps to add it (`?add=<package>`): `pnpm add`, the import in `sanoma.config.ts`, then its credentials; there is no install button.

When npm cannot be reached, a notice says only the installed connectors show. Above Installed, **Yours** lists the company's [own operations](/workflows/your-own-operations/#in-the-app), each opening its page (`/connectors/operations/<name>`).
Open `/connectors/<vendor>` for the vendor’s [named connections](/using-the-app/connections/#connection-management), plus links to its connector's npm package and source (from `defineConnector`'s `package` and `homepage`, when it gives them), its resource types, and each operation with its effect, whether it is safe to retry, its description, its contract (input and output as JSON Schema), its scenario `phrases`, the scenarios with a step about it (each marked as seeding it, making it fail, expecting it or saying it must not be called, and linking to its workflow's New run in Sandbox mode with it chosen), and the workflows that may call it; a feature file that cannot be read says why above the operations, as on a workflow's page.

A vendor with workflow operations whose connector attaches no fake (its `VendorEntry`'s `fake`) says "Its connector attaches no fake" once, above its operations; one with only a resource type's `read` and `import` needs none, since those read real state and a sandbox run never calls them.

## Connection management

`/connectors/<vendor>` renders named connection requirements from code and the admitted person's account metadata. Each card shows its name, authentication method, verified account and grants, required scopes, owner, binding status, last change, and the selected store/namespace/path with management ownership. A changed binding shows its previous destination so the person can review the move. Loading cards reads metadata only; **Test** deliberately checks the provider. Health is labeled with its last-check time, not presented as continuous monitoring.

A card links the workflows found in code to select that account literally or through its declared default. Calls whose selector is only known at runtime are marked as possible dependencies. This is a static reading of workflow code, not a complete execution history or a promise that every listed workflow will use the account.

**Connect** and **Replace credentials** generate password controls from the authentication input schema, with JSON entry for structured fields. Fields start empty; schema defaults and examples never populate them. **Verify and review** checks policy, verifies the account and grants, then shows the destination and any change from the previous account or location. **Save connection** revalidates the review, reserves the account as pending, writes through the selected store and verifies activation under policy.

During this process the previous binding can become unavailable; the card reports pending or uncertain outcomes rather than claiming success. A location change retains the previous stored value and is not a transfer.

Credential values live only in the open form and secure server requests. They do not enter query or mutation caches, browser storage, URLs, chat, workflow history, approval records or ledger records. Closing the dialog or completing Save clears the form. When policy holds an action, its notice links to the approval run; decide it there and retry the same action in the still-open form. Closing that form requires entering the credentials again.

Externally managed bindings and read-only stores offer **Review connection**, not replacement fields. Replace or renew values at the displayed management location, then **Test**. For a pasted credential, **Disconnect** invalidates the Sanoma binding; it does not delete its stored value or revoke access at the vendor. An OAuth grant's Disconnect and Revoke are described below. Dynamic **Connect account** choices appear only for code-defined rules the person may use; the runtime also enforces policy and ownership.

A method without account verification cannot be connected here. Externally renewed OAuth bundles can be reviewed where their verifier and store support it.

### Connection methods and renewal

The page lists every way to connect the vendor, so a connector with both an OAuth method and a pasted token (Supabase) shows both. An OAuth method's **Connect account** (or **Reconnect**) asks for the company's OAuth application, its client ID and secret, the first time; later attempts can leave both empty to reuse the stored one. **Continue to `<vendor>`** opens the provider in a new tab. The page that started it shows the attempt: waiting for consent, storing the grant, waiting for an approval (with a link to the run), connected, or failed with a plain reason.

The provider sends the person back to `/connect/<vendor>/callback`, which checks that this browser started the attempt (a signed cookie per attempt, `sanoma_connect_<key>` named by its state's hash, sent only to `/connect`) and its state. It seals the code into the attempt and starts the `connect` run. Then it redirects to `/connectors/<vendor>` with the attempt's ID. Its URL never carries the code or state onward, and it logs no query string.

A refused callback comes back as `?error=` with one of `expired`, `mismatch`, `replayed`, `declined`, `rejected` or `failed`, shown as a sentence, never the provider's words. The card then shows the account, its scopes and when access is valid until. A store that cannot keep a grant (read-only or without conditional writes) disables Connect and says why.

The runtime [renews a grant](/workflows/credentials/#renewal-reconnect-disconnect-and-revoke) on its own, and the card shows it: **Valid until**, **Renewed** with the time of the last renewal (and the next one scheduled, for a provider whose refresh tokens lapse unused), and the last renewal's failure when it failed.

A renewal that may have spent the refresh token without storing the new grant marks the account **uncertain**, and one the provider refused (revoked or rejected) marks it **needs reconnect**; both explain that **Reconnect** asks for new consent, which replaces the grant whole. **Test** verifies the grant, renewing it first when it is due. **Disconnect** deletes the grant Sanoma keeps and keeps the OAuth application, so the next account can reuse it.

**Revoke**, shown when the connector can revoke at the provider (Supabase can), asks the provider to revoke the grant and then disconnects; it is its own policy decision (`sanoma.connection.revoke`), and nothing changes when the provider does not confirm.

### Secret storage

**Secret storage**, shown on the connector list and setup page, reports the effective provider, namespace, bindings, ownership and bootstrap readiness. These settings come from code, so selecting another store is a code change; **Move**, below, carries the values to it. For the built-in store, the panel explains its separately supplied encryption key; it does not expose the key. [Supabase Vault](https://github.com/Sanoma-AI/sanoma/blob/main/connectors/supabase/README.md#supabase-vault-as-the-secret-store) is available as a configured provider adapter.

When the config names other stores (`secrets.stores`), the panel moves the secrets to one of them ([Moving between stores](/reference/secret-stores/#moving-between-stores)): choose the destination and the rollback window, review the plan (each secret's kind, what happens to it and its size; never a value; the destination's problems refuse the start), then start the `migrate-store` run. The panel follows it: writes to the current store paused, the copies read back, then the code change to make, `secrets` selecting the destination, which the move waits for and cuts over on.

After the switch it shows the rollback window and, once it ends, the retired old copies. Cancel stops a move before its cutover. Connections whose OAuth application differs at the destination are flagged to reconnect.

The operator agent's `connection_status` tool reads account requirements and last-tested metadata with a link to `/connectors/<vendor>`. It does not fetch credentials or test a provider. The agent directs people to secure input and never asks them to paste a key, password or OAuth token into chat.
