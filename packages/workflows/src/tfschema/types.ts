import type { z } from "zod";
import type { ResourceFields } from "../resource.ts";

// The schema document provider-bridge serves (`formatVersion: 1`; see its README, "The schema
// document"), as far as code generation reads it. `@sanoma/bridge` exports the same shape as
// `SchemaDocument`.

/** A cty type in its JSON form: `"string"`, `["list", "string"]`, `["object", { a: "bool" }]`. */
export type CtyType =
  | "string"
  | "number"
  | "bool"
  | "dynamic"
  | readonly ["list" | "set" | "map", CtyType]
  | readonly ["object", Readonly<Record<string, CtyType>>]
  | readonly ["object", Readonly<Record<string, CtyType>>, readonly string[]]
  | readonly ["tuple", readonly CtyType[]];

export interface TfAttribute {
  type: CtyType;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  sensitive?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  description?: string;
  descriptionKind?: "plain" | "markdown";
  /** A nested attribute (protocol 6): `type` is its implied object type, and this carries each child's flags. */
  nestedType?: TfNestedType;
}

export interface TfNestedType {
  nesting: "single" | "list" | "set" | "map";
  attributes: Record<string, TfAttribute>;
  minItems?: number;
  maxItems?: number;
}

export interface TfBlock {
  attributes: Record<string, TfAttribute>;
  blocks?: Record<string, TfNestedBlock>;
  description?: string;
  descriptionKind?: "plain" | "markdown";
  deprecated?: boolean;
}

export interface TfNestedBlock {
  nesting: "single" | "group" | "list" | "set" | "map";
  block: TfBlock;
  minItems?: number;
  maxItems?: number;
}

export interface TfSchemaDocument {
  source: string;
  version: string;
  protocol: number;
  formatVersion: number;
  providerConfig: TfBlock;
  resources: Record<string, { schemaVersion: number; block: TfBlock }>;
  dataSources: Record<string, { schemaVersion: number; block: TfBlock }>;
}

/**
 * How a resource type's state is laid out, for converting between the provider's state and the
 * resource's shape (`fromTfState`, `toTfState`). Generated beside each schema.
 */
export interface TfShape {
  /** Every attribute, in the provider's order: the provider's state has each one, `null` when unset. */
  readonly attributes: readonly string[];
  /** Attributes whose value never leaves the driver: sensitive or write-only, or holding one. */
  readonly secret?: readonly string[];
  readonly blocks?: Readonly<Record<string, TfBlockShape>>;
}

export interface TfBlockShape {
  readonly nesting: TfNestedBlock["nesting"];
  /** A list or set block of at most one item (SDKv2's way of saying "one object"): an object in the resource's shape. */
  readonly one?: boolean;
  readonly shape: TfShape;
}

/** One resource type, as `resources.gen.ts` declares it. */
export interface TfResourceType<S extends z.ZodObject = z.ZodObject> {
  /** The provider's name for it, such as `github_repository`. */
  readonly typeName: string;
  /** The version of the provider's state layout, which `read` passes back so old state is upgraded. */
  readonly schemaVersion: number;
  /** The resource's shape: blocks of one item are objects, everything the vendor may leave unset is nullish. */
  readonly schema: S;
  readonly fields: ResourceFields;
  readonly shape: TfShape;
}

/** The provider a `resources.gen.ts` was generated from. */
export interface TfProvider {
  readonly source: string;
  readonly version: string;
  readonly protocol: number;
  /** The sha256 of the release's `SHA256SUMS`, from `resources.config.ts`, which the bridge pins it by. */
  readonly sha256?: string;
}

/** A connector's `resources.config.ts`: which resource types to generate, and what the schema does not say. */
export interface ResourcesConfig {
  /** The provider's pin: the sha256 of its release's `SHA256SUMS` (provider-bridge `testdata/pins.json`). */
  sha256?: string;
  /** The provider's resource type names to generate, such as `github_repository`. */
  types: string[];
  /**
   * Per type, the attributes whose change replaces the object (ForceNew in the provider's
   * source). The schema does not say; attributes whose description says "forces a new
   * resource" are added to these.
   */
  immutable?: Record<string, string[]>;
}
