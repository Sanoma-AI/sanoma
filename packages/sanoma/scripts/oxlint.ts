// Writes this package's `oxlint.json`, the lint a company repo's `.oxlintrc.json` extends: run by
// `build`, before tsc. It is self-contained, with no `extends` into `node_modules` (which the
// installer lays out), made of:
// - `@sanoma-ai/workflows`'s `oxlint.json` (its overrides for `workflows/**`, `policies/**` and
//   `resources/**`), with an entry for `sanoma` derived from `@sanoma-ai/workflows`'s (the same
//   names), `sanoma/**` refused, and the data-file plugin loaded from this package's `dist/`;
// - the rules this checkout holds its own code to (the root `.oxlintrc.json`), without its test
//   framework's and its own paths.
import { readFileSync, writeFileSync } from "node:fs";

type Json = Record<string, any>;
const read = (path: string): Json => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const own = read("../package.json").name as string;
const workflows = read("../node_modules/@sanoma-ai/workflows/oxlint.json");
const root = read("../../../.oxlintrc.json");

const overrides = (workflows.overrides as Json[]).map((override) => {
  const rule = override.rules["no-restricted-imports"] as [string, { paths: Json[]; patterns: Json[] }] | undefined;
  if (rule === undefined) {
    return override.jsPlugins ? { ...override, jsPlugins: ["./dist/oxlint-plugin.js"] } : override;
  }
  const [severity, { paths, patterns }] = rule;
  const author = paths.find((p) => p.name === "@sanoma-ai/workflows")!;
  return {
    ...override,
    rules: {
      ...override.rules,
      "no-restricted-imports": [
        severity,
        {
          paths: [
            ...paths,
            {
              ...author,
              name: own,
              message: `A workflow or policy imports only these and types from ${own}: the rest (defineConfig, the ledger stores) belongs in sanoma.config.ts, where the drivers and credentials are. Ask for approval with \`ctx.approval\`.`,
            },
          ],
          patterns: [
            ...patterns,
            {
              group: [`${own}/**`],
              message: `\`${own}\` has no entry points for a workflow: import its names from \`${own}\` itself.`,
            },
          ],
        },
      ],
    },
  };
});

const config = {
  plugins: (root.plugins as string[]).filter((p) => p !== "vitest"),
  categories: root.categories,
  env: root.env,
  rules: Object.fromEntries(Object.entries(root.rules as Json).filter(([name]) => !name.startsWith("vitest/"))),
  ignorePatterns: (root.ignorePatterns as string[]).filter((p) => p.startsWith("**/")),
  overrides,
};

writeFileSync(new URL("../oxlint.json", import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
