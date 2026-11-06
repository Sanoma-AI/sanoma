import { type Exchange, type ReplayOptions } from "@sanoma-ai/testing/replay";

// How Agent37's replies are replayed (and recorded) for the driver's tests.

/** Instance ids, names and metadata out of a recording, so the repo never holds an account's. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(
    JSON.stringify(exchanges)
      .replaceAll(/"id":"[a-z0-9]{10}"/g, '"id":"ab12cd34ef"')
      .replaceAll(/https:\/\/[a-z0-9]{10}\.agent37\.app/g, "https://ab12cd34ef.agent37.app")
      .replaceAll(/"(name|metadata)":("[^"]*"|\{[^}]*\})/g, '"$1":null'),
  );

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["AGENT37_API_KEY"],
  env: { AGENT37_API_KEY: "sk_live_test" },
  scrub,
};
