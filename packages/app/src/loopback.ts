// The loopback rule: which addresses count as this machine, for what startApp listens on and
// for the Host names it then answers to, so the two can never disagree.

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for localhost, 127.x.x.x and ::1. */
export const isLoopback = (host: string) => LOOPBACK_NAMES.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** The host name in a Host header (`name`, `name:port`, `[v6]:port`), lowercased. */
export function hostName(header: string): string {
  const name = header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.replace(/:\d*$/, "");
  return name.toLowerCase();
}

/** The 403 for a request that reached a loopback-only app under some other name (DNS rebinding). */
export function refuseHost(host: string): Response {
  return Response.json(
    { error: `This app answers to localhost only, not ${host || "a request with no Host"}` },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
