import { type Exchange, live, type ReplayOptions } from "sanoma/testing/replay";

// How Resend's recorded replies are replayed (and recorded): the driver's tests and the features share it.

export const audience = live ? (process.env.RESEND_TEST_AUDIENCE ?? "") : "00000000-0000-4000-8000-0000000000aa";
export const from = process.env.RESEND_TEST_FROM ?? "Sanoma test <onboarding@resend.dev>";
/**
 * The sender's domain, which a reply may name outside an address (an unverified domain's error),
 * and the throwaway domain the domain scenarios were recorded with (README, "Testing the driver").
 */
const domains = [/@([\w.-]+)/.exec(from)?.[1], process.env.RESEND_TEST_DOMAIN]
  .filter((d): d is string => Boolean(d))
  // The longest first, so a domain that holds the other is replaced whole.
  .toSorted((a, b) => b.length - a.length);

/** Ids, addresses, the domains, DKIM keys and API keys out of a recording, so the repo never holds an account's. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(
    domains
      .reduce((text, domain) => text.replaceAll(domain, "example.com"), JSON.stringify(exchanges))
      .replaceAll(/"p=[A-Za-z0-9+/=]+"/g, '"p=redacted"')
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
