/**
 * The schema document `GetSchema` returns (`formatVersion` 1), as provider-bridge's README
 * describes it. Keys are sorted; optional flags are absent rather than false.
 */
export interface SchemaDocument {
  /** Registry source address, e.g. `integrations/github`. */
  source: string;
  version: string;
  /** Negotiated plugin protocol major version: 5 or 6. */
  protocol: number;
  formatVersion: 1;
  providerConfig: Block;
  /** `provider_meta`, for the few providers that have one. */
  providerMeta?: Block;
  resources: Record<string, ResourceSchema>;
  dataSources: Record<string, ResourceSchema>;
}

export interface ResourceSchema {
  /** The version the provider stamps on state it writes; `read` upgrades older state. */
  schemaVersion: number;
  block: Block;
}

export interface Block {
  attributes: Record<string, Attribute>;
  blocks: Record<string, NestedBlock>;
  description?: string;
  descriptionKind?: DescriptionKind;
  deprecated?: boolean;
}

export type DescriptionKind = "plain" | "markdown";

/**
 * A cty type in its JSON form: `"string"`, `"number"`, `"bool"`, `"dynamic"`, `["list", T]`,
 * `["set", T]`, `["map", T]`, `["object", { name: T }]` (with optional attribute names as a third
 * element) or `["tuple", [T, ...]]`.
 */
export type CtyType =
  | "string"
  | "number"
  | "bool"
  | "dynamic"
  | readonly ["list" | "set" | "map", CtyType]
  | readonly ["object", Record<string, CtyType>]
  | readonly ["object", Record<string, CtyType>, readonly string[]]
  | readonly ["tuple", readonly CtyType[]];

export interface Attribute {
  /** Always present; for a nested attribute it is the implied object type. */
  type: CtyType;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  sensitive?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  description?: string;
  descriptionKind?: DescriptionKind;
  /** Plugin protocol 6 only: per-child flags of a nested attribute. */
  nestedType?: NestedType;
}

export interface NestedType {
  nesting: "single" | "list" | "set" | "map";
  attributes: Record<string, Attribute>;
  minItems?: number;
  maxItems?: number;
}

export interface NestedBlock {
  /** A `list` or `set` with `maxItems: 1` is SDKv2's way of saying "one object". */
  nesting: "single" | "group" | "list" | "set" | "map";
  block: Block;
  minItems?: number;
  maxItems?: number;
}

/** Parses a schema document, refusing a `formatVersion` this client does not know. */
export function parseSchema(json: string): SchemaDocument {
  const doc = JSON.parse(json) as SchemaDocument;
  if (doc.formatVersion !== 1) {
    throw new Error(`schema document formatVersion ${String(doc.formatVersion)} is not supported (want 1)`);
  }
  return doc;
}
