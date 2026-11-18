import { describe, expect, test } from "vitest";
import { readReference } from "./reference.ts";

/** The connectors with no operation for a workflow: each gives the chat a model or a coding agent. */
const NO_OPERATIONS = ["anthropic", "openai", "opencode", "pi"];

describe("the connector reference", () => {
  test("lists each connector's operations with their schemas", async () => {
    const reference = await readReference();
    // A connector whose operations stop reaching its export would get a page that says it has none.
    expect(reference.filter(({ operations }) => operations.length === 0).map(({ slug }) => slug)).toEqual(
      NO_OPERATIONS,
    );
    for (const connector of reference) {
      expect(connector.package, connector.slug).toMatch(/^@sanoma-ai\/connector-/);
      for (const operation of connector.operations) {
        expect(operation.input, operation.id).toHaveProperty("$schema");
        expect(operation.output, operation.id).toHaveProperty("$schema");
      }
    }
  });
});
