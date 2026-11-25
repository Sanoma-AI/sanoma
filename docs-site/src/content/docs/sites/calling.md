---
title: Calling operations and workflows
description: "Call a workflow or operation from a site and handle the result, an approval, or a refusal."
sidebar:
  order: 6
---

Import `api` from `sanoma/site` to call company workflows and operations as the person on the page. `sanoma` and `sanoma check` generate `.sanoma/api.ts` from the config. It gives you a typed member for each workflow, direct operation, and collection. Without that file, `api` is untyped.

Each path maps to a name sent through one server function, `callFn`, as a POST with `{ name, input?, id? }`. The generator (`writeApi` in `sanoma/workflows/describe`) augments `Register` with `declare module "sanoma/site" { interface Register { api: … } }`. The site entry re-exports `WorkflowFn`, `OpFn`, `CollectionApi`, `Saved`, and `ListQuery`.

## Calls

| Call                                                                                          | What it does                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.data.outbound.list({ order })`, `.get({ key })`, `.save({ record })`, `.delete({ key })` | A collection's operations, directly; a write is in the ledger, and `updatedBy` is the person                                                                                                                                                              |
| `api.stripe.customers.get({ id })`                                                            | A vendor's read, directly: an operation `describeConfig` marks `direct` (a vendor's write is refused: start a workflow)                                                                                                                                   |
| `api.operations.quote.run({ service, hours })`, `api.operations.crm.score.run(…)`             | A [company operation](/workflows/your-own-operations/#from-a-page), directly, when every operation it uses may be                                                                                                                                         |
| `await api.outboundNext({ company })`                                                         | Starts `outbound-next` (a workflow's name in camelCase) and answers its output once the run ends, or rejects with its error                                                                                                                               |
| `api.outboundNext.start(input)`                                                               | Starts it: `{ runId }`                                                                                                                                                                                                                                    |
| `.result(runId, waitMs?)`                                                                     | The run's output, waiting at most 20 s; `run_running` when it has not ended, a 422 with its failure when it failed. The workflow's [`opaque`](/reference/workflow-runtime/#output-for-the-starter-alone) fields are `"<name>"` unless you started the run |
| `.latest()`, `.runs({ limit })`                                                               | The newest finished run's `{ runId, output, at }` (null when none has), its `opaque` fields `"<name>"`, and its latest runs                                                                                                                               |
| `.approvals(runId)`, `.ledger(runId)`                                                         | What the run's page shows; a run of another workflow is `run_not_found`                                                                                                                                                                                   |

## Visitors and other clients

A visitor of a public site (`isVisitor`: signed in through a visitor login, or `anonymous`) calls the same way, where a policy `permit` lets it ([policies](/policies/policies/)), with less to read: `.result` only of a run it started (another's is `run_not_found`), never `.latest`, `.runs`, `.approvals` or `.ledger` (`policy_denied`), and none of the runtime's own workflows (`invalid_input`). Later: read actions in the policy, so a rule can let a visitor read more.

A client that is not the app's page (Sanoma Cloud's connector, say) calls the same way over plain JSON: `POST /api/call` with the body `{ name, input?, id? }` answers the call's output as JSON (`null` for none), or a refusal's status with its body (below). On a public site's host `/api/call` is the app's, not a page of the site's; any method but `POST` is refused (405).

A request with `Authorization: Bearer sca_…` is taken only there (on the app's own host it is refused, 401): it acts as its token, a visitor, and is not checked for CSRF, since it carries no cookie's authority; a token this company did not mint, or one revoked, is refused (401).

Any other request is checked as a page's is: one that says nothing of where it comes from (no `Origin`, `Sec-Fetch-Site` or `Referer`, as Node's `fetch` sends) is refused (403, `{ error }`), so a client that is not a browser sends the host's own origin in `Origin`, as [`sanoma call`](/reference/commands/#from-a-terminal-or-an-agent) does; a browser cannot forge it for another site's page. On a public site's host such a request is the site's visitor, as the site's page is: the one its login verifies, else `anonymous`.

On this machine, `x-sanoma-agent` beside `x-sanoma-actor` makes the call a declared agent's on the person's behalf, as on [`/mcp`](/start/agents-over-mcp/) below (refused on a host, 400; without it, the call is the person's).

## Refusals

Each operation call and workflow start gets a new ID from `crypto.randomUUID()`. IDs can contain letters, digits, `_`, and `-`. A start uses its ID as the run ID. A retry of the same request reuses the ID, while a person trying a failed write again gets a new one.

Every call needs an actor. During server rendering, the loader calls the operation in process as the person who requested the page. A refusal throws `ApiError`. Use its `body.code` to select the appropriate response below. See [Login](/sites/login/).

| `code`             | Status | When                                                                                                                                                                                                                 |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`    | 400    | Nobody said who is asking, the name is no operation or workflow, the operation is not direct, or the input does not match its schema (`issues`)                                                                      |
| `policy_denied`    | 403    | The policy denied the call, or a visitor asked for a workflow's runs or the description                                                                                                                              |
| `approval_pending` | 409    | The policy holds the call for an approval: `runId` is the run of the built-in `call` workflow that makes it once approved, in the Inbox and at `/workflows/call/runs/<runId>`; `api.call.result(runId)` waits for it |
| `run_running`      | 409    | `.result` waited and the run has not ended (`runId`)                                                                                                                                                                 |
| `record_changed`   | 409    | A collection's `save` with `ifRecord` found the record changed since it was read, or gone: nothing was written; `current` is the record as it stands, when the runtime says                                          |
| `run_not_found`    | 404    | No such run of that workflow                                                                                                                                                                                         |
| (the run's)        | 422    | `.result` of a run that failed or was cancelled: `error` is its failure, `code` its code if it has one (`driver_failed`), `runId` the run; a code with a status of its own (`policy_denied`) answers with that       |

`sanoma/site` exports `ApiError` (`status`, and `body`, an `ErrorResponse`: `error`, `code`, and `issues`, `runId` and the rest as the code has them) and `errorBodyOf(err)`, the body when `err` is an `ApiError` and `undefined` otherwise, so a page branches on a code without a cast. A held write is `approval_pending`, with the `runId` of the run that makes it once approved:

```tsx
import { api, errorBodyOf } from "sanoma/site";

/** Marks the company won, or says where the change waits for its approval. */
async function markWon(company: string): Promise<string> {
  try {
    await api.data.outbound.save({ record: { company, stage: "won" } });
    return "Saved";
  } catch (err) {
    const body = errorBodyOf(err);
    if (body?.code === "approval_pending") return `Waiting for approval: /workflows/call/runs/${body.runId}`;
    throw err;
  }
}
```

## What a site calls

`describeConfig` reads what each site calls from its pages' source, parsed and never run, since they are browser code (`readSites`, in `sanoma/workflows/describe`: the site's outline, as a workflow has one): a workflow's page and a collection's list the sites' pages that call them under **Used by**, and a call to a workflow, collection or operation the config does not have, or to an operation a page may not call directly, fails `sanoma check`.

A page links there only when this build serves it. Name what a site calls in its code (`<RunForm workflow="announce" />`, `api.announce.start(…)`, `api.data.outbound.list()`): a name held in a variable or built at run time is not read, so its page is not listed.
