import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { deploymentKey } from "./deployment-key.ts";

// Small values sealed under a key of their own, derived from the deployment's SANOMA_SIGNING_KEY
// for one purpose (HKDF-SHA256): a sign-in code in a `login-code` run's input, and a request for
// an invite that a holder of the key sends to the instance (`POST /auth/invite`). AES-256-GCM, the
// purpose as its additional data, so a value sealed for one purpose never opens for another.

const IV = 12;
const TAG = 16;

const keyFor = (purpose: string) =>
  Buffer.from(hkdfSync("sha256", deploymentKey("SANOMA_SIGNING_KEY"), "", purpose, 32));

/** `value` as JSON, sealed for `purpose`: base64url of the IV, the tag and the ciphertext. */
function seal(purpose: string, value: unknown): string {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), iv).setAAD(Buffer.from(purpose));
  const text = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), text]).toString("base64url");
}

/** What `seal(purpose, …)` sealed, or undefined for anything else: another key, another purpose, a change. */
function unseal(purpose: string, sealed: string): unknown {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length <= IV + TAG) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), bytes.subarray(0, IV))
      .setAAD(Buffer.from(purpose))
      .setAuthTag(bytes.subarray(IV, IV + TAG));
    const text = Buffer.concat([decipher.update(bytes.subarray(IV + TAG)), decipher.final()]);
    return JSON.parse(text.toString("utf8"));
  } catch {
    return undefined;
  }
}

const CODE = "login code";
const INVITE = "invite request";

/** A sign-in code sealed for a `login-code` run's input, so the run's input never shows it. */
export const sealLoginCode = (code: string): string => seal(CODE, code);

/** The code `sealLoginCode` sealed; throws for anything else. */
export function openLoginCode(sealed: string): string {
  const code = unseal(CODE, sealed);
  if (typeof code !== "string") throw new Error("The sign-in code is not one this deployment sealed");
  return code;
}

/** A request for an invite (`POST /auth/invite { request }`): for whom, until when (ms since the epoch), and a nonce. */
export interface InviteRequest {
  email: string;
  exp: number;
  nonce: string;
}

/** How long a sealed invite request is good for when `exp` is not given: five minutes. */
const INVITE_REQUEST_MS = 5 * 60_000;

/**
 * A request for `email`'s invite, sealed under a key derived from `SANOMA_SIGNING_KEY` (purpose
 * `invite request`): what a holder of the deployment's signing key sends the instance as
 * `POST /auth/invite { request }` (going live, and Sanoma Cloud's birth invite). `exp` defaults
 * to five minutes from now, `nonce` to 16 random bytes.
 */
export function sealInvite({ email, exp, nonce }: { email: string; exp?: number; nonce?: string }): string {
  return seal(INVITE, {
    email,
    exp: exp ?? Date.now() + INVITE_REQUEST_MS,
    nonce: nonce ?? randomBytes(16).toString("base64url"),
  } satisfies InviteRequest);
}

/** The request `sealInvite` sealed, while `exp` is after `now`; undefined for anything else, or once it expired. */
export function openInvite(sealed: string, now = Date.now()): InviteRequest | undefined {
  const request = unseal(INVITE, sealed) as Partial<InviteRequest> | undefined;
  if (typeof request?.email !== "string" || typeof request.exp !== "number" || typeof request.nonce !== "string")
    return undefined;
  return request.exp > now ? (request as InviteRequest) : undefined;
}
