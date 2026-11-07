import { createPrivateKey, createPublicKey, generateKeyPair, type KeyObject } from "node:crypto";
import { promisify } from "node:util";

// SSH key pairs, as a deploy key needs them: what going live makes (the app's `goLive`) and
// `sanoma.secret.generate`'s `ssh-rsa` kind.

/** RFC 4253's `string`: the bytes after their length, 32 bits big-endian. */
function sshString(bytes: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** RFC 4253's `mpint` of a JWK's integer, unsigned with no leading zero: one first when its top bit is set. */
function sshMpint(value: string) {
  const bytes = Buffer.from(value, "base64url");
  return sshString(bytes[0]! & 0x80 ? Buffer.concat([Buffer.of(0), bytes]) : bytes);
}

/** An RSA public key in OpenSSH's one-line format, as GitHub takes it: `ssh-rsa`, then the base64 of the strings `ssh-rsa`, `e` and `n`. */
function openSshLine(publicKey: KeyObject): string {
  const { e, n } = publicKey.export({ format: "jwk" });
  const wire = Buffer.concat([sshString(Buffer.from("ssh-rsa")), sshMpint(e!), sshMpint(n!)]);
  return `ssh-rsa ${wire.toString("base64")}`;
}

/**
 * A new deploy key: its private half RSA 3072 in PKCS#1 PEM, which OpenSSH reads as it is (Node
 * writes no OpenSSH private key, which ed25519 would need), and its public half in OpenSSH's
 * one-line format (`sshPublicKey`).
 */
export async function sourceKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const { privateKey, publicKey } = await promisify(generateKeyPair)("rsa", { modulusLength: 3072 });
  return {
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey: openSshLine(publicKey),
  };
}

/** The public half of an RSA private key in PEM, in OpenSSH's one-line format; undefined for anything else. */
export function sshPublicKey(privateKey: string): string | undefined {
  try {
    const key = createPublicKey(createPrivateKey(privateKey));
    return key.asymmetricKeyType === "rsa" ? openSshLine(key) : undefined;
  } catch {
    return undefined;
  }
}
