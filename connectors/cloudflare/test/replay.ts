import type { Exchange, ReplayOptions } from "@sanoma-ai/testing/replay";

// How Cloudflare's replies are replayed (and recorded): the driver's tests and the features share
// it. The fixtures are written from Cloudflare's API reference, not recorded (README, "Testing the
// driver"): a recording replaces them.

/** A made-up account: the replies need none. */
export const TEST_ACCOUNT = "0123456789abcdef0123456789abcdef";
/** The account's workers.dev subdomain in the fixtures. */
export const TEST_SUBDOMAIN = "example";
/** Where the API's paths start. */
export const API = `/client/v4/accounts/${TEST_ACCOUNT}`;

/** Replaces each distinct string it is given with `make(1)`, `make(2)`, ... in order of appearance. */
const renumber = (make: (n: number) => string) => {
  const seen = new Map<string, string>();
  return (real: string) => {
    if (!seen.has(real)) seen.set(real, make(seen.size + 1));
    return seen.get(real)!;
  };
};

/** The account's id and subdomain made up, ids numbered and tokens out, so a recording names nothing real. */
function scrub(exchanges: Exchange[]): Exchange[] {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? TEST_ACCOUNT;
  const subdomain = exchanges.find((e) => e.path.endsWith("/workers/subdomain"))?.body as
    | { result?: { subdomain?: string } }
    | undefined;
  let text = JSON.stringify(exchanges).replaceAll(account, TEST_ACCOUNT);
  const real = subdomain?.result?.subdomain;
  if (real)
    text = text
      .replaceAll(`"${real}"`, `"${TEST_SUBDOMAIN}"`)
      .replaceAll(`.${real}.workers.dev`, `.${TEST_SUBDOMAIN}.workers.dev`);
  return JSON.parse(
    text
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        renumber((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
      )
      .replace(
        /\bswi_[A-Za-z0-9_-]+/g,
        renumber((n) => `swi_recorded${String(n).padStart(4, "0")}`),
      ),
  );
}

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  env: { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: TEST_ACCOUNT },
  scrub,
};
