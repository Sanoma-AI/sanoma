import * as fromWorkflows from "@sanoma-ai/workflows/data";
import { describe, expect, it } from "vitest";
import * as data from "../src/data.ts";

describe("sanoma/data", () => {
  it("is where resources/data.ts imports collection from: everything @sanoma-ai/workflows/data exports", () => {
    expect(data).toEqual(fromWorkflows);
    expect(data.collection({ name: "leads", key: "id", fields: { id: "text" } }).save.id).toBe("data.leads.save");
  });
});
