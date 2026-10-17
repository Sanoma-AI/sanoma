import { type Exchange, live, type ReplayOptions } from "@sanoma-ai/testing/replay";

// How the Management API's replies are replayed (and recorded) for the driver's tests. The
// fixtures are written by hand in the recorder's format, not recorded: no access token was at
// hand. Live, `SUPABASE_TEST_PROJECT_REF` names a project of the token's to read.

/** The project the pooler and health tests read. */
export const REF = live ? (process.env.SUPABASE_TEST_PROJECT_REF ?? "") : "sanomatestprojectref";

/** The project's ref and the organization out of a recording, so the repo holds neither. */
const scrub = (exchanges: Exchange[]): Exchange[] => {
  let json = JSON.stringify(exchanges);
  if (REF) json = json.replaceAll(REF, "sanomatestprojectref");
  const org = process.env.SUPABASE_TEST_ORG_ID;
  if (org) json = json.replaceAll(org, "sanoma-test-org");
  return JSON.parse(json) as Exchange[];
};

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["SUPABASE_ACCESS_TOKEN", "SUPABASE_TEST_PROJECT_REF"],
  env: { SUPABASE_ACCESS_TOKEN: "sbp_test_token" },
  scrub,
};
