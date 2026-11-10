// A fake pnpm for `pnpm dlx sanoma init`: records its arguments in FAKE_PNPM_LOG, starts a company
// as the launcher's init does (a sanoma.config.ts), reporting its stages, then serves it as the fake
// launcher does. With FAKE_SANOMA=refuses, init refuses its answers with exit 2, writing nothing.
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const event = (fields) => console.log(JSON.stringify({ sanoma: 1, ...fields }));
const stage = (name, status) => event({ event: "stage", stage: name, status });

if (process.env.FAKE_PNPM_LOG) appendFileSync(process.env.FAKE_PNPM_LOG, `${args.join(" ")}\n`);
if (process.env.FAKE_SANOMA === "refuses") {
  event({ event: "error", message: "--email: not an email address" });
  process.exit(2);
}
console.error(`starting a Sanoma company in ${process.cwd()}`);
for (const name of ["template", "people", "git"]) {
  stage(name, "start");
  stage(name, "done");
}
writeFileSync("sanoma.config.ts", "export default {};\n");
stage("install", "start");
mkdirSync("node_modules/sanoma", { recursive: true });
cpSync(new URL("./launcher.mjs", import.meta.url), "node_modules/sanoma/cli.mjs");
writeFileSync("node_modules/sanoma/package.json", JSON.stringify({ bin: { sanoma: "cli.mjs" } }));
stage("install", "done");
stage("database", "start");
event({ event: "database", how: "started" });
stage("database", "done");
await import("./launcher.mjs");
