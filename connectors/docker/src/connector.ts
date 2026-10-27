import { tfConnector, type TfMapped } from "@sanoma-ai/bridge/connector";
import { DriverError, vendorInfo } from "@sanoma-ai/workflows";
import { DOMAIN_NAME, domainsOf, domainsText, SITE_KEY } from "@sanoma-ai/workflows/shared";
import { z } from "zod";
import { docker_container, provider } from "./resources.gen.ts";

/** The port the runtime listens on inside the container (the image's `PORT`). */
const INTERNAL_PORT = 3000;

/** The labels a container carries: what it runs, so a read tells its revision, source and ref, and its env's names. */
export const LABELS = {
  revision: "sanoma.revision",
  source: "sanoma.source",
  ref: "sanoma.ref",
  env: "sanoma.env",
  domains: "sanoma.domains",
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
    .describe("The Sanoma runtime image, pinned to a tag or a digest, never `latest`"),
  source: z.string().min(1).describe("The company repository's clone URL, or a declared GitHub repository"),
  ref: z.string().min(1).describe("The branch it runs, such as `main`, never a commit"),
  revision: z.string().nullish().describe("The commit it runs, which apply sets from `ref`"),
  secrets: z
    .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string())
    .nullish()
    .describe("Environment variables holding secrets, each a `secret(...)`: SANOMA_DATABASE_URL, SANOMA_SECRETS_KEY"),
  port: z.number().int().min(1).max(65_535).describe("The port on 127.0.0.1 the app answers on"),
  domains: z
    .record(z.string().regex(SITE_KEY), z.string().regex(DOMAIN_NAME))
    // Empty, it would read back as none, a change on every plan.
    .refine((domains) => Object.keys(domains).length > 0, "leave `domains` out rather than empty")
    .nullish()
    .describe("A public site's domain, by site name"),
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
  toProvider: ({ name, image, source, ref, revision, secrets, port, domains }: Container) => {
    if (!revision) {
      throw new DriverError(
        `docker: container ${name}: no revision: apply sets it from ${ref} once its source exists (apply again after a repository it creates)`,
        { retryable: false },
      );
    }
    const served = domains ? domainsText(domains) : undefined;
    const env = {
      ...secrets,
      SANOMA_SOURCE: source,
      SANOMA_REVISION: revision,
      PORT: String(INTERNAL_PORT),
      ...(served && { SANOMA_DOMAINS: served }),
    };
    const labels: Record<string, string> = {
      [LABELS.revision]: revision,
      [LABELS.source]: source,
      [LABELS.ref]: ref,
      [LABELS.env]: Object.keys(env).toSorted().join(","),
      ...(served && { [LABELS.domains]: served }),
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
    const domains = label(LABELS.domains);
    return {
      id: (state.id as string | null) ?? null,
      name: String(state.name ?? ""),
      image: String(state.image ?? ""),
      source: label(LABELS.source) ?? "",
      ref: label(LABELS.ref) ?? "",
      revision: label(LABELS.revision),
      port: published?.external ?? 0,
      ...(domains && { domains: domainsOf(domains) }),
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
        inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port", domains: "domains" },
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
  info: vendorInfo(import.meta.url),
});

/** The Docker connector's operations: the container type's `read`, `import`, `plan`, `create`, `update` and `delete`. */
export const dockerOps = dockerTf.connector;
