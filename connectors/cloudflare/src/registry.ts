import { createHash } from "node:crypto";
import { DriverError, errorMessage, retryableStatus } from "@sanoma-ai/workflows";

/*
 * The runtime image copied into the account's registry, registry to registry over the OCI
 * distribution API with `fetch`, no Docker: a container application of the `durable_object`
 * scheduling policy runs only an image of its own account's registry, pinned by digest, which
 * Cloudflare pulls without a limit and caches. The source is pulled anonymously
 * (`ghcr.io/sanoma-ai/runtime`, public), the target pushed to with the temporary credentials the
 * driver gets from Cloudflare.
 */

/** Cloudflare's registry. An image already in the account's runs as declared; any other is copied in. */
export const CLOUDFLARE_REGISTRY = "registry.cloudflare.com";

/** The one image manifest a copy takes, never an index: the release pushes one (`provenance: false`). */
const MANIFESTS = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

/**
 * An image reference split up: `ghcr.io` / `sanoma-ai/runtime` / `:` / `0.8.1` (or `@` /
 * `sha256:…`; a tag beside a digest is dropped, as the digest names the image).
 */
function parse(image: string) {
  const at = image.indexOf("@");
  const named = at >= 0 ? image.slice(0, at) : image;
  const colon = named.lastIndexOf(":");
  const tagAt = colon > named.lastIndexOf("/") ? colon : named.length;
  const split = at >= 0 ? at : tagAt;
  const path = image.slice(0, tagAt);
  const slash = path.indexOf("/");
  return {
    host: path.slice(0, Math.max(0, slash)),
    name: path.slice(slash + 1),
    sep: image[split] ?? "",
    reference: image.slice(split + 1),
  };
}

/**
 * The image the account's container application runs for `image`: `image` itself when it is in
 * the account's registry, else its copy there, `<registry>/<account>/<path with - for />:<tag>`
 * (`ghcr.io/sanoma-ai/runtime:0.8.1` → `registry.cloudflare.com/<account>/sanoma-ai-runtime:0.8.1`).
 */
export function accountImage(image: string, account: string, registry = CLOUDFLARE_REGISTRY): string {
  if (image.startsWith(`${registry}/${account}/`)) return image;
  const { name, sep, reference } = parse(image);
  return `${registry}/${account}/${name.replaceAll("/", "-")}${sep}${reference}`;
}

/**
 * True when `image` is in the account's registry and pinned by digest: what the application runs
 * as it is, with nothing to copy or ask.
 */
export function accountPinned(image: string, account: string, registry = CLOUDFLARE_REGISTRY): boolean {
  return image.startsWith(`${registry}/${account}/`) && parse(image).sep === "@";
}

/** `image`'s repository at `digest`: `<registry>/<path>@sha256:…`, the one reference the application takes. */
export function pinImage(image: string, digest: string): string {
  const { host, name } = parse(image);
  return `${host}/${name}@${digest}`;
}

/** Where a copy goes: the account's registry, and the temporary credentials that push to it. */
export interface CopyTarget {
  account: string;
  username: string;
  password: string;
  /** The registry's host. Default Cloudflare's; a test's own on this machine. */
  registry?: string;
}

/** A registry on this machine is spoken to over HTTP, as Docker does; any other over HTTPS. */
const origin = (host: string) => `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"}://${host}`;

/**
 * Copies `image` into the account's registry as `accountImage(image)`, unless the target's
 * manifest by that tag has the source's digest already, and returns the copy pinned by that
 * digest (`pinImage`). Each blob the target lacks is streamed from the source; the manifest goes
 * last, its bytes and media type unchanged, so its digest is the source's. An image in the
 * account's registry already is not copied: pinned by digest it is returned as it is, by a tag
 * its manifest's digest is asked for. Each request may take `timeoutMs` (default ten minutes: a
 * layer streams through). A failure is a `DriverError`, retryable as its status is; the
 * credentials are in no message.
 */
