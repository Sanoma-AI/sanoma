// By hand, against a real Agent37 workspace: the Sandbox kit against `agent37Backend`, then the
// times a box takes, measured: create to ready, a `pnpm install` of a company repo, the sleep's
// checkpoint and the wake from it. Never in CI or the gate: it makes an instance on the key's
// wallet (one day of balance is the create's gate) and deletes it at the end. README, "Running it
// live", says what it needs:
//
//   pnpm build
//   SANOMA_LIVE=1 AGENT37_API_KEY=... node connectors/agent37/test/live.ts path/to/a/company/repo

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkSandbox } from "sanoma/testing/sandbox";
import type { Box } from "sanoma/workflows";
import { agent37Api, isCode } from "../src/api.ts";
import { agent37Backend, BOX, KEY } from "../src/backend.ts";
import { BASE, DEFAULTS, instance } from "../src/connector.ts";

const key = process.env[KEY];
const repo = process.argv[2];
if (process.env.SANOMA_LIVE !== "1" || !key || !repo) {
  console.error(
    `test/live.ts runs against a real workspace: SANOMA_LIVE=1, ${KEY} and a company repo's path are needed`,
  );
  process.exit(2);
}
const NAME = `sanoma-live-${Date.now().toString(36)}`;
const backend = agent37Backend({ secrets: async () => new Map([[KEY, key]]), declared: {} });
const api = agent37Api(key);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const timed = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
  const begun = Date.now();
  const done = await run();
  console.log(`${what}: ${seconds(Date.now() - begun)}`);
  return done;
};
/** Runs `command` in the box to its end, printing its output when it fails. */
async function sh(box: Box, command: string) {
  const ran = await box.run(command);
  const [out, err, { exitCode }] = await Promise.all([
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
    ran.wait(),
  ]);
  if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}:\n${out}\n${err}`);
  return out;
}

let failed = false;
try {
  const box = await timed("create to ready (made, running, the runner started)", () =>
    backend.open({ name: NAME, image: BASE, size: DEFAULTS.size }),
  );

  // The company repo, as the instance hands a box its draft: a bundle the box clones.
  const scratch = mkdtempSync(join(tmpdir(), "sanoma-live-"));
  const bundle = join(scratch, "repo.bundle");
  execFileSync("git", ["-C", repo, "bundle", "create", bundle, "HEAD"], { stdio: "ignore" });
  await timed("bundle written into the box", () => box.write("repo.bundle", readFileSync(bundle)));
  rmSync(scratch, { recursive: true, force: true });
  const pnpm = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).packageManager ?? "pnpm";
  await sh(box, "git clone -q repo.bundle repo");
  await timed(`pnpm install --frozen-lockfile (${pnpm})`, () =>
    sh(box, `cd repo && npx -y ${pnpm} install --frozen-lockfile --reporter=silent`),
  );

  // The checkpoint: `start` answers `try_again` while it is being written.
  const asleep = Date.now();
  await box.stop();
  const id = box.id;
  let waking: number;
  for (;;) {
    waking = Date.now();
    try {
      await api.start(id);
      break;
    } catch (error) {
      if (!isCode(error, "try_again")) throw error;
      await delay(1_000);
    }
  }
  console.log(`checkpoint written (sleep to a start it takes): ${seconds(waking - asleep)}`);
  const woken = await backend.open({ name: NAME, image: BASE, size: DEFAULTS.size });
  console.log(`wake from sleep (start to the runner answering): ${seconds(Date.now() - waking)}`);
  if (!(await sh(woken, "test -d repo/node_modules && echo kept")).includes("kept")) {
    throw new Error("node_modules did not survive the sleep");
  }
  await woken.stop();
  await backend.discard({ name: NAME });

  const results = await checkSandbox({
    backend,
    capabilities: instance.sandbox!.capabilities,
    name: `${NAME}-kit`,
    image: BASE,
    size: DEFAULTS.size,
    timeoutMs: 5 * 60_000,
  });
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `: ${r.error}`}`);
  failed = results.some((r) => !r.ok);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  // Whatever this run left, by its box names.
  for (const left of await api.list()) {
    if (String(left.metadata?.[BOX] ?? "").startsWith(NAME)) await api.remove(left.id);
  }
}
process.exit(failed ? 1 : 0);
