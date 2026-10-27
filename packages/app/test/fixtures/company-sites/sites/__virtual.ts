// Written by sanoma: the sites the app mounts under /sites. Do not edit.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const apps = join(here, "..", "apps");

/** The folders of `dir` whose names match `name`, `within` one when given. */
const folders = (dir: string, name: RegExp, within?: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && name.test(d.name) && (!within || existsSync(join(dir, d.name, within))))
        .map((d) => d.name)
    : [];

/** The sites in `dir` (`at` from here), mounted under `/<prefix><name>`. */
const mounts = (dir: string, at: string, prefix: string) =>
  folders(dir, /^[a-z][a-z0-9-]*$/, "routes").map((name) => ({
    type: "physical" as const,
    directory: `${at}${name}/routes`,
    pathPrefix: `/${prefix}${name}`,
  }));

export default () => [
  ...mounts(here, "", ""),
  ...folders(apps, /^[a-z][a-z0-9]*$/).flatMap((app) =>
    mounts(join(apps, app, "sites"), `../apps/${app}/sites/`, `${app}/`),
  ),
];
