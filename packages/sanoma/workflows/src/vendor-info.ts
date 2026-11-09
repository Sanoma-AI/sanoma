import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AGENT_ID, type VendorInfo } from "./op.ts";
import { upFrom } from "./paths.ts";

/** A logo file's path in the package: relative, never out of it (`..`), an SVG. */
const LogoFile = z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.svg$/, "a relative path to an .svg file in the package");

/**
 * The `sanoma` field of a connector's package.json: the vendor's name and its logo files, beside
 * package.json, and its coding agent's id, name and mark files (the logo's when it gives none) when
 * it has one. The app reads the same field from npm to list connectors not installed.
 */
export const SanomaPackageField = z.object({
  title: z.string().min(1),
  logo: LogoFile.optional(),
  logoDark: LogoFile.optional(),
  agent: z
    .object({
      id: z.string().regex(AGENT_ID, "lowercase letters, digits and dashes, neither loop nor acp-…"),
      title: z.string().min(1),
      mark: LogoFile.optional(),
      markDark: LogoFile.optional(),
    })
    .optional(),
});

/**
 * A connector's `VendorInfo`, read from its own package.json, the one place it is written: the
 * package's `name` and `homepage`, and the `sanoma` field's `title` and logo files, such as
 * `"sanoma": { "title": "Ghost", "logo": "logo.svg", "logoDark": "logo-dark.svg" }`, with
 * `"agent": { "id", "title", "mark", "markDark" }` for a connector with a coding agent, whose
 * mark is the logo when it names none. The app
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
  const { title, logo, logoDark, agent } = field.data;
  const svg = (path: string) => {
    try {
      return read(path);
    } catch {
      throw new Error(`${pkg.name}: the "sanoma" field's logo ${path} is not in the package`);
    }
  };
  const svgs = (light: string, dark?: string) => ({ svg: svg(light), ...(dark && { dark: svg(dark) }) });
  const logos = logo && svgs(logo, logoDark);
  const mark = agent?.mark ? svgs(agent.mark, agent.markDark) : logos;
  return {
    title,
    ...(logos && { logo: logos }),
    package: pkg.name,
    ...(pkg.homepage && { homepage: pkg.homepage }),
    ...(agent && { agent: { id: agent.id, title: agent.title, ...(mark && { mark }) } }),
  };
}
