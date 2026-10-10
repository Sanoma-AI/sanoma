// Data files that step outside the subset, one construct each: a name, its source, where the one
// problem is, and what the message says. The lint test and the reader test both check every row,
// and the shipped oxlint.json test lints them in a project of its own.

const GH = `import { github } from "@sanoma/connector-github/resources";\n\n`;

export const BAD_DATA_FILES: [name: string, source: string, at: string, message: RegExp][] = [
  [
    "assertion",
    `${GH}export const web = github.repository({ name: "web", visibility: "public" as const });\n`,
    "3:65",
    /^a type assertion is not allowed in a data file: leave it out/,
  ],
  [
    "call",
    `${GH}export const web = github.repository({ name: "Web".toLowerCase() });\n`,
    "3:46",
    /^a call is not allowed in a data file: write the value out/,
  ],
  [
    "computed",
    `${GH}export const web = github.repository({ ["name"]: "web" });\n`,
    "3:41",
    /^a computed key is not allowed in a data file: write the field's name/,
  ],
  [
    "default",
    `${GH}export const web = github.repository({ name: "web" });\n\nexport default { web };\n`,
    "5:16",
    /^export default must list this file's resources: `export default \[a, b\]`/,
  ],
  [
    "function",
    `${GH}export function name() {\n  return "web";\n}\n\nexport const web = github.repository({ name: "web" });\n`,
    "3:1",
    /^a function declaration is not allowed in a data file: a data file holds only imports/,
  ],
  [
    "import",
    `import { z } from "zod";\n${GH}export const web = github.repository({ name: "web" });\n`,
    "1:19",
    /^import "zod" is not allowed in a data file: import resource constructors from a connector's resources entry/,
  ],
  [
    "let",
    `${GH}export let web = github.repository({ name: "web" });\n`,
    "3:1",
    /^`export let` is not allowed in a data file: use `export const`/,
  ],
  [
    "member",
    `${GH}export const web = github.repository({ name: "web" });\nexport const webMain = github.branch_protection({ repository_id: web.name, pattern: "main" });\n`,
    "4:66",
    /^member access is not allowed in a data file: .*name the resource itself/,
  ],
  [
    "new",
    `${GH}export const web = github.repository({ name: "web", topics: new Array<string>() });\n`,
    "3:61",
    /^`new` is not allowed in a data file: write the value out/,
  ],
  [
    "not-constructor",
    `${GH}export const web = { name: "web" };\nexport const site = github.repository({ name: "site" });\n`,
    "3:20",
    /^export const web must be a resource constructor call, `<vendor>\.<type>\(\{ … \}\)`/,
  ],
  [
    "outside",
    `${GH}import { website } from "../../lib/site.ts";\n\nexport const websiteMain = github.branch_protection({ repository_id: website, pattern: "main" });\n`,
    "3:25",
    /^import "\.\.\/\.\.\/lib\/site\.ts" is not allowed in a data file: it reaches outside resources\//,
  ],
  [
    "process",
    `${GH}export const web = github.repository({ name: "web", description: process.env.SITE_DESCRIPTION });\n`,
    "3:66",
    /^process is not allowed in a data file: .*cannot read the environment/,
  ],
  [
    "spread",
    `${GH}// oxlint-disable-next-line unicorn/no-useless-spread\nexport const web = github.repository({ name: "web", ...{ has_wiki: false } });\n`,
    "4:53",
    /^a spread is not allowed in a data file: write the fields out/,
  ],
  [
    "template",
    `${GH}export const web = github.repository({ name: \`web-\${"site"}\` });\n`,
    "3:46",
    /^a template with `\$\{…\}` is not allowed in a data file: write the string out/,
  ],
  [
    "twice",
    `${GH}export const web = github.repository({ name: "web" });\nexport const web = github.repository({ name: "site" });\n`,
    "4:14",
    /^web is declared twice in this file: give each its own name/,
  ],
  [
    "undefined",
    `${GH}export const web = github.repository({ name: "web", description: undefined });\n`,
    "3:66",
    /^undefined is not allowed in a data file: leave the field out, or write null/,
  ],
  [
    "unexported",
    `${GH}const name = "web";\n\nexport const web = github.repository({ name });\n`,
    "3:1",
    /^`const name` is not allowed in a data file: export it as a resource/,
  ],
];
