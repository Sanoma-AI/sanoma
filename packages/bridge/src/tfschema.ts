// `@sanoma/bridge/tfschema`: OpenTofu provider schemas as Sanoma resources. The generator that
// writes a connector's `resources.gen.ts`, and the state conversions its driver uses at run time.
// No Node built-ins here: the CLI that reads and writes files is `tfschema/cli.ts`, the
// package's `sanoma-tfschema` bin.
export { ctyToZod } from "./tfschema/ctyToZod.ts";
export { generateResources, type GenerateSources } from "./tfschema/generate.ts";
export { fromTfState, toTfState } from "./tfschema/state.ts";
export type { ResourcesConfig, TfBlockShape, TfProvider, TfResourceType, TfShape } from "./tfschema/types.ts";
