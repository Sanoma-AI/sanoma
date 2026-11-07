import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fill, seedFrom } from "../src/fill.ts";

describe("fill", () => {
  const schema = z
    .object({
      id: z.guid().optional(),
      reference: z.string().min(1).optional(),
      subject: z.string().min(1),
      groups: z.array(z.string().min(1)),
    })
    .refine(({ id, reference }) => id === undefined || reference === undefined, "Pass id or reference, not both");

  it("makes up the required fields and leaves the optional ones out, whatever the seed", () => {
    for (let i = 0; i < 50; i++) {
      seedFrom(`seed ${i}`);
      const made = fill(schema, { subject: "visitor:scenario:visitor" }) as Record<string, unknown>;
      expect(made.subject).toBe("visitor:scenario:visitor");
      expect(Array.isArray(made.groups)).toBe(true);
      expect("id" in made).toBe(false);
      expect("reference" in made).toBe(false);
    }
  });

  it("keeps an optional field that is given", () => {
    seedFrom("given");
    const made = fill(schema, { reference: "fixture:acme", subject: "s" }) as Record<string, unknown>;
    expect(made.reference).toBe("fixture:acme");
    expect("id" in made).toBe(false);
  });
});
