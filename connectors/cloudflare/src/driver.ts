import { defineDriver, DriverError, retryableStatus } from "@sanoma-ai/workflows";
import type { Cloudflare } from "cloudflare";
import { z } from "zod";
import { cloudflareOps } from "./connector.ts";
import { alarmOps, type CloudflareApi, containerOps, type ReadBinding, refused } from "./ops.ts";
import { CLOUDFLARE_REGISTRY, copyImage } from "./registry.ts";

/*
 * Cloudflare's driver, over its official SDK (`cloudflare`, Stainless) for the API, and plain
 * `fetch` for the company's own Worker (its health and wake routes) and the image's copy into the
 * account's registry (`registry.ts`). A timeout on each request.
 */

export interface CloudflareDriverOptions {
  /** How long one request may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** How long a create or update waits for the Worker to answer at its new revision. Default 10 minutes: a cold start clones and installs. */
  startTimeoutMs?: number;
  /** How long between two tries of the Worker while it starts. Default 2 000. */
  pollMs?: number;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  CLOUDFLARE_API_TOKEN: z.string().describe("an API token with Workers Scripts Edit and Workers Containers Edit"),
  CLOUDFLARE_ACCOUNT_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "an account id is 32 hexadecimal digits")
    .describe("the account's id, on its dashboard's overview"),
});

/**
 * `cloudflare`, loaded at the first call: a worker that never calls Cloudflare (or the app
 * listing the connector) need not load it. It takes `fetch` as a client is made, so a test's
 * replay, listening by then, sees its requests.
 */
const sdk = () => import("cloudflare");
type Sdk = Awaited<ReturnType<typeof sdk>>;

/**
 * The DriverError for a request that failed: Cloudflare's status and its first error's code as
 * `vendorCode` for a reply, retryable for a timeout or no reply.
 */
function failure(what: string, { APIError, APIConnectionTimeoutError }: Sdk, timeoutMs: number, error: unknown) {
  if (error instanceof APIConnectionTimeoutError) {
    return new DriverError(`cloudflare: ${what}: no reply in ${timeoutMs} ms`, { retryable: true, cause: error });
  }
  if (error instanceof APIError && typeof error.status === "number") {
    const { status } = error;
    const [first] = error.errors ?? [];
    return new DriverError(`cloudflare: ${what} answered ${status}: ${first?.message ?? error.message}`, {
      retryable: retryableStatus(status),
      status,
      cause: error,
      ...(first?.code !== undefined && { vendorCode: String(first.code) }),
    });
  }
  return new DriverError(`cloudflare: ${what}: no reply`, { retryable: true, cause: error });
}

const isStatus = (error: unknown, status: number) => error instanceof DriverError && error.status === status;

/** A request to a Worker, with a timeout: a redirect is no answer of the Worker's, and would carry the token elsewhere. */
const sender = (timeoutMs: number) => (url: string, init: RequestInit) =>
  fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });

/**
 * The account at `CLOUDFLARE_ACCOUNT_ID` with `CLOUDFLARE_API_TOKEN`, read when an operation is
 * called. `subdomains` keeps each account's workers.dev subdomain once read, for the driver's life.
 */
