import { createSign } from "node:crypto";
import { DriverError, retryableStatus } from "@sanoma-ai/workflows";
import { z } from "zod";

// GitHub's REST API over plain `fetch`, as the remote half and the operations through the App call
// it: GitHub's media type and `X-GitHub-Api-Version: 2022-11-28`, its failures as `DriverError`s.

/** The secrets of the company's GitHub App the remote half and the operations through the App read, as the app's manifest flow stores them. */
export const GITHUB_APP_SECRETS = {
  id: "SANOMA_GITHUB_APP_ID",
  pem: "SANOMA_GITHUB_APP_PEM",
  webhook_secret: "SANOMA_GITHUB_WEBHOOK_SECRET",
} as const;

const API = "https://api.github.com";

const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT the GitHub App signs for itself, good for 9 minutes: what its installations are listed and its tokens minted with. */
export function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem, "base64url")}`;
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

/** One call to GitHub's REST API, signed in with `token`; a failure to reach it is a retryable `DriverError`. */
export async function send(token: string, method: string, path: string, body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sanoma",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    // The body too: the timeout may fire while it streams.
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: parseJson(text) };
  } catch (cause) {
    throw new DriverError(`github: ${method} ${path}: the request failed`, { retryable: true, cause });
  }
}

/** `text` as JSON, else the text itself (undefined when empty). */
function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/** A rate limit: a 429, or a 403 with no requests left or a `retry-after` (GitHub's secondary limits). */
export const limited = ({ status, headers }: Reply) =>
  status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after")));

/** GitHub's answer as a `DriverError`, its message GitHub's own; retryable on a rate limit or a server error. */
export function failed(method: string, path: string, reply: Reply, vendorCode?: string): DriverError {
  const said = typeof reply.body?.message === "string" ? reply.body.message : `status ${reply.status}`;
  // A 422's `message` is "Validation Failed"; what failed is in its `errors`.
  const errors: unknown[] = Array.isArray(reply.body?.errors) ? reply.body.errors : [];
  const why = errors.flatMap((e) =>
    typeof (e as { message?: unknown })?.message === "string" ? [(e as { message: string }).message] : [],
  );
  const message = why.length ? `${said}: ${why.join("; ")}` : said;
  return new DriverError(`github: ${method} ${path} answered ${reply.status}: ${message}`, {
    retryable: retryableStatus(reply.status) || limited(reply),
    status: reply.status,
    ...(vendorCode && { vendorCode }),
  });
}

/** The body of a 2xx answer, read with `schema`; anything else a `DriverError`. */
export async function ok<T>(
  token: string,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const reply = await send(token, method, path, body);
  if (reply.status >= 300) throw failed(method, path, reply);
  return read(schema, reply.body, `${method} ${path}`);
}

export function read<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DriverError(`github: ${what} answered what Sanoma cannot read: ${z.prettifyError(parsed.error)}`, {
      retryable: false,
    });
  }
  return parsed.data;
}

/** A branch name in a path, each `/`-separated part encoded. */
export const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

const AccessToken = z.object({ token: z.string(), expires_at: z.string() });

/**
 * An installation token of the App, minted with its JWT, good for an hour; for the repositories
 * `repositories` alone when given, which GitHub refuses (422) when the installation does not cover them.
 */
export async function installationToken(jwt: string, installation: number, repositories?: string[]) {
  const scope = repositories && { repositories };
  const made = await ok(jwt, "POST", `/app/installations/${installation}/access_tokens`, AccessToken, scope);
  return { token: made.token, expiresAt: Date.parse(made.expires_at) };
}
