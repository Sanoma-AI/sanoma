// A fake pnpm script: records its arguments in FAKE_PNPM_LOG and exits with FAKE_PNPM_EXIT.
import { appendFileSync } from "node:fs";

if (process.env.FAKE_PNPM_LOG) appendFileSync(process.env.FAKE_PNPM_LOG, `${process.argv.slice(2).join(" ")}\n`);
console.log("Done in 0.1s");
process.exit(Number(process.env.FAKE_PNPM_EXIT ?? 0));
