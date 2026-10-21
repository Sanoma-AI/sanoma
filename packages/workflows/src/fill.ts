import { createHash } from "node:crypto";
import { faker } from "@faker-js/faker";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import { z } from "zod";

// Made-up values for zod schemas: scenarios' inputs. Internal.

setFaker(faker);

/** Seeds the generator from a name, so one name always makes up the same values. */
export const seedFrom = (name: string) => seed(createHash("sha256").update(name).digest().readUInt32BE(0));

/** The schema's value with every field `given` does not set made up, parsed by the schema. */
export function fill(schema: z.ZodType, given: Record<string, unknown>): unknown {
  return schema.parse({ ...(fake(schema) as object), ...given });
}

/** An object schema's fields by name; none for any other schema. */
export const shapeOf = (schema: z.ZodType): Record<string, z.ZodType> =>
  schema instanceof z.ZodObject ? schema.shape : {};

/** The schema of a field an object schema does not name, when it takes such fields (`z.looseObject`, `.catchall`). */
export function restOf(schema: z.ZodType): z.ZodType | undefined {
  const rest = schema instanceof z.ZodObject ? (schema.def.catchall as z.ZodType | undefined) : undefined;
  return rest instanceof z.ZodNever ? undefined : rest;
}

/** The object schema under `schema`'s optional, nullable and default wrappers, if it is one. */
export function objectUnder(schema: z.ZodType): z.ZodObject | undefined {
  let inner = schema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable || inner instanceof z.ZodDefault) {
    inner = inner.unwrap() as z.ZodType;
  }
  return inner instanceof z.ZodObject ? inner : undefined;
}

/** A mistake in code (ours, or a fake's), not in what it was given: thrown as it is, never reported as data. */
export const isBug = (err: unknown) =>
  err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError;
