import { type Exchange, live, type ReplayOptions } from "@sanoma-ai/testing/replay";

// How Resend's recorded replies are replayed (and recorded): the driver's tests and the features share it.

export const audience = live ? (process.env.RESEND_TEST_AUDIENCE ?? "") : "00000000-0000-4000-8000-0000000000aa";
export const from = process.env.RESEND_TEST_FROM ?? "Sanoma test <onboarding@resend.dev>";
/** The sender's domain, which a reply may name outside an address (an unverified domain's error). */
const fromDomain = /@([\w.-]+)/.exec(from)?.[1];

/** Ids, addresses, the sender's domain and keys out of a recording, so the repo never holds an account's. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(
    (fromDomain ? JSON.stringify(exchanges).replaceAll(fromDomain, "example.com") : JSON.stringify(exchanges))
      .replaceAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "00000000-0000-4000-8000-000000000001",
      )
      .replaceAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "someone@example.com")
      .replaceAll(/re_\w+/g, "re_redacted"),
  );

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["RESEND_API_KEY", "RESEND_TEST_AUDIENCE"],
  env: { RESEND_API_KEY: "re_test_key" },
  scrub,
};
