---
title: "Resource type reference"
description: "Look up defineResource options, operations, references, and drift comparison rules."
sidebar:
  order: 9
---

Connector authors use `defineResource` to define the resource type. It derives the operations that Sanoma calls to work with objects of that type.

```ts
import { defineConnector, defineResource } from "sanoma/workflows";

export const repository = defineResource({
  vendor: "github",
  type: "repository",
  title: "Repository",
  identity: "name", // optional, with `find`: how `find` makes the identity, for people
  schema, // a z.object: the fields a read returns, and a data file declares (less the vendor-owned ones)
  fields: { immutable: [], vendorOwned: ["html_url", "node_id"], writeOnly: [], unordered: ["topics"] }, // and `references`, below
  find: ({ name }) => name, // optional: the import id that finds a declared resource before it is bound
  bindingId: (state) => String(state.node_id), // optional: the stable id a binding keeps; default `String(state.id)`
  normalize, // optional: the part of a state a drift check compares; default `compareDeclared`
  writable: true, // optional: apply may change its objects (the change operations, below)
  stateless: true, // optional: its objects hold no data, so apply makes one gone again without asking
  afterCreate: [{ op: "acme.repository.protect", input: ({ id, export: name }) => ({ id }), until: (out) => out.ok }], // optional
});
export const github = defineConnector("github", { repository });
```

## Resource operations

A resource type is a connector's group under its own `type`; `defineConnector` refuses one of another vendor, or under another key, or on a connector without `info.package` (data files import the types from `<package>/resources`), and keeps the list on the connector, beside its vendor info.

Its operations are `<vendor>.<type>.import` (`{ id }`, an identity or a binding id) and `<vendor>.<type>.read` (`{ id, state?, handle? }`, a state from an earlier call), both answering `{ id, gone: true }` when the vendor has no such object and `{ id, gone: false, state, handle? }` when it has, both effect `read`, idempotent, with the id as the policy's `target`. "Missing" is part of the contract: the driver decides it, so a caller never parses a vendor's error for it.

