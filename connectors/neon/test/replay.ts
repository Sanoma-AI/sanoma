import type { Exchange, ReplayOptions } from "@sanoma-ai/testing/replay";

// How Neon's replies are replayed (and recorded): the driver's tests and the features share it.
// The features' fixtures are recorded; the driver tests' own are written by hand from Neon's API
// reference (the SDK's bundled OpenAPI spec). The README says how to record.

/** A made-up key: the replies need none. */
export const TEST_KEY = "napi_test_key";

/** Passwords, request ids, the organization (its id, name and email) out of a recording, so the repo never holds an account's. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(
    JSON.stringify(exchanges)
      .replaceAll(/(postgres(?:ql)?:\/\/[^:"]+:)[^@"]+@/g, "$1npg_recordedpassword@")
      .replaceAll(/"password":"[^"]*"/g, '"password":"npg_recordedpassword"')
      .replaceAll(/"(owner_id|org_id)":"[^"]*"/g, '"$1":"org-recorded-12345678"')
      .replaceAll(/"email":"[^"]*"/g, '"email":"owner@example.com"')
      .replaceAll(/("owner":\{[^{}]*?"name":")[^"]*"/g, '$1Recorded organization"')
      .replaceAll(/"request_id":"[^"]*"/g, '"request_id":"00000000-0000-4000-8000-000000000001"'),
  );

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["NEON_API_KEY"],
  env: { NEON_API_KEY: TEST_KEY },
  scrub,
};
