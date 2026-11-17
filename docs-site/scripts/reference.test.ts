import { describe, expect, test } from "vitest";
import { connectorDirs, readReference } from "./reference.ts";

describe("the connector reference", () => {
  test("has a page for every connector, each operation with its schemas", async () => {
    const reference = await readReference();
    expect(reference.map(({ slug }) => slug)).toEqual(connectorDirs());
    for (const connector of reference) {
      expect(connector.package, connector.slug).toMatch(/^@sanoma-ai\/connector-/);
      for (const operation of connector.operations) {
        expect(operation.input, operation.id).toHaveProperty("$schema");
        expect(operation.output, operation.id).toHaveProperty("$schema");
      }
    }
    // A connector that stops exporting its operations would empty its page without failing a build.
    expect(reference.filter(({ operations }) => operations.length > 0).length).toBeGreaterThan(10);
  });
});
