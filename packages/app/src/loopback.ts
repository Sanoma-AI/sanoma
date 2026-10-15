// The Host names a loopback-only app answers to. Which addresses count as this machine is
// `isLoopback` in `@sanoma-ai/workflows/shared`, for what startApp listens on and the Host names it
// then answers to alike, so the two can never disagree.

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