A driver implements them like any other. `handle` is the driver's own data about the object, opaque to everyone else, passed back unchanged (an OpenTofu driver keeps the provider's private data and state version in it); the operations declare it `opaque`, so the ledger records it as `"<handle>"`, never its bytes. Any operation may name such fields (`opaque` in its spec), and a nested one by a dotted path that goes into each item of a list (`attachments.content`: each attachment's name kept, its bytes recorded as `"<content>"`).

A `writable` type has four change operations besides. The built-in apply workflow (`APPLY_WORKFLOW`, `"apply"`, a name a config's own workflow may not take) calls them for the declared resources, and only it changes a declared object; any workflow may name them in its `uses` and call them for an object no data file declares, as a control plane makes and deletes a host per customer.

Such a call is an ordinary write, held to the policy and recorded in the ledger like any other, and a run of any workflow but apply is refused (`invalid_input`, before the policy is asked) the call aimed at a declared object: an `update` or `delete` whose `id` the lockfile binds, or a `create` whose identity (what the type's `find` makes of `desired`) a data file declares or the lockfile binds. A direct call of one is refused as for any write.

`plan` (effect `read`, idempotent) takes `{ id?, state?, handle?, desired? }` (no `id` for a create, no `desired` for a delete) and returns `{ action, planned?, unknown, replace }`: `none`, `create`, `update`, `replace` or `delete`, the new state without write-only fields, the dotted paths known only after apply, and those whose change replaces the object.

`create` (effect `write`, `target` `new:<vendor>.<type>`) takes `{ desired }` and returns `{ id, state, handle? }`, `id` its binding id; `update` takes `{ id, state?, handle?, desired, expect? }` and returns the same, refusing with a `DriverError` whose `vendorCode` is `plan_changed` when the fresh plan's `action` or `replace` differs from `expect`; `delete` (idempotent) takes `{ id, state?, handle? }` and returns `{ id, gone: true }`, an object already gone included.

`desired` may hold secret markers at write-only fields, which the driver resolves (`resolveSecrets`) just before the vendor call (`plan` stores no generated secret: one not stored yet gets a throwaway value); no output holds a write-only value.

## Declaring and referencing objects

Calling the type declares one resource, which is what a data file does: `repository({ owner: "acme", name: "sanoma" })` returns a frozen `Declared`, `{ vendor: "github", type: "repository", name: "acme/sanoma", desired: { owner: "acme", name: "sanoma" }, refs: {} }`, branded with its `<vendor>.<type>` under the `DECLARED` symbol. It refuses a field the schema does not have, a field the vendor owns (unless `identity` names it), a value the schema rejects, or an empty identity.

A type without `find` (Stripe's, whose objects Stripe names) declares resources without a `name`: they are found only by their bindings ([below](/workflows/resources/#bindings)).

A field may name another declared resource where the type's `fields.references` says so, by dotted path, with the type it names and, in `by`, the fields of that resource the vendor may hold there instead: GitHub's `branch_protection` has `{ repository_id: { type: "github.repository", by: ["name", "node_id"] } }`, since GitHub holds a rule's repository by its node id. So `branch_protection({ repository_id: site, pattern: "main" })` takes the repository `site`.

It stands for that resource's `name`: `desired` holds `repository_id: "acme/website"` (a GitHub repository's identity is `<owner>/<name>`), which the schema and `find` (the rule is `acme/website:main`) read, and a drift check takes any of the repository's `by` values, read in the same run, as that name; and `refs` says where a resource was named, `{ repository_id: "github.repository:acme/website" }` (a list item's path has its index, `teams.0`).

Anywhere else, or of another type, a resource is refused, and the constructor's type (`Declaring`) says the same, so the editor marks it first. A resource whose type has no identity (a Neon project, which Neon names) stands for nothing a vendor could read, so only a field the runtime consumes by the reference itself may name it: a host's database, as `cloudflare.host({ database: store })` does, or a `from` reference.

Then `desired` holds nothing there and `refs` has the type alone, `{ database: "neon.project" }`, the loaded resource's `refs` the declaration's id, `resources/sanoma/infra.ts#store`.

A reference with `from`, a dotted path in the named resource's state, takes that state instead: apply and drift give the field the resource's state at that path, as a whole (a list or an object), read in the same run or made by an earlier step of it. So a sending domain's DNS records go to the zone that holds them, the record set's type declaring `{ records: { type: "resend.domain", from: "dns_records" } }`:

```ts
export const mail = resend.domain({ name: "sanoma.work" });
export const mailDns = cloudflare.records({ zone: "sanoma.work", name: "resend", records: mail });
```

The resource stands for the whole field, never an item of a list (`records: [mail]` is refused), and a literal value is still allowed there; a reference has `from` or `by`, not both, and is refused at a write-only field or one that holds a write-only field. Resolving a config refuses a `from` path that is no field of a type the reference may name (`checkFromRefs`), naming that type's fields. `desired` holds the resource's `name` in its place, which the schema does not judge, and the declaration is applied after it.

## Dependencies during an apply

Where the same apply changes the resource at that path (creates or replaces it, or updates it with the path in its plan's `unknown` or another value planned there; an update that touches other fields, such as a domain's re-verify, changes nothing here), or, for a create, the resource has no state yet or nothing at that path, the value is known only after apply: the plan is given `null` there, so a type that takes a `from` field must accept `null` in its `plan` and report the path in `unknown`, and its `update` must keep what the vendor holds for a field left out of `desired`, and a change the new value makes (a replaced domain's new DKIM key) is planned, and approved, with the rest; an update or replace step carries those paths in its own `unknown`.

A plan of a bound object whose resource is absent, gone or unreadable and not about to change is given its fields without it, as drift compares them, and its step runs without it. A step planned with the field `null` is planned again at its step, with the value now known: `none` (the value turned out unchanged) leaves it done without a write, and otherwise its update expects the fresh plan's action and replace, since the approval covered the change in kind.

An empty list or object at the path counts as known: a vendor that answers `[]` while still filling the list makes the dependent write an empty one. At its step the field takes the resource's state as the earlier step left it; one planned `null` whose value is still not known, as when the resource's own step failed or waited, fails before its driver is called: `its records come from resources/mail.ts#mail, which has no state yet` (or `whose state has no dns_records yet`), and so does a step down the chain from it.

A policy and an approval therefore see `null` for such a field: its value comes from another declared resource's state at the vendor, known after apply.

Drift compares the field against the bound resource's state, read in the same run, and leaves it out while that resource is absent, gone, unreadable or has nothing at the path, which its own row reports. A bridge-backed type (`tfConnector`) cannot take a `from` field yet: an OpenTofu provider's plan reads `null` as unset, not as known after apply.

`dnsRecord` (`DnsRecord`), from the main entry, is the shape a DNS record passes in between two connectors: `{ type: "TXT" | "MX" | "CNAME" | "CAA", name, content, priority?, ttl? }`, `name` the full name in lower case with no trailing dot, a TXT record's `content` unquoted (each refused otherwise, never rewritten), and `ttl` 1 for automatic.

Later, not yet: the cases apply hard-codes, a wakeup's `host` (its host's `outputs(state).url`) and a host's `source` (a repository's clone URL, by its `by` fields), could be `from` references, once `from` can name a host's outputs as well as its state.

## Comparing declared fields

Only declared fields are compared for drift, as CloudFormation does: `compareDeclared(fields, state, desired)` keeps the fields `desired` declares, minus `vendorOwned` and `writeOnly` ones, picking objects field by field, list items against the declared item at the same index, and the items of an `unordered` list (a set) against what any declared item declares, sorted, so a set is compared as a multiset whatever order the vendor returns it in.

A drift check compares `normalize(actual, desired)` with `normalize(desired, desired)`, leaf by leaf: `diffDeclared(resource, state, desired, accept?)` returns each declared field that differs, `{ path, desired, actual }`, where `accept` gives, by a reference's path, the values that stand for the resource it names. `withoutWriteOnly(fields, desired)` drops write-only values from a declaration, keeping a secret's marker, which names a stored value and holds none.

So a field left out is never drift, which covers attributes an OpenTofu provider marks `computed` and `optional` (GitHub's `etag`, `topics`): they are the user's to set, so not `vendorOwned`, but the vendor fills them in when nobody does.

`describeConfig` lists the resource types as `resourceTypes`, each `{ id: "<vendor>.<type>", vendor, type, title, identity, fields, schema, ops, capabilities?, host? }`: `schema` is its state as JSON Schema, with `$id` `sanoma:resource-type/<id>`, which its operations' contracts `$ref` rather than repeat; `capabilities` the contracts it meets (`host`, `database`, `wakeup`, `source`), absent when it meets none; and `host`, for a host only, `{ lifetime }`, its `HostLifetime` (`long-lived` or `stops-on-exit`), which Hosting shows on the Host's card.

`sanoma/workflows/shared` exports the `Resource`, `ResourceSpec`, `ResourceFields`, `References`, `FieldReference`, `Declared`, `Declaring`, `DeclaredResource` and `ResourceProblem` types.
