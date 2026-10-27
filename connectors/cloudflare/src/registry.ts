import { createHash } from "node:crypto";
import { DriverError, errorMessage, retryableStatus } from "@sanoma-ai/workflows";

/*
 * The runtime image copied into the account's registry, registry to registry over the OCI
 * distribution API with `fetch`, no Docker: a container application runs an image of its own
 * account's registry, which Cloudflare pulls without a limit and caches. The source is pulled
 * anonymously (`ghcr.io/sanoma-ai/runtime`, public), the target pushed to with the temporary
 * credentials the driver gets from Cloudflare.
 */

/** Cloudflare's registry. An image already there runs as declared; any other is copied in. */
export const CLOUDFLARE_REGISTRY = "registry.cloudflare.com";

/** The one image manifest a copy takes, never an index: the release pushes one (`provenance: false`). */
const MANIFESTS = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

/** An image reference split up, as Docker reads it: `ghcr.io` / `sanoma-ai/runtime` / `:` / `0.8.1` (or `@` / `sha256:…`). */
function parse(image: string) {
  const at = image.indexOf("@");
  const colon = image.lastIndexOf(":");
  const split = at >= 0 ? at : colon > image.lastIndexOf("/") ? colon : image.length;
  const path = image.slice(0, split);
  const first = path.slice(0, Math.max(0, path.indexOf("/")));
  // A first part that is no host name is a Docker Hub path, a one-part one an official image's.
  const named = /[.:]/.test(first) || first === "localhost";
  const host = named ? first : "docker.io";
  const rest = named ? path.slice(first.length + 1) : path;
  const hub = host === "docker.io";
  return {
    host: hub ? "registry-1.docker.io" : host,
    name: hub && !rest.includes("/") ? `library/${rest}` : rest,
    sep: image[split] ?? "",
    reference: image.slice(split + 1),
  };
}

/**
 * The image the account's container application runs for `image`: `image` itself when it is in
 * Cloudflare's registry, else its copy there, `<registry>/<account>/<path with - for />:<tag>`
 * (`ghcr.io/sanoma-ai/runtime:0.8.1` → `registry.cloudflare.com/<account>/sanoma-ai-runtime:0.8.1`).
 */
export function accountImage(image: string, account: string, registry = CLOUDFLARE_REGISTRY): string {
  if (image.startsWith(`${CLOUDFLARE_REGISTRY}/`)) return image;
  const { name, sep, reference } = parse(image);
  return `${registry}/${account}/${name.replaceAll("/", "-")}${sep}${reference}`;
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
 * Copies `image` into the account's registry, unless it is there already (the target's manifest by
 * that tag has the source's digest), and returns the reference the application runs
 * (`accountImage`). Each blob the target lacks is streamed from the source; the manifest goes
 * last, its bytes and media type unchanged, so its digest is the source's. Each request may take
 * `timeoutMs`. A failure is a `DriverError`, retryable as its status is; the credentials are in no
 * message.
 */
export async function copyImage(image: string, target: CopyTarget, timeoutMs: number): Promise<string> {
  const registry = target.registry ?? CLOUDFLARE_REGISTRY;
  const copy = accountImage(image, target.account, registry);
  if (copy === image) return image;
  const source = parse(image);
  const to = parse(copy);
  const ref = source.reference;

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
   * The `authorization` header for `scope` on `host`, as a Docker client finds it: none when `/v2/`
   * answers, the basic credentials when it asks for them, else a token from the realm its
   * `Bearer` challenge names (with the basic credentials, when there are any).
   */
  const authorize = async (host: string, scope: string, basic?: string): Promise<Record<string, string>> => {
    const given: Record<string, string> = basic ? { authorization: basic } : {};
    const ping = await ask(`${origin(host)}/v2/`, { headers: given }, [401]);
    if (ping.ok) return given;
    const challenge = ping.headers.get("www-authenticate") ?? "";
    if (/^basic/i.test(challenge) && basic) return given;
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k!, v!]));
    if (!/^bearer/i.test(challenge) || !params.realm) {
      throw new DriverError(`cloudflare: copying ${image}: ${host} asks for no credentials it can be given`, {
        retryable: false,
        status: 401,
      });
    }
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set("service", params.service);
    url.searchParams.set("scope", scope);
    const { token, access_token } = (await (await send(url.href, { headers: given })).json()) as {
      token?: string;
      access_token?: string;
    };
    return { authorization: `Bearer ${token ?? access_token}` };
  };

  const pull = await authorize(source.host, `repository:${source.name}:pull`);
  const from = `${origin(source.host)}/v2/${source.name}`;
  const got = await send(`${from}/manifests/${ref}`, { headers: { ...pull, accept: MANIFESTS.join(", ") } });
  const mediaType = got.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const bytes = new Uint8Array(await got.arrayBuffer());
  if (!MANIFESTS.includes(mediaType)) {
    throw new DriverError(`cloudflare: copying ${image}: its manifest is ${mediaType || "untyped"}, not one image's`, {
      retryable: false,
    });
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  const basic = `Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`;
  const push = await authorize(to.host, `repository:${to.name}:pull,push`, basic);
  const into = `${origin(to.host)}/v2/${to.name}`;
  const there = await ask(
    `${into}/manifests/${ref}`,
    { method: "HEAD", headers: { ...push, accept: mediaType } },
    [404],
  );
  if (there.ok && there.headers.get("docker-content-digest") === digest) return copy;

  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
    config: { digest: string };
    layers: { digest: string }[];
  };
  for (const { digest: blob } of [manifest.config, ...manifest.layers]) {
    const head = await ask(`${into}/blobs/${blob}`, { method: "HEAD", headers: push }, [404]);
    if (head.ok) continue;
    const started = await ask(`${into}/blobs/uploads/`, { method: "POST", headers: push });
    const location = new URL(started.headers.get("location") ?? "", `${into}/blobs/uploads/`);
    location.searchParams.set("digest", blob);
    const body = await send(`${from}/blobs/${blob}`, { headers: pull });
    await ask(location.href, {
      method: "PUT",
      headers: { ...push, "content-type": "application/octet-stream" },
      body: body.body,
      duplex: "half",
    });
  }
  await ask(`${into}/manifests/${ref}`, {
    method: "PUT",
    headers: { ...push, "content-type": mediaType },
    body: bytes,
  });
  return copy;
}
