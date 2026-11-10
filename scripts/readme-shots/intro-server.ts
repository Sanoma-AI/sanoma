// Runs only in the recorder's disposable company. One process keeps the fake Git host's state.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startWorker, SanomaClient } from "sanoma/workflows";
import { appSteps } from "sanoma/app/steps";
import { waitFor } from "sanoma/testing";
import { loadConfig } from "../../packages/sanoma/src/config.ts";
import { localGitSource } from "../../packages/sanoma/src/source.ts";
import { runApp } from "../../packages/sanoma/src/serve.ts";
import { fakeRemote } from "../../packages/sanoma/workflows/test/fakes/remote.ts";
import { demoAgent } from "./intro-fixture.ts";

const root = process.argv[2]!;
const origin = process.argv[3]!;
const loaded = await loadConfig(root);
const remote = fakeRemote({ origin, url: pathToFileURL(origin).href });
const config = {
  ...loaded.config,
  root: loaded.root,
  databaseUrl: process.env.SANOMA_DATABASE_URL!,
  connectors: [...loaded.config.connectors, remote.connector, demoAgent()],
};
const source = localGitSource(root, { databaseUrl: config.databaseUrl });
const worker = await startWorker(config, { source, app: appSteps, promote: true });
const client = await SanomaClient.connect(config);
const app = await runApp(config, { port: 0, log: console.log });
const { ghostFake, resendFake } = await import(pathToFileURL(join(root, "sanoma.config.ts")).href);
process.send?.({ ready: app.url });
process.on("message", (message: { id: number; command: string }) => {
  void (async () => {
    let result: unknown;
    if (message.command === "calls") {
      result = { ghost: ghostFake.calls, resend: resendFake.calls };
    } else if (message.command === "reject") {
      const runId = await client.start(
        "announce",
        { title: "Rejected rehearsal", body: "Do not publish this." },
        { startedBy: { id: "dana" } },
      );
      await waitFor(
        async () => (await client.run(runId))?.status,
        (s) => s === "waiting",
        30_000,
      );
      await client.decide(runId, {
        decision: "reject",
        by: { id: "marketing-lead" },
        note: "Rehearsal: no publish or send",
      });
      await waitFor(
        async () => (await client.run(runId))?.status,
        (s) => s === "failed",
        30_000,
      );
      result = { ghost: ghostFake.calls, resend: resendFake.calls };
    } else throw new Error(`Unknown recorder command: ${message.command}`);
    process.send?.({ id: message.id, result });
  })().catch((error: unknown) => process.send?.({ id: message.id, error: String(error) }));
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.stop();
  await client.close();
  await worker.stop();
  process.exit();
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
