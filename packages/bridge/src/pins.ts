import { readFileSync } from "node:fs";
import type { ProviderRef } from "./bridge.ts";

/** The package's fixtures: pins, schema documents and recorded replies, copied from provider-bridge. */
export const testdata = new URL("../testdata/", import.meta.url);

interface Pin {
  version: string;
  sha256: string;
  note?: string;
}

/**
 * The pinned provider releases, keyed by source (`integrations/github`, `stripe/stripe`,
 * `hashicorp/null`), from `testdata/pins.json` (or `file`). A pin changes only by hand, in a
 * commit that re-records the release's schema and replies: providers are never upgraded
 * implicitly.
 */
export function readPins(file: string | URL = new URL("pins.json", testdata)): Record<string, ProviderRef> {
  const pins = JSON.parse(readFileSync(file, "utf8")) as Record<string, Pin>;
  return Object.fromEntries(
    Object.entries(pins).map(([source, { version, sha256 }]) => [source, { source, version, sha256 }]),
  );
}
