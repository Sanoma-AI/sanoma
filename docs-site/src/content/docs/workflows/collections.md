---
title: Collections
description: "Define company records, read and write them in workflows, and apply schema changes to existing data."
sidebar:
  order: 5
---

Use a collection for records the company owns, such as the leads on an Outbound board. In `resources/data.ts`, call `collection()` from `sanoma/data` with a name, key, and typed fields. Start the name with a lowercase letter and use letters and digits after it. Each [app](/start/apps/#apps) can declare collections in its own file. Its folder name scopes those collections.

```ts title="resources/data.ts"
import { collection } from "sanoma/data";

export const outbound = collection({
  name: "outbound",
  key: "company", // a required text field
  fields: {
    company: "text",
    stage: { enum: ["researched", "contacted", "won", "lost"] },
    owner: "person",
    lastTouched: { type: "date", optional: true },
  },
});

export const customers = collection({ name: "customers", key: "id", fields: { id: "text", name: "text" } });

export const orders = collection({
  name: "orders",
  key: "number",
  fields: {
    number: "text",
    customer: { link: "customers" }, // the key of a record of customers
    extra: { type: "json", optional: true }, // free-form: any JSON value
  },
});
```

## Fields and links

A field is `"text"`, `"number"`, `"boolean"`, `"date"` (ISO 8601: a date, or a date and time with its offset), `"person"` (a person's id) or `"json"` (free-form: any JSON value, typed `JsonValue`), `{ type, optional: true }`, `{ enum: [...] }` or `{ link: "<collection>" }` (both optional too). A free-form field holds what the record gives it, unchecked, and `list` and `count` neither filter nor sort by it (their schemas refuse it in `where` and `order`).

A link holds the key of a record of another collection, named as written in the same folder (`{ link: "customers" }` in `apps/crm/` links to `crm.customers`); `resolveConfig` refuses a link to a collection the config lacks (`The collection "orders" links its field "customer" to "customers", which no collection is named: declare it, or change the link`), so a draft that deletes or renames a linked collection fails its checks until the link changes too.

A save checks its links in its own transaction, the records they name locked against a delete (`for key share`) until it commits: one that names no record there refuses the save with a non-retryable `DriverError` (`vendorCode: "link_missing"`, status `422`, the message `customer: customers has no record "acme"`) whose `missing` lists `{ key, field, value, target }`; a batch checks once its every entry is written, so its order does not matter.

The database does not hold links to their records: deleting a customer leaves the orders that name it, which `get` and `list` answer with an issue at the link (`customers has no record "acme"`), and which save again once the link names a record or is cleared. The sandbox fake checks links the same way.

An optional field may be marked `hidden: true` (`isHidden`, from `sanoma/workflows/shared`): a column removed from the grid, kept in the declaration so its values stay and still read, which the app does not show; its schema is marked `deprecated`, so a form drawn from a workflow input that embeds the record leaves it out too. A hidden link is kept as it is too: a save does not check it and a read does not flag it, so a record whose hidden link names a deleted record still saves; shown again, it is checked again.

A record is typed by them (`RecordOf<typeof outbound.fields>`), and `save` refuses a field that is not declared. The config's `collections` lists them; `sanoma` adds every collection `resources/data.ts` exports when it loads the config, so a company's config lists none.

`resources/data.ts` is the data file the runtime imports as well as loads: the launcher imports it, and so does a workflow that names a collection's operations (`import { outbound } from "../resources/data.ts"`, the one file outside `workflows/` or `policies/` the workflow lint lets them import, found by its real path). So it holds collections only, `collection` imported from `sanoma/data`: a resource declared there, or a collection declared in another data file, is a [problem](/workflows/resources/#data-files).

## Collection operations

Their operations are of the vendor `data` (`DATA_VENDOR`, which no connector may take): `data.outbound.get` (`{ key }`: the record, or `null`), `.list` (`{ where?, order?, limit? }`: fields equal to a value or within `{ gt, gte, lt, lte }`, sorted by a field, or `-field` for descending, with missing values last, else by key; values compare as their field's type, text byte by byte (Postgres's `COLLATE "C"`, whatever the database's collation), and one of another type counts as missing; 1 to 1000 records, 100 by default), `.count` (`{ where? }`, as `list` takes it: `{ count }`), `.save` (`{ record, ifAbsent?, ifRecord? }`: added or replaced, optionally guarded by an absent key or matching record), `.saveMany` (`{ records?: [{ record, ifAbsent?, ifRecord? }], deletes?: [{ key, ifRecord? }] }`: saves and deletes together, all or none, see [batches](#batches)) and `.delete` (`{ key, ifRecord? }`: `{ key, deleted }`, refused like a save when `ifRecord` no longer matches).

`get`, `list` and `count` are effect `read`, `save`, `saveMany` and `delete` `write`, all idempotent, and the policy's `target` is `data:outbound/<key>` (`data:outbound` for a list, a count or a batch). A workflow names them in `uses` and calls them on `ctx`, as any operation:

```ts
uses: [outbound.get, outbound.save],
async run(ctx, { company }) {
  const lead = await ctx.data.outbound.get({ key: company });
  if (lead) await ctx.data.outbound.save({
    record: { ...lead.record, stage: "contacted" },
    ifRecord: lead.record,
  });
},
```

### Conditional writes

Use `save({ record, ifAbsent: true })` to claim a key atomically before creating external resources. An absent key is inserted. If the stored JSON record and `updatedBy` already match, the call returns the original `Saved` receipt, including its timestamp, so a retry after a lost response can recover. A different record or actor is refused with a non-retryable `DriverError` (`vendorCode: "record_exists"`, status `409`) whose `current` is the record there.

Object-property order and omitted `undefined` fields do not change JSON equality; the sandbox fake follows the same rule.

Use `save({ record: next, ifRecord: previous.record })` to replace an existing record only while its full JSON still matches the record read earlier. A missing or changed record is refused with a non-retryable `DriverError` (`vendorCode: "record_changed"`, status `409`) whose `current` is the record as it stands (a `Saved`), or `null` when it is gone, so the caller can settle the conflict without another read; a policy that lets someone save a record thereby lets them see it, so allow the collection's `get` wherever `save` is allowed.

An already-written `next` record from the same actor returns its original receipt, allowing recovery after a lost response. Do not combine `ifRecord` with `ifAbsent`. Omitting both keeps ordinary replacement behavior. A conflict does not automatically reload and overwrite the winner.

For a claim belonging to one provisioning run, declare a text field such as `claimRun` and include `claimRun: ctx.runId` in the initial record. Keep that value stable on retries and complete the claim before vendor effects. Subsequent transitions must check ownership and conditionally save the full prior record, retaining a run or generation identifier so a later transition cannot look like an earlier one. `ifRecord` compares contents; it is not a monotonic revision, expiring lease or lock held across vendor calls.

Managed Cloud consumer integration and lifecycle verification remain separate work in [#532](https://github.com/Sanoma-AI/sanoma/issues/532).

## Batches

Use `saveMany` for up to 1,000 entries (`BATCH_LIMIT`). Supply records to save and keys to delete, with each key appearing once. Saves accept the same conditions as `save`, including `ifAbsent` and `ifRecord`. The batch commits in one transaction. The response lists save receipts first and deletion results second, in request order within each group.

Policy evaluates each entry as a `save` or `delete` and sees the previous record as `before`. Each entry produces its own `op.called` ledger record with a target and decision. The history for a key therefore reads the same whether the change came from one save or a batch. In a scenario, assert `data.outbound.save` for the entry.

**Policy decisions.** A denied entry denies the batch with `policy_denied`. The `data.denied` field lists the affected keys and `data.deniedFor` gives each reason. A held entry holds the whole batch. Approval covers the batch and the held entries. If policy denies the batch when checked again, the ledger records the denial.

**Conflicts and retries.** If any entry fails its `ifRecord` or `ifAbsent` condition, the batch fails with a nonretryable `DriverError` (status `409`, `vendorCode: "record_changed"`). Its `conflicts` array lists each affected `{ key, current }`, with `null` for a missing record. If a repeated `delete` with `ifRecord` finds the record already gone, it returns `deleted: true`. This covers a run retry or a repeated direct call after incomplete recording.

**Scenario assertions.** Assert each entry’s `save` or `delete`. A `Then` naming the batch reports `data.outbound.saveMany is recorded as its entries`. The Permissions grid and the run form’s approval summary also evaluate individual entries.

The sandbox fake does the same in memory.

`get`, `list` and `save` answer `Saved` records, `{ key, record, updatedAt, updatedBy }`, where `updatedBy` is who the call was made as (`CallContext.by`: `run:<id>` inside a run, the person's id for a [direct call](/workflows/direct-calls/)). The records are JSON rows of one table the runtime creates beside the ledger, `sanoma_data` (`collection`, `key`, `record`, `updated_at`, `updated_by`), in the config's database.

A declaration changes with no migration: a record saved under an older one comes back as it is stored, with `issues` (`{ path, message }`) where the fields no longer accept it.

A sandbox run keeps the records in memory, in a fake that starts empty: a scenario seeds a record as it seeds a resource, `Given data.outbound "Acme" has` with a table of fields (the key is the quoted name, and what the table leaves out is made up), and removes one with `Given data.outbound "Acme" is gone`.

`describeConfig` lists them as `collections`, each `{ name, title?, key, fields, record, ops, declared? }`, `record` being the JSON Schema `save` accepts, with `$id` `sanoma:collection/<name>`, and `declared` where `resources/data.ts` declares it (`{ id, file, name, at }`, as `loadDataFiles` reads it), whose declaration the app's Hosting page opens. `sanoma/workflows/shared` exports `DATA_VENDOR` and the `Saved` and `ListQuery` types.

## A column change

A change to a collection's columns proposed from the app's grid edits its declaration (`patch`, below) and carries its plan, `TableChangePlan` (`{ collection, changes, rows }`, each change `add`, `rename`, `retype`, `require`, `hide`, `show`, `remove` or `convert`, with what it finds in the records: `empty`, `filled`, `wontConvert: { count, sample }`). Linking a text field to another collection is a retype to `{ link }`.

A rename, a retype, a key of a free-form field made a field of its own (`convert`: `{ field, key, to, type }`, the value under `key` moved to the new field `to`, `filled` counting the records that hold it) and a removal for good (`remove`: a hidden field's declaration deleted and its values with it, so its name is free again) bring the records along; the others change the declaration alone (`hide` sets `hidden: true` and keeps the values, `show` takes it off again).

The built-in operation `sanoma.records.reshape` (`recordsOps`, effect `write`, idempotent, target `data:<collection>`) does it: `{ collection, changes }` (`reshapeOf(plan)` makes it from a plan) answers `{ rows, changed, converted, cleared, kept }`.

In one transaction it reads the collection's records a page of 500 at a time, by key, each page locked `for update` as it is read and its changed records written before the next is read, so it holds one page in memory and a failure on any page undoes them all.

Each record it has read stays locked until the end, so a save of one waits for the reshape to finish (a new key is not waited for); it gives each change in turn (`reshaped`, from `sanoma/workflows/shared`): a rename moves the value to the new name where the new name holds none; a retype stores a value that reads as the new type as one (`converts`: a number from its digits, yes or no, a date as a `date` field takes it, text from a number, anything to free-form, a link from the key of a record of the collection it links to: for each page, only the keys its values name, read and locked in the same transaction, so a large collection linked to is never held in memory), and one that cannot convert is cleared or kept as it is, by the change's `decision` (`"clear"` or `"keep"`, keep when absent); a removal deletes the field's value from every record, each one that held a value counted as `cleared`; an empty value (`""`, `null`) is dropped.

It writes only the records that changed, as the run (`updatedBy`), so a second call changes nothing. The app's draft counts what will not convert with the same `reshaped`. A change that merges calls it after the merge, before the deploy; a `patch` without a remote calls it after the file is written; `reshape` (Try again, [Changes](/workflows/changes/)) calls it again for a change that merged without its records, which is safe however much of an earlier call landed.

No other workflow may (it rewrites records outside `data.<collection>.save` and the policy on it): `resolveConfig` refuses a company workflow that uses it, and a run's call of it outside `change`, `patch` and `reshape` fails. It has no fake: a sandbox run refuses it.

A save in the moment between the reshape and the worker starting again on the new declaration is still checked against the old one. The reshape runs first, then the worker is asked to start again (`WorkerOptions.reload`: for a change, when its deploy moves the checkout; for a `patch`, as its last step), which `sanoma serve` does a second later, once the run has ended, the app with it.

Until the new worker and app run, a save of that collection that sends no `ifRecord` (a workflow's, an api call's) is checked against the old fields and may write a record in the old shape (a value under the old name, or of the old type); one that sends the record it read (the grid's, the form's) is refused, since the record changed. Such a record shows as needs fixing under the new fields, and `reshapeChange` brings it along, the reshape being idempotent.

A change whose deploy does not move the checkout (`follow` skipped) leaves the old declaration running, and the window open, until the instance starts again.

## Importing a sheet

`import` (`IMPORT_WORKFLOW`) is a built-in workflow `resolveConfig` adds when the config has a collection: a sheet's rows into a collection, as a run of the person who starts it (the app's Import pages do).

Its input (`ImportInput`, refused at the start when it names a collection the config lacks, a field the collection lacks, a field twice, or no column for the key) is `{ collection, mapping, rows, people? }`: the rows under the sheet's header, each a list of cells as text, and for each column the field it fills (`{ field, values? }`, `values` turning a cell's text into the field's, such as `"In talks"` into `"meeting"` or a person's name into their id) or `null` to skip it; `people`, the declared ids, makes a person field refuse anyone else (none given or empty, any id is taken).

Each cell is trimmed, given its column's `values`, then read as its field's type (a number as JavaScript writes one; yes, no, y, n, true, false, 1 or 0; a date as ISO 8601, a day or a time with its offset; an enum's value as written; a free-form cell as the JSON it reads as, else as its text; a link's as its text, the key checked when the batch is saved); an empty cell fills nothing, so an update keeps the record's own value.

The run reads the rows (`importRows`, from `sanoma/workflows/shared`, which the app's Review page reads them with too), sorts them by key, and takes them `IMPORT_BATCH` (200) at a time: it lists the batch's range of keys (`gte` the first, `lte` the last, a page of `LIST_LIMIT.max` at a time), decides each row against the record there (`importEntry`: a new key added with `ifAbsent`, a key there updated with `ifRecord`, the row's fields over the record's others, nothing when that changes nothing), and saves the batch with `saveMany`.

A row the fields refuse, with no key or a key an earlier row has, one that leaves a new record's required field empty, or one over a record its fields refuse now is left as a problem. An entry the policy denies, one whose record changed since it was read, or one whose link names no record (`link_missing`), refuses its batch; the run leaves it as a problem and saves the batch again without it.

An entry the policy holds holds its batch, an approval in the Inbox like any run's; a rejection fails the run, the batches before it saved (the run's ledger lists them), and a record changed while the batch waited saves the batch again without it, which the policy decides again, so a hold asks again. A blank row is skipped, keeping its number. It answers `{ added, updated, unchanged, problems }`, each problem `{ row, key?, reason }`, `row` the sheet's (its header row 1).
