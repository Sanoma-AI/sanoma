import { secret as fromWorkflows } from "@sanoma-ai/workflows/resources";
import { describe, expect, it } from "vitest";
import { secret } from "../src/resources.ts";

describe("sanoma/resources", () => {
  it("is where a data file imports secret from", () => {
    expect(secret).toBe(fromWorkflows);
    expect(secret("DB_PASSWORD", { generate: true })).toEqual({ $secret: "DB_PASSWORD", generate: true });
  });
});
