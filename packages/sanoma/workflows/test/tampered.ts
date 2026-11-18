/**
 * `token` with one character changed, in the middle of its last dot-separated part (a JWT's
 * signature; the whole of a sealed value with no dot): what a test presents as a forgery. Never
 * the token itself, whatever its characters, and never a change only to a last character's unused
 * bits, which decodes to the same bytes.
 */
export function tampered(token: string): string {
  const start = token.lastIndexOf(".") + 1;
  const at = start + Math.floor((token.length - start) / 2);
  return `${token.slice(0, at)}${token[at] === "A" ? "B" : "A"}${token.slice(at + 1)}`;
}
