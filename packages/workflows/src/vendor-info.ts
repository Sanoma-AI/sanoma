import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { VendorInfo } from "./op.ts";
import { upFrom } from "./paths.ts";

/** A logo file's path in the package: relative, never out of it (`..`), an SVG. */
const LogoFile = z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.svg$/, "a relative path to an .svg file in the package");

/**
 * The `sanoma` field of a connector's package.json: the vendor's name and its logo files, beside
 * package.json. The app reads the same field from npm to list connectors not installed.
 */
export const SanomaPackageField = z.object({
  title: z.string().min(1),
  logo: LogoFile.optional(),
  logoDark: LogoFile.optional(),
});

/**
 * A connector's `VendorInfo`, read from its own package.json, the one place it is written: the
 * package's `name` and `homepage`, and the `sanoma` field's `title` and logo files, such as
 * `"sanoma": { "title": "Ghost", "logo": "logo.svg", "logoDark": "logo-dark.svg" }`. The app
 * lists connectors not installed from the same field on npm. `moduleUrl` is any module of the
 * package, whose nearest package.json is read: `vendorInfo(import.meta.url)`.
 */
export function vendorInfo(moduleUrl: string | URL): VendorInfo {
  const from = dirname(fileURLToPath(moduleUrl));
  const root = upFrom(from, (dir) => (existsSync(join(dir, "package.json")) ? dir : undefined)) ?? from;
  const read = (path: string) => readFileSync(join(root, path), "utf8").trim();
  const pkg = JSON.parse(read("package.json")) as { name: string; homepage?: string; sanoma?: unknown };
  const field = SanomaPackageField.safeParse(pkg.sanoma);
  if (!field.success) {
    throw new Error(
      `${pkg.name}: package.json needs a "sanoma" field with a title, and logos as .svg paths in the package: ${z.prettifyError(field.error)}`,
    );
  }
  const { title, logo, logoDark } = field.data;
  return {
    title,
    ...(logo && { logo: { svg: read(logo), ...(logoDark && { dark: read(logoDark) }) } }),
    package: pkg.name,
    ...(pkg.homepage && { homepage: pkg.homepage }),
  };
}
