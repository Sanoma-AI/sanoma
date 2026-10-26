// A fake pnpm for `pnpm dlx sanoma`: records its arguments in FAKE_PNPM_LOG, starts a company as the
// launcher's init does (a sanoma.config.ts), then serves it as the fake launcher does.
import { appendFileSync, writeFileSync } from "node:fs";

if (process.env.FAKE_PNPM_LOG) appendFileSync(process.env.FAKE_PNPM_LOG, `${process.argv.slice(2).join(" ")}\n`);
console.error(`starting a Sanoma company in ${process.cwd()}`);
writeFileSync("sanoma.config.ts", "export default {};\n");
await import("./launcher.mjs");
