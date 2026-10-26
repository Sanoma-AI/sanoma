import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startWakeupService } from "@sanoma-ai/workflows/wakeup-service";
import { NodeRequest, sendNodeResponse } from "srvx/node";

// The real wakeup service (`@sanoma-ai/workflows/wakeup-service`, what `sanoma wakeup` runs) in
// this process, on its own database, served on a free port of this machine: what the driver's
// recordings and its conformance test run against, over srvx as `sanoma wakeup` serves it.

/** Starts the service on `databaseUrl` at `http://127.0.0.1:<port>`; `stop` closes the server, then the service. */
export async function serveWakeup(databaseUrl: string) {
  const service = await startWakeupService({ databaseUrl, log: { info: () => {}, warn: () => {} } });
  const [route] = service.routes;
  const server = createServer((req, res) => {
    void route!.handle(new NodeRequest({ req, res })).then((answer) => sendNodeResponse(res, answer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    mintAccount: service.mintAccount,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await service.stop();
    },
  };
}
