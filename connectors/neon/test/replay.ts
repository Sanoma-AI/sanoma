import type { Exchange, ReplayOptions } from "@sanoma-ai/testing/replay";

// How Neon's replies are replayed (and recorded): the driver's tests and the features share it.
// The fixtures are written by hand from Neon's API reference (the SDK's bundled OpenAPI spec),
// not recorded: no key was at hand. The README says how to record them.

/** A made-up key: the replies need none. */
export const TEST_KEY = "napi_test_key";

/** Passwords, request ids and the organization out of a recording, so the repo never holds an account's. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(
    JSON.stringify(exchanges)
      .replaceAll(/(postgres(?:ql)?:\/\/[^:"]+:)[^@"]+@/g, "$1npg_recordedpassword@")
      .replaceAll(/"password":"[^"]*"/g, '"password":"npg_recordedpassword"')
      .replaceAll(/"(owner_id|org_id)":"[^"]*"/g, '"$1":"org-recorded-12345678"')
      .replaceAll(/"request_id":"[^"]*"/g, '"request_id":"00000000-0000-4000-8000-000000000001"'),
  );

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["NEON_API_KEY"],
  env: { NEON_API_KEY: TEST_KEY },
  scrub,
};
