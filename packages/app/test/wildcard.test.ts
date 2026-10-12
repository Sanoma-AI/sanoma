import { describe, expect, it } from "vitest";
import { MAX_ROWS, wildcardHeader, wildcardRows } from "../src/graph/wildcard.ts";

const imports = [
  "github.branch_protection.import",
  "github.repository.import",
  "github.team_membership.import",
  "stripe.product.import",
  "stripe.webhook_endpoint.import",
];

describe("wildcardHeader", () => {
  it("names what is literal in the id after the vendor", () => {
    expect(wildcardHeader("*.*.import")).toBe("import");
    expect(wildcardHeader("github.*.create")).toBe("create");
    expect(wildcardHeader("*.repository.*")).toBe("repository");
    expect(wildcardHeader("*.*.*")).toBe("any operation");
  });
});

describe("wildcardRows", () => {
  it("labels each row by the segments the id has where the pattern is computed, the vendor to its logo", () => {
    const rows = wildcardRows("*.*.import", imports);
    expect(rows.map((r) => ("note" in r ? r.note : `${r.vendor} ${r.label}`))).toEqual([
      "github branch_protection",
      "github repository",
      "github team_membership",
      "stripe product",
      "stripe webhook_endpoint",
    ]);
    expect(rows[0]).toMatchObject({ id: "github.branch_protection.import" });
    expect(wildcardRows("*.repository.*", ["github.repository.import"])[0]).toMatchObject({ label: "import" });
    // Only the vendor computed: the rows would be bare, so they say the whole operation.
    expect(wildcardRows("*.repository.import", ["github.repository.import"])[0]).toMatchObject({
      label: "repository.import",
    });
  });

  it("collapses past MAX_ROWS, the last row saying how many more there are", () => {
    const many = Array.from({ length: MAX_ROWS + 3 }, (_, i) => `v.r${i}.read`);
    const rows = wildcardRows("*.*.read", many);
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows.at(-1)).toEqual({ note: "+4 more" });
    expect(wildcardRows("*.*.read", many.slice(0, MAX_ROWS))).toHaveLength(MAX_ROWS);
    expect(wildcardRows("*.*.read", many.slice(0, MAX_ROWS)).some((r) => "note" in r)).toBe(false);
  });

  it("gives an id that fits nothing one row, to say so", () => {
    expect(wildcardRows("*.*.import", [])).toEqual([{ note: "none the workflow uses" }]);
  });
});
