import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountImage, copyImage } from "../src/registry.ts";

// The image's copy against two small OCI registries in this process: a source that hands out an
// anonymous bearer token, as ghcr.io does, and a target that takes basic credentials, as the
// account's registry takes the temporary ones Cloudflare makes. The driver's own call for those
// credentials is in driver.test.ts.

const OCI = "application/vnd.oci.image.manifest.v1+json";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A registry in this process: its manifests and blobs, and the requests it took. */
async function registry(auth: "bearer" | "basic") {
  const manifests = new Map<string, { type: string; bytes: Buffer }>();
  const blobs = new Map<string, Buffer>();
  const seen: string[] = [];
  let uploads = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://registry");
    seen.push(`${req.method} ${url.pathname}`);
    const origin = `http://${req.headers.host}`;
    if (url.pathname === "/token") {
      expect(url.searchParams.get("scope")).toBe("repository:sanoma-ai/runtime:pull");
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "anon" }));
    }
    const allowed =
      auth === "bearer"
        ? req.headers.authorization === "Bearer anon"
        : req.headers.authorization === `Basic ${Buffer.from("user:pass").toString("base64")}`;
    if (!allowed) {
      const challenge = auth === "bearer" ? `Bearer realm="${origin}/token",service="test"` : `Basic realm="test"`;
      return void res.writeHead(401, { "www-authenticate": challenge }).end();
    }
    if (url.pathname === "/v2/") return void res.writeHead(200).end();
    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    if (manifest) {
      const key = `${manifest[1]}:${manifest[2]}`;
      if (req.method === "PUT") {
        manifests.set(key, { type: req.headers["content-type"]!, bytes: body });
        return void res.writeHead(201).end();
      }
      const found = manifests.get(key);
      if (!found) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": found.type, "docker-content-digest": sha(found.bytes) });
      return void res.end(req.method === "HEAD" ? undefined : found.bytes);
    }
    if (req.method === "POST" && url.pathname.endsWith("/blobs/uploads/")) {
      return void res.writeHead(202, { location: `${url.pathname}${++uploads}?state=s` }).end();
    }
    if (req.method === "PUT" && url.pathname.includes("/blobs/uploads/")) {
      const digest = url.searchParams.get("digest")!;
      expect(url.searchParams.get("state")).toBe("s");
      if (sha(body) !== digest) return void res.writeHead(400).end();
      blobs.set(digest, body);
      return void res.writeHead(201).end();
    }
    const blob = /\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
    const found = blob && blobs.get(blob[1]!);
    if (!found) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": found.length });
    res.end(req.method === "HEAD" ? undefined : found);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    manifests,
    blobs,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe("copyImage", () => {
  let source: Awaited<ReturnType<typeof registry>>;
  let target: Awaited<ReturnType<typeof registry>>;
  const config = Buffer.from('{"architecture":"amd64","os":"linux"}');
  const layers = [Buffer.alloc(300_000, 1), Buffer.alloc(200_000, 2)];
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha(config), size: config.length },
      layers: layers.map((l) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: sha(l),
        size: l.length,
      })),
    }),
  );

  beforeAll(async () => {
    [source, target] = await Promise.all([registry("bearer"), registry("basic")]);
    for (const blob of [config, ...layers]) source.blobs.set(sha(blob), blob);
    source.manifests.set("sanoma-ai/runtime:0.8.1", { type: OCI, bytes: manifest });
    // One layer is in the account already, as another version's copy leaves it.
    target.blobs.set(sha(layers[0]!), layers[0]!);
  });
  afterAll(() => Promise.all([source.close(), target.close()]));
  beforeEach(() => {
    source.seen.length = 0;
    target.seen.length = 0;
  });

  const image = () => `${source.host}/sanoma-ai/runtime:0.8.1`;
  const to = () => ({ account: ACCOUNT, username: "user", password: "pass", registry: target.host });

  it("streams the blobs the account lacks, then puts the manifest unchanged", async () => {
    const copy = await copyImage(image(), to(), 5_000);
    expect(copy).toBe(`${target.host}/${ACCOUNT}/sanoma-ai-runtime:0.8.1`);
    const name = `/v2/${ACCOUNT}/sanoma-ai-runtime`;
    expect(target.manifests.get(`${ACCOUNT}/sanoma-ai-runtime:0.8.1`)).toEqual({ type: OCI, bytes: manifest });
    for (const blob of [config, ...layers]) expect(target.blobs.get(sha(blob))).toEqual(blob);
    // The layer already there is asked about, never uploaded again.
    expect(target.seen.filter((r) => r.startsWith("POST"))).toEqual([
      `POST ${name}/blobs/uploads/`,
      `POST ${name}/blobs/uploads/`,
    ]);
    expect(source.seen).not.toContain(`GET /v2/sanoma-ai/runtime/blobs/${sha(layers[0]!)}`);
    expect(source.seen).toContain(`GET /v2/sanoma-ai/runtime/blobs/${sha(layers[1]!)}`);
  });

  it("copies nothing when the account's manifest for the tag has the source's digest", async () => {
    await copyImage(image(), to(), 5_000);
    const name = `/v2/${ACCOUNT}/sanoma-ai-runtime`;
    expect(target.seen.filter((r) => r !== "GET /v2/")).toEqual([`HEAD ${name}/manifests/0.8.1`]);
    expect(source.seen.filter((r) => r.includes("/blobs/"))).toEqual([]);
  });

  it("fails without retrying for an image the source does not have, and names no credential", async () => {
    const error = await copyImage(`${source.host}/sanoma-ai/runtime:9.9.9`, to(), 5_000).catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: false, status: 404 });
    expect(String(error)).not.toMatch(/pass|anon/);
  });
});

describe("accountImage", () => {
  it("names the copy in the account's registry, and leaves an image there as it is", () => {
    expect(accountImage("ghcr.io/sanoma-ai/runtime:0.8.1", ACCOUNT)).toBe(
      `registry.cloudflare.com/${ACCOUNT}/sanoma-ai-runtime:0.8.1`,
    );
    const digest = `@sha256:${"a".repeat(64)}`;
    expect(accountImage(`ghcr.io/sanoma-ai/runtime${digest}`, ACCOUNT)).toBe(
      `registry.cloudflare.com/${ACCOUNT}/sanoma-ai-runtime${digest}`,
    );
    expect(accountImage("node:26", ACCOUNT)).toBe(`registry.cloudflare.com/${ACCOUNT}/library-node:26`);
    const there = `registry.cloudflare.com/${ACCOUNT}/sanoma-ai-runtime:0.8.1`;
    expect(accountImage(there, ACCOUNT)).toBe(there);
  });
});
