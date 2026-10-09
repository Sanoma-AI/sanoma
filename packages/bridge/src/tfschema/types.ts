import type { ResourceFields } from "@sanoma/workflows";
import type { z } from "zod";
import type { ProviderRef } from "../bridge.ts";
import type { NestedBlock } from "../schema.ts";

// What `resources.gen.ts` declares, and its hand-owned input. The schema document's own types
// (`SchemaDocument`, `Block`, `Attribute`, ...) are `@sanoma/bridge`'s, from `../schema.ts`.

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
  readonly nesting: NestedBlock["nesting"];
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

/** The provider a `resources.gen.ts` was generated from: its pinned release and plugin protocol. */
export type TfProvider = Readonly<ProviderRef> & { readonly protocol: number };

/** A connector's `resources.config.ts`: which resource types to generate, and what the schema does not say. */
export interface ResourcesConfig {
  /**
   * The provider's source, such as `integrations/github`. Its version and sha256 come from the
   * pins (`@sanoma/bridge`'s `testdata/pins.json`), its schema from the recorded schema of that
   * release beside them.
   */
  provider: string;
  /** The provider's resource type names to generate, such as `github_repository`. */
  types: string[];
  /**
   * Per type, the attributes whose change replaces the object (ForceNew in the provider's
   * source), by dotted path for nested ones (`pages.source`). The schema does not say.
   */
  immutable?: Record<string, string[]>;
}
