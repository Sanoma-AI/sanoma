import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Connector, resolveConfig } from "sanoma/workflows";
import { expect, it } from "vitest";

// The box image (`box/Dockerfile`) installs the agents its `agents.json` lists, which the build
// reads with no install of the workspace: here it is held to the own coding agents the connectors
// declare, so a connector's new agent or version reaches the next image.

const connectors = fileURLToPath(new URL("../../../connectors/", import.meta.url));

it("lists in box/agents.json every connector's own coding agent, as the connector declares it", async () => {
  // Every connector that says it has a coding agent, as its package.json does.
  const withAgent = readdirSync(connectors).filter((dir) => {
    const manifest = join(connectors, dir, "package.json");
    return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).sanoma?.agent;
  });
  // Its one connector, beside a constant or two.
  const loaded = await Promise.all(
    withAgent.map(async (dir) => {
      const module: Record<string, unknown> = await import(pathToFileURL(join(connectors, dir, "src/index.ts")).href);
      return Object.values(module).filter((value): value is Connector<any, any> => typeof value === "object");
    }),
  );
  const { agents } = resolveConfig({ workflows: [], connectors: loaded.flat() });
  const declared = [...agents]
    .flatMap(([id, { own }]) => (own ? [{ id, packages: own.packages, setup: own.setup, bin: own.bin }] : []))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const listed = JSON.parse(readFileSync(new URL("../box/agents.json", import.meta.url), "utf8"));
  expect(listed).toEqual(declared);
});
