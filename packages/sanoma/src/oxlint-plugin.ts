// The oxlint JS plugin `sanoma`, loaded by this package's `oxlint.json` from `dist/`, inside this
// package (a path into another package's directory would depend on how an installer lays out
// `node_modules`): `@sanoma-ai/workflows/plugin`'s rules `data-file` and `date`, and `site-file`
// (`site-lint.ts`).
import workflows from "@sanoma-ai/workflows/plugin";
import { siteFile } from "./site-lint.ts";

const plugin: { meta: { name: string }; rules: Record<string, unknown> } = {
  ...workflows,
  rules: { ...workflows.rules, "site-file": siteFile },
};
export default plugin;
