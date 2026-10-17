import { dockerTf } from "./connector.ts";

/**
 * The constructor a data file declares the container that runs the company with:
 * `export const host = docker.container({ name: "sanoma-acme", image: "sanoma-runtime:0.2.0", source: repo, ref: "main", port: 3000, secrets: { SANOMA_DATABASE_URL: secret("SANOMA_DATABASE_URL") } })`.
 */
export const docker = dockerTf.resources;