function accountApi(timeoutMs: number, subdomains: Map<string, Promise<string>>): CloudflareApi {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw refused(`CLOUDFLARE_API_TOKEN is not set (${env.shape.CLOUDFLARE_API_TOKEN.description})`);
  if (!account_id) throw refused(`CLOUDFLARE_ACCOUNT_ID is not set (${env.shape.CLOUDFLARE_ACCOUNT_ID.description})`);
  let client: Promise<{ cf: Cloudflare; sdk: Sdk }> | undefined;
  /** Sends `request` with the SDK, each failure a `DriverError`. */
  const calling = async <T>(what: string, request: (cf: Cloudflare) => Promise<T>): Promise<T> => {
    client ??= sdk().then((loaded) => ({
      sdk: loaded,
      // No retries of the SDK's own: the runtime retries what is retryable, as a step.
      cf: new loaded.Cloudflare({ apiToken: token, timeout: timeoutMs, maxRetries: 0 }),
    }));
    const { cf, sdk: loaded } = await client;
    try {
      return await request(cf);
    } catch (error) {
      throw failure(what, loaded, timeoutMs, error);
    }
  };
  /** `request`'s answer, or undefined for a 404: no such object. */
  const found = async <T>(what: string, request: (cf: Cloudflare) => Promise<T>): Promise<T | undefined> => {
    try {
      return await calling(what, request);
    } catch (error) {
      if (isStatus(error, 404)) return undefined;
      throw error;
    }
  };

  return {
    async workerUrl(script) {
      let subdomain = subdomains.get(account_id);
      if (!subdomain) {
        subdomain = calling(
          "GET workers/subdomain",
          async (cf) => (await cf.workers.subdomains.get({ account_id })).subdomain,
        );
        subdomains.set(account_id, subdomain);
        subdomain.catch(() => subdomains.delete(account_id));
      }
      return `https://${script}.${await subdomain}.workers.dev`;
    },
    bindings: (script) =>
      found(`GET workers/scripts/${script}/settings`, async (cf) => {
        const settings = await cf.workers.scripts.scriptAndVersionSettings.get(script, { account_id });
        return (settings.bindings ?? []) as ReadBinding[];
      }),
    async upload(script, { modules, ...metadata }) {
      await calling(`PUT workers/scripts/${script}`, async (cf) => {
        // The form as Cloudflare reads it (and Wrangler sends it): one part `metadata`, the JSON, and
        // one part per module, named after it. The SDK's `workers.scripts.update` flattens the
        // metadata into `metadata[main_module]` parts instead, which Cloudflare refuses ("Could not
        // read content for part 'metadata'", found live 2026-10-28). `containers` is Wrangler's,
        // which the SDK's type does not have yet.
        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
        for (const { name, content } of modules) {
          form.append(name, new Blob([content], { type: "application/javascript+module" }), name);
        }
        await cf.put(`/accounts/${account_id}/workers/scripts/${script}`, { body: form });
      });
    },
    async enableSubdomain(script) {
      await calling(`POST workers/scripts/${script}/subdomain`, (cf) =>
        cf.workers.scripts.subdomain.create(script, { account_id, enabled: true }),
      );
    },
    async deleteScript(script) {
      await found(`DELETE workers/scripts/${script}`, (cf) =>
        cf.workers.scripts.delete(script, { account_id, force: true }),
      );
    },
    application: (name) =>
      calling(`GET containers/applications?name=${name}`, async (cf) => {
        const page = await cf.containers.applications.list({ account_id, name });
        const app = page.result.find((a) => a.name === name);
        return app && { id: app.id };
      }),
    createApplication: (name, namespace_id) =>
      calling("POST containers/applications", async (cf) => {
        // The `durable_object` policy, the one for new applications (`default` is refused: "This
        // account cannot create applications with the "default" scheduling policy", found live
        // 2026-10-28). The object starts the container with its image and instance type, so the
        // body names neither.
        const { id } = await cf.containers.applications.create({
          account_id,
          name,
          scheduling_policy: "durable_object",
          durable_objects: { namespace_id },
          // The container's output goes to the account's logs: what a start that never answers
          // was doing is readable there, and nowhere else.
          observability: { logs: { enabled: true } },
        });
        return { id };
      }),
    async prepareImage(image) {
      const { status, reason } = await calling("POST containers/image-preparations", (cf) =>
        cf.containers.images.prepare({ account_id, image }),
      );
      return { status, ...(reason && { reason }) };
    },
    account: account_id,
    async copyImage(image) {
      // Push and pull for an hour, never stored: each copy asks for its own.
      const { username, password } = await calling(
        `POST containers/registries/${CLOUDFLARE_REGISTRY}/credentials`,
        (cf) =>
          cf.containers.registries.credentials.generate(CLOUDFLARE_REGISTRY, {
            account_id,
            permissions: ["push", "pull"],
            expiration_minutes: 60,
          }),
      );
      return copyImage(image, { account: account_id, username, password });
    },
    async deleteApplication(id) {
      await found(`DELETE containers/applications/${id}`, (cf) =>
        cf.containers.applications.delete(id, { account_id }),
      );
    },
    send: sender(timeoutMs),
  };
}

/**
 * The real Cloudflare account at `CLOUDFLARE_ACCOUNT_ID`, with `CLOUDFLARE_API_TOKEN`: the
 * company's Worker and its container application (`cloudflare.container`), and its object's alarm
 * over the Worker's wake route with the company's `SANOMA_WAKEUP_TOKEN` (`cloudflare.alarm`). See
 * the README.
 */
export function cloudflareDriver(options: CloudflareDriverOptions = {}) {
  const { timeoutMs = 30_000, startTimeoutMs = 10 * 60_000, pollMs = 2_000 } = options;
  const subdomains = new Map<string, Promise<string>>();
  const api = () => accountApi(timeoutMs, subdomains);
  // The alarm only calls the Worker, so it needs no account.
  const worker = { send: sender(timeoutMs) };
  return defineDriver(
    cloudflareOps,
    { container: containerOps(api, { startTimeoutMs, pollMs }), alarm: alarmOps(() => worker) },
    { env },
  );
}
