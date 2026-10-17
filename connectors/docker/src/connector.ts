import { tfConnector, type TfMapped } from "@sanoma-ai/bridge/connector";
import { DriverError } from "@sanoma-ai/workflows";
import { z } from "zod";
import { docker_container, provider } from "./resources.gen.ts";

/**
 * Docker's whale, from simple-icons (https://simpleicons.org/?q=docker, CC0), in Docker's blue,
 * which reads on light and dark backgrounds alike.
 */
const whale = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#2496ED" d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/></svg>`;

/** The port the runtime listens on inside the container (the image's `PORT`). */
const INTERNAL_PORT = 3000;

/** The labels a container carries: what it runs, so a read tells its revision, source and ref, and its env's names. */
export const LABELS = {
  revision: "sanoma.revision",
  source: "sanoma.source",
  ref: "sanoma.ref",
  env: "sanoma.env",
} as const;

/**
 * Attributes only a config sets, which no read of a container returns: `toProvider` sets each,
 * and the driver puts them in an imported state, so a container made as declared plans no change.
 * `wait` holds apply until the healthcheck passes (the clone and install included).
 */
export const CREATE_ONLY = {
  attach: false,
  logs: false,
  start: true,
  remove_volumes: true,
  container_read_refresh_timeout_milliseconds: 15_000,
  wait: true,
  wait_timeout: 600,
} as const;

const container = z.object({
  id: z.string().nullish().describe("The container's id, which Docker sets"),
  name: z.string().min(1).describe("The container's name, such as `sanoma-acme`"),
  image: z
    .string()
    .regex(/^[^\s@]+(:[\w][\w.-]{0,127}|@sha256:[0-9a-f]{64})$/, "pin the image to a tag or a digest")
    .refine((image) => !image.endsWith(":latest"), "pin the image to a version, not `latest`")
    .describe("The Sanoma runtime image, pinned: `sanoma-runtime:0.2.0`, never `latest`"),
  source: z.string().min(1).describe("The company repository's clone URL, or a declared GitHub repository"),
  ref: z.string().min(1).describe("The branch it runs, such as `main`, never a commit"),
  revision: z.string().nullish().describe("The commit it runs, which apply sets from `ref`"),
  secrets: z
    .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string())
    .nullish()
    .describe("Environment variables holding secrets, each a `secret(...)`: SANOMA_DATABASE_URL, SANOMA_SECRETS_KEY"),
  port: z.number().int().min(1).max(65_535).describe("The port on 127.0.0.1 the app answers on"),
  running: z.boolean().nullish().describe("Whether the container runs, which Docker says"),
});

type Container = z.output<typeof container>;
type Label = { label: string; value: string };

/**
 * `docker.container` over the provider's `docker_container`: the runtime image, its source at a
 * revision and its secrets as environment variables, published on `127.0.0.1` only, restarted
 * unless stopped, and healthy once `/healthz` answers. What it runs is in its labels, as the
 * provider never reads a container's environment back.
 */
export const containerType: TfMapped<typeof container> = {
  over: docker_container,
  schema: container,
  fields: { immutable: [], vendorOwned: ["id", "running"], writeOnly: ["secrets"] },
  toProvider: ({ name, image, source, ref, revision, secrets, port }: Container) => {
    if (!revision) {
      throw new DriverError(
        `docker: container ${name}: no revision: apply sets it from ${ref} once its source exists (apply again after a repository it creates)`,
        { retryable: false },
      );
    }
    const env = { ...secrets, SANOMA_SOURCE: source, SANOMA_REVISION: revision, PORT: String(INTERNAL_PORT) };
    const labels: Record<string, string> = {
      [LABELS.revision]: revision,
      [LABELS.source]: source,
      [LABELS.ref]: ref,
      [LABELS.env]: Object.keys(env).toSorted().join(","),
    };
    return {
      ...CREATE_ONLY,
      name,
      image,
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      labels: Object.entries(labels).map(([label, value]) => ({ label, value })),
      ports: [{ internal: INTERNAL_PORT, external: port, ip: "127.0.0.1", protocol: "tcp" }],
      restart: "unless-stopped",
      must_run: true,
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          `fetch('http://127.0.0.1:${INTERNAL_PORT}/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
        ],
        interval: "2s",
        timeout: "3s",
        retries: 3,
        // As Docker reads it back (Go's duration), so a read plans no change: `wait_timeout`.
        start_period: "10m0s",
      },
    };
  },
  fromProvider: (state) => {
    const labels = (state.labels as Label[] | null) ?? [];
    const label = (name: string) => labels.find((l) => l.label === name)?.value ?? null;
    const [published] = (state.ports as { external?: number | null }[] | null) ?? [];
    return {
      id: (state.id as string | null) ?? null,
      name: String(state.name ?? ""),
      image: String(state.image ?? ""),
      source: label(LABELS.source) ?? "",
      ref: label(LABELS.ref) ?? "",
      revision: label(LABELS.revision),
      port: published?.external ?? 0,
      running: state.must_run === true && state.exit_code == null,
    };
  },
};

/**
 * Docker, through the `kreuzwerker/docker` OpenTofu provider on the local daemon: one type,
 * `docker.container`, the host that runs the company on this machine (`Host`: long-lived, its URL
 * on 127.0.0.1 only, running an image, no fixed egress). A container is found by its name and
 * bound by its id. Every change replaces it (the provider forces a new container for any change
 * of its image, environment or labels), so a deploy or a secret's rotation restarts it.
 */
export const dockerTf = tfConnector({
  vendor: "docker",
  provider,
  types: {
    container: {
      tf: containerType,
      title: "Container",
      identity: "name",
      find: ({ name }) => name,
      writable: true,
      // The provider keeps a container's environment in its state, unmarked: the secrets are there.
      writeOnly: ["env"],
      host: {
        capabilities: { lifetime: "long-lived", publicUrl: false, buildsFromGit: false, staticEgress: false },
        inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port" },
        revision: "revision",
        outputs: (state) => ({
          url: `http://127.0.0.1:${String(state.port)}`,
          ...(typeof state.revision === "string" && { revision: state.revision }),
          healthy: state.running === true,
        }),
      },
    },
  },
  references: { container: { source: { type: "github.repository", by: ["http_clone_url"] } } },
  info: {
    title: "Docker",
    logo: { svg: whale },
    package: "@sanoma-ai/connector-docker",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/docker#readme",
  },
});

/** The Docker connector's operations: the container type's `read`, `import`, `plan`, `create`, `update` and `delete`. */
export const dockerOps = dockerTf.connector;
