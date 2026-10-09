# packages/bridge/src/tfschema

OpenTofu provider schemas as Sanoma resources, at `@sanoma/bridge/tfschema` (`../tfschema.ts`). A connector for a vendor with an OpenTofu provider keeps a hand-owned `resources.config.ts` naming the provider and the types it wants; its `pnpm generate` runs `cli.ts` (the package's `sanoma-tfschema` bin) to write `src/resources.gen.ts`, which is checked in. Its driver converts states with `fromTfState` and `toTfState` at run time.

## Contents

| Path                         | What it is                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`types.ts`](types.ts)       | What is generated (`TfResourceType`, `TfShape`, `TfProvider`) and its input, `ResourcesConfig`            |
| [`ctyToZod.ts`](ctyToZod.ts) | `ctyToZod`: a cty type as zod source text, with the mapping table as its doc comment                      |
| [`generate.ts`](generate.ts) | `generateResources`: a schema document, a config and the pinned release to the text of `resources.gen.ts` |
| [`state.ts`](state.ts)       | `fromTfState` and `toTfState`: between the provider's state and the resource's shape                      |
| [`cli.ts`](cli.ts)           | `sanoma-tfschema <resources.config.ts> <resources.gen.ts> [--fixtures <dir>]`; importing it runs nothing  |

## What is generated

For each type `resources.config.ts` lists, `resources.gen.ts` exports `<type> = { typeName, schemaVersion, schema, fields, shape }`, and `provider`, the release (`source`, `version`, `sha256`, `protocol`):

- `schema`: a `z.object` in the resource's shape. cty types map as `ctyToZod`'s table says; required attributes are required and the rest `.nullish()` (the provider's state holds `null` for unset); a description becomes `.describe()`, and `deprecated` goes into `.meta()`. Nested blocks become objects (`single`, `group`, and a list or set with `maxItems: 1`, SDKv2's way of saying "one object"), arrays (other lists and sets) or records (`map`). Nested attributes (protocol 6) keep their children's own flags.
- `fields`: `vendorOwned` for attributes that are `computed` and not `optional` (never drift); `writeOnly` for `sensitive` or `writeOnly` ones, or ones holding such a child; `immutable` from the config, whose paths are checked against the schema. Paths are dotted for nested fields (`pages.html_url`).
- `shape`: the state's layout, so `fromTfState` can turn a block of one into an object and drop secrets, and `toTfState` can turn it back, with every attribute present.

The release comes from the pins (`testdata/pins.json`, or `<dir>/pins.json` with `--fixtures <dir>`), and the schema document from that release's recorded schema beside them (`schemas/<ns>_<type>_<version>.json`), so a pin, its schema and the generated code change together. `immutable` is a static list: the schema has no ForceNew flag. A future `plan` RPC on the bridge would report `requires_replace` per change instead.

`pnpm generate` on a clean tree changes nothing: the output depends on the config, the pin and the schema only, and is formatted with oxfmt.
