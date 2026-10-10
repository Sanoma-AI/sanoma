import { createHash } from "node:crypto";
import { faker } from "@faker-js/faker";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import { z } from "zod";

// Made-up values for zod schemas: scenarios' inputs, and each operation's sample call in
// `describeConfig`. Internal, and apart from `scenario.ts`, so `describe` does not load Gherkin.

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

/** A mistake in code (ours, or a fake's), not in what it was given: thrown as it is, never reported as data. */
export const isBug = (err: unknown) =>
  err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError;
