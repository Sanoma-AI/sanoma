// Written by sanoma: the sites the app mounts under /sites. Do not edit.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default () =>
  readdirSync(here, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[a-z][a-z0-9-]*$/.test(d.name) && existsSync(join(here, d.name, "routes")))
    .map((d) => ({ type: "physical" as const, directory: `${d.name}/routes`, pathPrefix: `/${d.name}` }));