export async function copyImage(image: string, target: CopyTarget, timeoutMs = 10 * 60_000): Promise<string> {
  const source = parse(image);
  const copy = accountImage(image, target.account, target.registry);
  const to = parse(copy);
  const ref = source.reference;
  const refuse = (why: string) => new DriverError(`cloudflare: copying ${image}: ${why}`, { retryable: false });
  if (copy === image && source.sep === "@") return image;
  // Docker Hub is not copied from: its API is on another host, and its pulls are limited.
  if (!/[.:]/.test(source.host) || source.host === "docker.io") {
    throw refuse("name the registry it is in, not Docker Hub: ghcr.io/sanoma-ai/runtime:<version>");
  }

  /** A request of the copy's: an answer that is not `ok` (or in `also`) is a DriverError. */
  const send = async (url: string, init: RequestInit & { duplex?: "half" }, also: number[] = []) => {
    const where = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      throw new DriverError(`cloudflare: copying ${image}: ${where}: no answer (${errorMessage(cause)})`, {
        retryable: true,
        cause,
      });
    }
    if (res.ok || also.includes(res.status)) return res;
    await res.body?.cancel();
    throw new DriverError(`cloudflare: copying ${image}: ${where} answered ${res.status}`, {
      retryable: retryableStatus(res.status),
      status: res.status,
    });
  };
  /** `send` for an answer whose body is not read: its status and headers. */
  const ask = async (...args: Parameters<typeof send>) => {
    const res = await send(...args);
    await res.body?.cancel();
    return res;
  };

  /**
   * The `authorization` header for `scope` on `host`, as a Docker client finds it: none (or the
   * basic credentials) when `/v2/` answers, else a token from the realm its `Bearer` challenge
   * names (asked with the basic credentials, when there are any).
   */
  const authorize = async (host: string, scope: string, basic?: string): Promise<Record<string, string>> => {
    const given: Record<string, string> = basic ? { authorization: basic } : {};
    const ping = await ask(`${origin(host)}/v2/`, { headers: given }, [401]);
    if (ping.ok) return given;
    const challenge = ping.headers.get("www-authenticate") ?? "";
    if (/^basic/i.test(challenge) && basic) throw refuse(`${host} refused the temporary credentials`);
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k!, v!]));
    if (!/^bearer/i.test(challenge) || !params.realm) {
      throw refuse(`${host} asks for no credentials it can be given`);
    }
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set("service", params.service);
    url.searchParams.set("scope", scope);
    const { token, access_token } = (await (await send(url.href, { headers: given })).json()) as {
      token?: string;
      access_token?: string;
    };
    if (!(token ?? access_token)) throw refuse(`${url.origin}${url.pathname} gave no token`);
    return { authorization: `Bearer ${token ?? access_token}` };
  };

  const basic = `Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`;
  const into = `${origin(to.host)}/v2/${to.name}`;
  if (copy === image) {
    // In the account by a tag (pushed by hand): only its digest is asked for.
    const auth = await authorize(to.host, `repository:${to.name}:pull`, basic);
    const there = await ask(`${into}/manifests/${ref}`, {
      method: "HEAD",
      headers: { ...auth, accept: MANIFESTS.join(", ") },
    });
    const digest = there.headers.get("docker-content-digest");
    if (!digest?.startsWith("sha256:")) throw refuse("the account's registry named no digest for it");
    return pinImage(image, digest);
  }

  const pull = await authorize(source.host, `repository:${source.name}:pull`);
  const from = `${origin(source.host)}/v2/${source.name}`;
  const got = await send(`${from}/manifests/${ref}`, { headers: { ...pull, accept: MANIFESTS.join(", ") } });
  const mediaType = got.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const bytes = new Uint8Array(await got.arrayBuffer());
  if (!MANIFESTS.includes(mediaType)) throw refuse(`its manifest is ${mediaType || "untyped"}, not one image's`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (source.sep === "@" && digest !== ref) throw refuse(`its registry answered a manifest of digest ${digest}`);

  const push = await authorize(to.host, `repository:${to.name}:pull,push`, basic);
  const there = await ask(
    `${into}/manifests/${ref}`,
    { method: "HEAD", headers: { ...push, accept: mediaType } },
    [404],
  );
  if (there.ok && there.headers.get("docker-content-digest") === digest) return pinImage(copy, digest);

  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
    config: { digest: string; size: number };
    layers: { digest: string; size: number }[];
  };
  for (const { digest: blob, size } of [manifest.config, ...manifest.layers]) {
    const head = await ask(`${into}/blobs/${blob}`, { method: "HEAD", headers: push }, [404]);
    if (head.ok) continue;
    const started = await ask(`${into}/blobs/uploads/`, { method: "POST", headers: push });
    const location = new URL(started.headers.get("location") ?? "", `${into}/blobs/uploads/`);
    location.searchParams.set("digest", blob);
    const { body } = await send(`${from}/blobs/${blob}`, { headers: pull });
    // One monolithic upload of a known length, streamed: no layer is held in memory.
    await ask(location.href, {
      method: "PUT",
      headers: { ...push, "content-type": "application/octet-stream", "content-length": String(size) },
      body,
      duplex: "half",
    }).catch(async (error: unknown) => {
      await body?.cancel().catch(() => undefined);
      throw error;
    });
  }
  await ask(`${into}/manifests/${ref}`, {
    method: "PUT",
    headers: { ...push, "content-type": mediaType },
    body: bytes,
  });
  return pinImage(copy, digest);
}
