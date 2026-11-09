// A fake pnpm for `pnpm dlx sanoma`: records its arguments in FAKE_PNPM_LOG, starts a company as the
// launcher's init does (a sanoma.config.ts), then serves it as the fake launcher does. FAKE_SANOMA
// says which sanoma it is: "init" (the default: `init` reports its stages, then serves), "init-only"
// (`init` sets up, installing the fake launcher, and exits; `install` then succeeds), "old" (a sanoma
// from before `init`: it refuses the command with exit 2, writing nothing, and plain `dlx sanoma`
// starts the company with no stages).
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const sanoma = process.env.FAKE_SANOMA ?? "init";
const event = (fields) => console.log(JSON.stringify({ sanoma: 1, ...fields }));
const stage = (name, status) => event({ event: "stage", stage: name, status });

if (process.env.FAKE_PNPM_LOG) appendFileSync(process.env.FAKE_PNPM_LOG, `${args.join(" ")}\n`);
if (args[0] === "install") process.exit(0);
const init = args.includes("init");
if (init && sanoma === "old") {
  event({ event: "error", message: "Unknown option '--name'" });
  process.exit(2);
}
console.error(`starting a Sanoma company in ${process.cwd()}`);
for (const name of init ? ["template", "people", "git"] : []) {
  stage(name, "start");
  stage(name, "done");
}
writeFileSync("sanoma.config.ts", "export default {};\n");
if (init) stage("install", "start");
mkdirSync("node_modules/sanoma", { recursive: true });
cpSync(new URL("./launcher.mjs", import.meta.url), "node_modules/sanoma/cli.mjs");
writeFileSync("node_modules/sanoma/package.json", JSON.stringify({ bin: { sanoma: "cli.mjs" } }));
if (init) stage("install", "done");
if (sanoma === "init-only") process.exit(0);
if (init) stage("database", "start");
event({ event: "database", how: "started" });
if (init) stage("database", "done");
await import("./launcher.mjs");
