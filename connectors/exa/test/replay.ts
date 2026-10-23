import { type Exchange, type ReplayOptions } from "@sanoma-ai/testing/replay";

// How Exa's replies are replayed (and recorded): the driver's tests and the features share it.

/** Request ids and keys out of a recording, so the repo never holds an account's. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(
    JSON.stringify(exchanges)
      .replaceAll(/"requestId":"\w+"/g, '"requestId":"00000000000000000000000000000000"')
      .replaceAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "00000000-0000-4000-8000-000000000001",
      ),
  );

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["EXA_API_KEY"],
  env: { EXA_API_KEY: "exa_test_key" },
  scrub,
};
