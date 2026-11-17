import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { readReference } from "./reference.ts";

const connectors = readdirSync(fileURLToPath(new URL("../../../connectors", import.meta.url)), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("the connector reference", () => {
  test("has a page for every connector, each operation with its schemas", async () => {
    const reference = await readReference();
    expect(reference.map(({ slug }) => slug).toSorted()).toEqual(connectors.toSorted());
    for (const connector of reference) {
      expect(connector.package, connector.slug).toMatch(/^@sanoma-ai\/connector-/);
      for (const operation of connector.operations) {
        expect(operation.id, connector.slug).toBe(`${connector.vendor}.${operation.resource}.${operation.name}`);
        expect(operation.input, operation.id).toHaveProperty("$schema");
        expect(operation.output, operation.id).toHaveProperty("$schema");
      }
    }
    // A connector that stops exporting its operations would empty its page without failing a build.
    expect(reference.filter(({ operations }) => operations.length > 0).length).toBeGreaterThan(10);
  });
});
