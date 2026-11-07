import { randomUUID } from "node:crypto";
import { type Bridge, type ProviderRef } from "./bridge.ts";

/** The calls a provider-backed driver needs. */
export type ProviderClient = Pick<Bridge, "configure" | "import" | "read" | "plan" | "apply" | "close">;

/** One process per authorized operation. No credential cache, reconfiguration or implicit replay. */
export async function withProviderSession<T>(
  bridge: ProviderClient,
  provider: ProviderRef,
  configJson: string,
  call: (session: ProviderRef) => Promise<T>,
): Promise<T> {
  const session = { ...provider, sessionId: randomUUID() };
  try {
    await bridge.configure(session, configJson);
    return await call(session);
  } finally {
    // Configure may have succeeded despite a lost response. Cleanup must never
    // turn a completed mutation into a retry; leaked sessions remain bounded
    // by the bridge's process limit and are killed when the bridge stops.
    await bridge.close(session).catch(() => {});
  }
}
