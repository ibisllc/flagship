// The page photo, re-encoded in the browser (docs/voici-and-messages.md §2.3): square crop from the centre,
// 512 × 512, JPEG at quality 0.82 stepping down to 0.6, at most 150 KiB. Drawing the decoded pixels onto a fresh
// canvas and encoding that drops every EXIF/XMP/ICC/GPS segment; the result is checked anyway (no APP1/APP2).

import { isVoiciJpeg, voiciJpegHasMetadata, VOICI_AVATAR_MAX_BYTES } from "./voiciProtocol.js";

export const VOICI_AVATAR_SIZE = 512;
export const VOICI_AVATAR_QUALITIES = [0.82, 0.76, 0.7, 0.65, 0.6];

/** The centred square crop of a w × h image: {sx, sy, side}. */
export function squareCrop(w, h) {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side };
}

/** An error the editor turns into a sentence. */
export class VoiciImageError extends Error {
  constructor(code) {
    super(code);
    this.name = "VoiciImageError";
    this.code = code;
  }
}

/**
 * Re-encodes a picked image file (or Blob). Resolves the JPEG bytes. `deps.decode` / `deps.encode` are seams for
 * tests: decode(blob) → {width, height, source}, encode(source, crop, size, quality) → Uint8Array.
 */
export async function reencodeAvatar(file, deps = {}) {
  const decode = deps.decode ?? decodeImage;
  const encode = deps.encode ?? encodeJpeg;
  let img;
  try {
    img = await decode(file);
  } catch {
    throw new VoiciImageError("unreadable");
  }
  if (!img?.width || !img?.height) throw new VoiciImageError("unreadable");
  const crop = squareCrop(img.width, img.height);
  for (const q of VOICI_AVATAR_QUALITIES) {
    const bytes = stripJpegMetadata(await encode(img.source, crop, VOICI_AVATAR_SIZE, q));
    if (!bytes || voiciJpegHasMetadata(bytes)) throw new VoiciImageError("unreadable");
    if (bytes.length <= VOICI_AVATAR_MAX_BYTES) return bytes;
  }
  throw new VoiciImageError("too-large");
}

/**
 * The same JPEG without its APP1-APP15 and comment segments (a browser's encoder may add an sRGB ICC profile as
 * APP2); everything from the scan on is kept as written. null when the bytes aren't a well-formed JPEG header.
 */
export function stripJpegMetadata(bytes) {
  if (!isVoiciJpeg(bytes)) return null;
  const keep = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const m = bytes[i + 1];
    if (m === 0xda) {
      keep.push(bytes.subarray(i));
      const out = new Uint8Array(keep.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of keep) {
        out.set(b, at);
        at += b.length;
      }
      return out;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
    if (!drop) keep.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

async function decodeImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image", colorSpaceConversion: "default" });
  return { width: bitmap.width, height: bitmap.height, source: bitmap };
}

async function encodeJpeg(source, crop, size, quality) {
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(size, size) : Object.assign(document.createElement("canvas"), { width: size, height: size });
  const g = canvas.getContext("2d", { colorSpace: "srgb" });
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size, size);
  g.imageSmoothingQuality = "high";
  g.drawImage(source, crop.sx, crop.sy, crop.side, crop.side, 0, 0, size, size);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/jpeg", quality })
    : await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** An object URL for bytes shown in an <img> (the shell's CSP allows blob:). */
export function jpegUrl(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}
