import type { ResourcesConfig } from "@sanoma-ai/bridge/tfschema";

/**
 * Which of the Docker provider's resource types `pnpm generate` writes into `resources.gen.ts`.
 * Hand-owned. The release and its sha256 are the pin in `@sanoma-ai/bridge`'s `testdata/pins.json`.
 */
export default {
  provider: "kreuzwerker/docker",
  types: ["docker_container"],
} satisfies ResourcesConfig;
