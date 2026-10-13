import type { Exchange, ReplayOptions, Sent } from "@sanoma/testing/replay";

// How Bluesky's recorded replies are replayed (and recorded): the driver's tests and the features share it.

/** Strings of a kind a recording must not keep, whatever the account, and their placeholders. */
const patterns: [RegExp, string][] = [
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "example.jwt"],
  [/did:plc:[a-z2-7]{24}/g, "did:plc:example"],
  [/\bbafy[a-z2-7]{50,}/g, "bafyreihclbg5r7bdqu5lq3ulxnjalvh3a6nztvr7gp7u56xr4yn6qahpme"],
  [/https:\/\/[\w.-]+\.host\.bsky\.network/g, "https://pds.example.test"],
  // A post's record key, which differs on every live run: replaying, it is the request's.
  [/(?<=app\.bsky\.feed\.post\/|rkey=)[a-z2-7]{13}\b/g, "{rkey}"],
];
/** The fields of a successful reply the driver reads; the rest (the DID document, the email) is not kept. */
const keep: Record<string, string[]> = {
  "com.atproto.server.createSession": ["did", "handle", "accessJwt", "refreshJwt", "active"],
};
export const nsidOf = (path: string) => path.slice("/xrpc/".length).split("?")[0]!;

/** The account's identifiers and hosts, the fields the driver does not read, and every string of a kind above. */
function scrub(exchanges: Exchange[]): Exchange[] {
  const { BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD, BLUESKY_SERVICE } = process.env;
  const secrets = new Map([
    [BLUESKY_IDENTIFIER!, "alice.example.test"],
    [BLUESKY_APP_PASSWORD!, "example-app-password"],
    ...(BLUESKY_SERVICE && URL.canParse(BLUESKY_SERVICE) ? [[new URL(BLUESKY_SERVICE).host, "bsky.example.test"]] : []),
  ] as [string, string][]);
  const kept = exchanges.map((e) => {
    const body = e.body as any;
    if (body?.did) secrets.set(body.did, "did:plc:example");
    if (body?.handle) secrets.set(body.handle, "alice.example.test");
    if (body?.email) secrets.set(body.email, "alice@example.test");
    for (const { serviceEndpoint } of body?.didDoc?.service ?? []) {
      if (URL.canParse(serviceEndpoint)) secrets.set(new URL(serviceEndpoint).host, "pds.example.test");
    }
    const fields = e.status < 300 ? keep[nsidOf(e.path)] : undefined;
    return fields ? { ...e, body: Object.fromEntries(fields.filter((k) => k in body).map((k) => [k, body[k]])) } : e;
  });
  let text = JSON.stringify(kept);
  // Longest first: a host inside a handle must not break the handle up before it is replaced.
  for (const [secret, placeholder] of [...secrets].toSorted(([a], [b]) => b.length - a.length)) {
    text = text.replaceAll(secret, placeholder);
  }
  for (const [pattern, placeholder] of patterns) text = text.replace(pattern, placeholder);
  const left = [
    ...[...secrets.keys()].filter((secret) => text.includes(secret)),
    ...patterns.flatMap(([pattern, placeholder]) => (text.match(pattern) ?? []).filter((m) => m !== placeholder)),
  ];
  if (left.length) throw new Error(`scrubbing left ${left.length} secret(s) in the recording`);
  return JSON.parse(text);
}

/** `{rkey}` in a fixture is the record key the request names. */
function fill(exchange: Exchange, sent: Sent): Exchange {
  const rkey: string | null = sent.body?.rkey ?? new URLSearchParams(sent.path.split("?")[1]).get("rkey");
  return rkey ? JSON.parse(JSON.stringify(exchange).replaceAll("{rkey}", rkey)) : exchange;
}

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"],
  env: {
    BLUESKY_IDENTIFIER: "alice.example.test",
    BLUESKY_APP_PASSWORD: "example-app-password",
    BLUESKY_SERVICE: "https://bsky.example.test",
  },
  scrub,
  fill,
};
