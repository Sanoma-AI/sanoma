import type { Exchange, ReplayOptions } from "@sanoma-ai/testing/replay";

// How the wakeup service's recorded replies are replayed (and recorded): the driver's tests and
// the features share it. The recordings are of a local `sanoma wakeup` (README, "Testing the driver").

/** Where the replayed service is: the recordings keep paths only. */
export const SERVICE = "https://wakeup.example.test";
/** A made-up account token: the recorded replies need none. */
export const TEST_ACCOUNT_TOKEN = "swa_test-account";

/** Replaces each distinct string it is given with `make(1)`, `make(2)`, ... in order of appearance. */
const renumber = (make: (n: number) => string) => {
  const seen = new Map<string, string>();
  return (real: string) => {
    if (!seen.has(real)) seen.set(real, make(seen.size + 1));
    return seen.get(real)!;
  };
};

/** Numbers the instances' ids and tokens in order of appearance, so no recorded token stays. */
function scrub(exchanges: Exchange[]): Exchange[] {
  const token = renumber((n) => `swi_recorded${String(n).padStart(4, "0")}`);
  return JSON.parse(
    JSON.stringify(exchanges)
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        renumber((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
      )
      .replace(/\bsw[ai]_[A-Za-z0-9_-]+/g, token),
  );
}

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["SANOMA_OPS_URL", "SANOMA_OPS_TOKEN"],
  env: { SANOMA_OPS_URL: SERVICE, SANOMA_OPS_TOKEN: TEST_ACCOUNT_TOKEN },
  scrub,
};
