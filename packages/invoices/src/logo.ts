import { decode, encode } from "fast-png";
import { Unzlib } from "fflate";
import { InvoiceValidationError } from "./calculate.ts";

const invalid = () =>
  new InvoiceValidationError([
    {
      code: "invalid_logo",
      path: ["logo"],
      message:
        "Use a valid non-interlaced, 8-bit RGB or RGBA PNG, up to 256 KiB and 1024 pixels per side. Use RGBA for transparency.",
    },
  ]);

/** Validate before rendering; pass only a sanitized, bounded PNG data URI to React-pdf. */
export function validateLogo(base64: string): string {
  try {
    if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw invalid();
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    if (bytes.length > 256 * 1024 || bytes.length < 45) throw invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452
    )
      throw invalid();
    const width = view.getUint32(16),
      height = view.getUint32(20),
      color = bytes[25];
    if (
      !width ||
      !height ||
      width > 1024 ||
      height > 1024 ||
      bytes[24] !== 8 ||
      (color !== 2 && color !== 6) ||
      bytes[26] !== 0 ||
      bytes[27] !== 0 ||
      bytes[28] !== 0
    )
      throw invalid();
    const expected = height * (width * (color === 6 ? 4 : 3) + 1);
    let inflated = 0,
      ended = false;
    const inflator = new Unzlib((chunk) => {
      inflated += chunk.length;
      if (inflated > expected) throw invalid();
    });
    const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw invalid();
      const size = view.getUint32(offset),
        type = view.getUint32(offset + 4),
        end = offset + size + 12;
      if (end > bytes.length) throw invalid();
      // A color-key transparency chunk would be lost by the encoder. Require RGBA instead.
      if (type === 0x74524e53) throw invalid();
      if (type === 0x49444154) {
        const data = bytes.subarray(offset + 8, end - 4);
        // Bound each decompression batch, including malicious compressed input.
        for (let start = 0; start < data.length; start += 1024) inflator.push(data.subarray(start, start + 1024));
      }
      if ([0x49484452, 0x49444154, 0x49454e44].includes(type)) chunks.push(bytes.subarray(offset, end));
      else if ((bytes[offset + 4]! & 32) === 0) throw invalid();
      if (type === 0x49454e44) {
        if (size !== 0 || end !== bytes.length) throw invalid();
        ended = true;
      }
      if (offset !== 8 && type === 0x49484452) throw invalid();
      offset = end;
    }
    inflator.push(new Uint8Array(), true);
    if (!ended || inflated !== expected) throw invalid();
    // Strip ancillary chunks (profiles, text and animation), then verify CRCs and decode pixels.
    const clean = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      clean.set(chunk, offset);
      offset += chunk.length;
    }
    const decoded = decode(clean, { checkCrc: true });
    return `data:image/png;base64,${btoa(Array.from(encode(decoded), (byte) => String.fromCharCode(byte)).join(""))}`;
  } catch {
    throw invalid();
  }
}
