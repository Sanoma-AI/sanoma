# packages/workflows/src/tfschema

OpenTofu provider schemas as Sanoma resources, at `@sanoma/workflows/tfschema` (`../tfschema.ts`). A connector for a vendor with an OpenTofu provider keeps the provider's schema document (recorded by provider-bridge) and a hand-owned `resources.config.ts`; its `pnpm generate` runs `cli.ts` to write `src/resources.gen.ts`, which is checked in. Its driver uses `fromTfState` and `toTfState` at run time.

## Contents

| Path                         | What it is                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`types.ts`](types.ts)       | The schema document's types, the generated types (`TfResourceType`, `TfShape`) and `ResourcesConfig` |
| [`ctyToZod.ts`](ctyToZod.ts) | The cty type to zod mapping table, as source text                                                    |
| [`generate.ts`](generate.ts) | `generateResources`: a schema document and a config to the text of `resources.gen.ts`                |
| [`state.ts`](state.ts)       | `fromTfState` and `toTfState`: between the provider's state and the resource's shape                 |
| [`cli.ts`](cli.ts)           | The `pnpm generate` entry: reads the files, writes `resources.gen.ts`; no network                    |

## What is generated

For each type `resources.config.ts` lists, `resources.gen.ts` exports `<type> = { typeName, schemaVersion, schema, fields, shape }`:

- `schema`: a `z.object` in the resource's shape. cty types map as the table in `ctyToZod.ts` says; required attributes are required and the rest `.nullish()` (the provider's state holds `null` for unset); a description becomes `.describe()`, and `deprecated` goes into `.meta()`. Nested blocks become objects (`single`, `group`, and a list or set with `maxItems: 1`, SDKv2's way of saying "one object"), arrays (other lists and sets) or records (`map`). Nested attributes (protocol 6) keep their children's own flags.
- `fields`: `vendorOwned` for attributes that are `computed` and not `optional` (never drift); `writeOnly` for `sensitive` or `writeOnly` ones, or ones holding such a child; `immutable` from the config, plus any whose description says it forces a new resource. Paths are dotted for nested fields (`pages.html_url`).
- `shape`: the state's layout, so `fromTfState` can turn a block of one into an object and drop secrets, and `toTfState` can turn it back, with every attribute present.

The config's `sha256` (the provider release's pin, from provider-bridge's `testdata/pins.json`) goes into the exported `provider`, which the driver passes to the bridge.

`pnpm generate` on a clean tree changes nothing: the output depends on the two files only, and is formatted with oxfmt.
