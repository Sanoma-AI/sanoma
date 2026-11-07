import { createVerify, generateKeyPairSync } from "node:crypto";
import type { Exchange } from "sanoma/testing/replay";
import { GITHUB_APP_SECRETS } from "../src/rest.ts";

// What the tests signing as the App share: its keys, the check of a JWT's signer, and the scrub
// that keeps the tokens GitHub mints out of a recording.

/** What a recording must not keep: a token GitHub minted. */
export const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(JSON.stringify(exchanges).replaceAll(/"token":"[^"]*"/g, '"token":"ghs_recorded"'));

/** The App's keys: a key pair of its own, made once. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const app = { [GITHUB_APP_SECRETS.id]: "4242", [GITHUB_APP_SECRETS.pem]: pem };

/** The App's id a request's JWT is signed by, or "nobody" when the signature does not verify. */
export const signer = (headers: Headers) => {
  const [head, body, signature] = headers.get("authorization")!.replace("Bearer ", "").split(".");
  const verified = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, signature!, "base64url");
  return verified ? JSON.parse(Buffer.from(body!, "base64url").toString()).iss : "nobody";
};
