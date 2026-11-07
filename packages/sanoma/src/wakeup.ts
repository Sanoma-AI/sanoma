import { startWakeupService } from "sanoma/workflows/wakeup-service";
import { type Listening, listenRoutes } from "./listen.ts";

// `sanoma wakeup`: the wakeup service alone, over a plain Node server: its routes and `/healthz`.

/**
 * Starts the wakeup service on `databaseUrl` and serves it on `host` and `port`: its routes, and
 * `GET /healthz` for a host's probe; anything else is a 404. `stop` closes the server, then the service.
 */
export async function runWakeup(
  databaseUrl: string,
  { host, port, log }: { host: string; port: number; log: (line: string) => void },
): Promise<Listening> {
  const service = await startWakeupService({ databaseUrl, log: { info: log, warn: log } });
  let served: Listening;
  try {
    served = await listenRoutes(service.routes, { host, port, log, name: "sanoma wakeup" });
  } catch (err) {
    await service.stop();
    throw err;
  }
  return {
    url: served.url,
    async stop() {
      try {
        await served.stop();
      } finally {
        await service.stop();
      }
    },
  };
}
