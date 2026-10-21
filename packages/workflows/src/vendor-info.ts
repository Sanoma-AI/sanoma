import { readFileSync } from "node:fs";
import { z } from "zod";
import type { VendorInfo } from "./op.ts";

/**
 * The `sanoma` field of a connector's package.json: the vendor's name and its logo files, beside
 * package.json. The app reads the same field from npm to list connectors not installed.
 */
export const SanomaPackageField = z.object({
  title: z.string().min(1),
  logo: z.string().optional(),
  logoDark: z.string().optional(),
});

/**
 * A connector's `VendorInfo`, read from its own package.json, the one place it is written: the
 * package's `name` and `homepage`, and the `sanoma` field's `title` and logo files, such as
 * `"sanoma": { "title": "Ghost", "logo": "logo.svg", "logoDark": "logo-dark.svg" }`. The app
 * lists connectors not installed from the same field on npm. `moduleUrl` is a module one folder
 * below the package root, its `src/` or `dist/`: `vendorInfo(import.meta.url)`.
 */
export function vendorInfo(moduleUrl: string | URL): VendorInfo {
  const root = new URL("../", moduleUrl);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8").trim();
  const pkg = JSON.parse(read("package.json")) as { name: string; homepage?: string; sanoma?: unknown };
  const field = SanomaPackageField.safeParse(pkg.sanoma);
  if (!field.success) throw new Error(`${pkg.name}: package.json needs a "sanoma" field with a title`);
  const { title, logo, logoDark } = field.data;
  return {
    title,
    ...(logo && { logo: { svg: read(logo), ...(logoDark && { dark: read(logoDark) }) } }),
    package: pkg.name,
    ...(pkg.homepage && { homepage: pkg.homepage }),
  };
}
