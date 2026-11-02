import { createHash } from "node:crypto";
import type { IdentityEnrollment, IdentityEnrollments, IdentityAudit } from "./cloud-identity.ts";

const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT = /^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const credentialHash = (credential: string) => createHash("sha256").update(credential).digest("hex");

const validEnrollment = (e: IdentityEnrollment | undefined): e is IdentityEnrollment =>
  !!e &&
  [e.deployment, e.company, e.environment].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256) &&
  ACCOUNT.test(e.serviceAccount) &&
  Number.isSafeInteger(e.generation) &&
  e.generation > 0;
const reply = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });

// Node/edge adapters can represent an empty POST as a stream. Reject actual bytes,
// without buffering attacker-controlled input or waiting indefinitely for its end.
async function hasBody(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Invalid broker request")), 5_000);
      }),
    ]);
    return !first.done;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }
}

/** Shared server-only issuance boundary. Public factories fix the route, audience and token kind. */
export function enrollmentBroker<T extends { expiresAt: number }>(options: {
  path: string;
  method: "GET" | "POST";
  enrollments: IdentityEnrollments;
  accept(enrollment: IdentityEnrollment): boolean;
  issue(enrollment: IdentityEnrollment): Promise<T>;
  valid(token: T, now: number): boolean;
  body(token: T): unknown;
  audit(event: IdentityAudit): Promise<void>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    let enrollment: IdentityEnrollment | undefined;
    try {
      const url = new URL(request.url);
      if (url.pathname !== options.path || request.method !== options.method) return reply(404, { error: "not_found" });
      if (url.search || (await hasBody(request))) return reply(400, { error: "invalid_request" });
      const authorization = request.headers.get("authorization") ?? "";
      const credential = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const hash = CREDENTIAL.test(credential) ? credentialHash(credential) : undefined;
      enrollment = hash ? await options.enrollments.active(hash) : undefined;
      if (!validEnrollment(enrollment) || !options.accept(enrollment)) {
        await options.audit({ result: "denied" });
        return reply(401, { error: "unauthorized" });
      }
      // Copy authoritative values before any awaits; caller fields never select a target or lifetime.
      enrollment = {
        deployment: enrollment.deployment,
        company: enrollment.company,
        environment: enrollment.environment,
        serviceAccount: enrollment.serviceAccount,
        generation: enrollment.generation,
      };
      const token = await options.issue(enrollment);
      if (!options.valid(token, Date.now())) throw new Error("Invalid issued token");
      const current = await options.enrollments.active(hash!);
      if (
        !current ||
        (Object.keys(enrollment) as (keyof IdentityEnrollment)[]).some((key) => current[key] !== enrollment![key])
      ) {
        await options.audit({ result: "denied", enrollment });
        return reply(401, { error: "unauthorized" });
      }
      await options.audit({ result: "issued", enrollment, expiresAt: token.expiresAt });
      return reply(200, options.body(token));
    } catch {
      try {
        await options.audit({ result: "unavailable", ...(enrollment && { enrollment }) });
      } catch {
        /* fail closed */
      }
      return reply(503, { error: "unavailable" });
    }
  };
}
