import type { ResourcesConfig } from "@sanoma-ai/bridge/tfschema";

/**
 * Which of the Docker provider's resource types `pnpm generate` writes into `resources.gen.ts`.
 * Hand-owned. The release and its sha256 are the pin in `@sanoma-ai/bridge`'s `testdata/pins.json`.
 */
export default {
  provider: "kreuzwerker/docker",
  types: ["docker_container"],
  // ForceNew in the provider's source (resource_docker_container.go at v4.6.0): a change of any
  // replaces the container, so a deploy or a secret's rotation is a replace.
  immutable: {
    docker_container: ["env", "image", "labels", "name", "ports"],
  },
} satisfies ResourcesConfig;
