import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startWakeupService } from "@sanoma-ai/workflows/wakeup-service";

// The real wakeup service (`@sanoma-ai/workflows/wakeup-service`, what `sanoma wakeup` runs) in
// this process, on its own database, served on a free port of this machine: what the driver's
// recordings and its conformance test run against.

/** Starts the service on `databaseUrl` at `http://127.0.0.1:<port>`; `stop` closes the server, then the service. */
export async function serveWakeup(databaseUrl: string) {
  const service = await startWakeupService({ databaseUrl, log: { info: () => {}, warn: () => {} } });
  const [route] = service.routes;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = Object.entries(req.headers).flatMap(([name, v]) =>
      v === undefined ? [] : [[name, String(v)] as [string, string]],
    );
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
    const answer = await route!.handle(request);
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
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
