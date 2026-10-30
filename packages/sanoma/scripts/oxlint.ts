// Writes this package's `oxlint.json`, the lint a company repo's `.oxlintrc.json` extends: run by
// `build`, before tsc. It is self-contained, with no `extends` into `node_modules` (which the
// installer lays out), made of:
// - `@sanoma-ai/workflows`'s `oxlint.json` (its overrides for `workflows/**`), with an entry for `sanoma` derived from `@sanoma-ai/workflows`'s (the same
//   names), `sanoma/**` refused, and the plugin (`date`) loaded from this package's `dist/`;
// - an override for `sites/**`: a site is client code, reaching the app through `sanoma/site` and
//   `sanoma/ui` alone, with no server, runtime, connector or environment of its own (the plugin's
//   `site-file` says the rest);
// - the rules this checkout holds its own code to (the root `.oxlintrc.json`), without its test
//   framework's and its own paths.
import { readFileSync, writeFileSync } from "node:fs";
import { REMEDY } from "../src/site-lint.ts";

type Json = Record<string, any>;
const read = (path: string): Json => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const own = read("../package.json").name as string;
const workflows = read("../node_modules/@sanoma-ai/workflows/oxlint.json");
const root = read("../../../.oxlintrc.json");

const overrides = (workflows.overrides as Json[]).map((given) => {
  const override = given.jsPlugins ? { ...given, jsPlugins: ["./dist/oxlint-plugin.js"] } : given;
  const rule = override.rules["no-restricted-imports"] as [string, { paths: Json[]; patterns: Json[] }] | undefined;
  if (rule === undefined) return override;
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
              message: `A workflow imports only these and types from ${own}: the rest (defineConfig, the ledger stores) belongs in sanoma.config.ts, where the drivers and credentials are. Ask for approval with \`ctx.approval\`.`,
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

const SERVER = `A site has no server code: ${REMEDY}`;
const APP =
  "A site imports how a page looks from `sanoma/ui` and what talks to the app (its route APIs, `api`, `RunForm`, `useActor`) from `sanoma/site`; the rest of the app is its server.";
const sites = {
  files: ["sites/**", "apps/*/sites/**"],
  // The listing of the sites the build generates.
  excludeFiles: ["sites/__virtual.ts"],
  jsPlugins: ["./dist/oxlint-plugin.js"],
  rules: {
    // Types are erased at build: a site may import them from anywhere.
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...[own, "@sanoma-ai/workflows", "@sanoma-ai/bridge", "pg"].map((name) => ({ name, message: SERVER })),
          { name: "@sanoma-ai/app", message: APP },
          {
            name: "@tanstack/react-start",
            message: `${SERVER} Its route APIs (\`Link\`, \`useNavigate\`, …) come from \`sanoma/site\`, and \`createFileRoute\` from \`@tanstack/react-router\`.`,
          },
        ].map((path) => ({ ...path, allowTypeImports: true })),
        patterns: [
          {
            group: [
              `${own}/**`,
              `!${own}/site`,
              `!${own}/ui`,
              `!${own}/claims`,
              "@sanoma-ai/workflows/**",
              "@sanoma-ai/bridge/**",
              "@dbos-inc/**",
              "pg/**",
              "@tanstack/react-start/**",
            ],
            message: SERVER,
          },
          { group: ["@sanoma-ai/app/**"], message: APP },
          {
            group: ["@sanoma-ai/testing", "@sanoma-ai/testing/**"],
            message: `Fakes and test helpers belong in tests. ${SERVER}`,
          },
          {
            group: ["@sanoma-ai/connector-*", "@sanoma-ai/connector-*/**"],
            message: `A site calls no vendor itself, so the policy sees every call: ${REMEDY}`,
          },
          { group: ["node:*"], message: `A site runs in the browser: ${REMEDY}` },
          {
            group: ["virtual:*", "virtual:*/**"],
            message: "A site reads content through `content` from `sanoma/site`.",
          },
        ].map((pattern) => ({ ...pattern, allowTypeImports: true })),
      },
    ],
    "no-restricted-globals": [
      "error",
      { name: "process", message: `A site runs in the browser and holds no credentials: ${REMEDY}` },
      { name: "require", message: `A site runs in the browser and imports with \`import\`: ${REMEDY}` },
    ],
    "sanoma/site-file": "error",
  },
};

const config = {
  plugins: (root.plugins as string[]).filter((p) => p !== "vitest"),
  categories: root.categories,
  env: root.env,
  rules: Object.fromEntries(Object.entries(root.rules as Json).filter(([name]) => !name.startsWith("vitest/"))),
  ignorePatterns: (root.ignorePatterns as string[]).filter((p) => p.startsWith("**/")),
  overrides: [...overrides, sites],
};

writeFileSync(new URL("../oxlint.json", import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
