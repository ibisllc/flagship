// The page photo, re-encoded in the browser (docs/voici-and-messages.md §2.3): the photo editor's square crop
// (lib/voiciImageEdit.js: turns, flip, zoom, pan; the centre by default), 512 × 512, JPEG at quality 0.82 stepping
// down to 0.6 (then a smaller square), at most 150 KiB. Drawing the decoded pixels onto a fresh
// canvas and encoding that drops every EXIF/XMP/ICC/GPS segment; the result is checked anyway (no APP1/APP2).

import { isVoiciJpeg, voiciJpegHasMetadata, VOICI_AVATAR_MAX_BYTES } from "./voiciProtocol.js";
import { newEdit, outputMatrix } from "./voiciImageEdit.js";

export const VOICI_AVATAR_SIZE = 512;
export const VOICI_AVATAR_QUALITIES = [0.82, 0.76, 0.7, 0.65, 0.6];
/** The sizes tried in turn when a detailed photo does not fit the cap at full size. */
export const VOICI_AVATAR_SIZES = [512, 410, 328, 262];
/** The longest side the photo editor works on. */
export const VOICI_EDITOR_MAX_SIDE = 2048;

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
 * A picked image file (or Blob) decoded upright (EXIF orientation applied), its longest side at most `maxSide`:
 * {width, height, source}. `deps.decode` is the seam for tests. Throws VoiciImageError("unreadable").
 */
export async function decodeForEditing(file, deps = {}, maxSide = VOICI_EDITOR_MAX_SIDE) {
  const decode = deps.decode ?? ((f) => decodeImage(f, maxSide));
  let img;
  try {
    img = await decode(file);
  } catch {
    throw new VoiciImageError("unreadable");
  }
  if (!img?.width || !img?.height) throw new VoiciImageError("unreadable");
  return img;
}

/**
 * The avatar from a decoded picture and the editor's edit (turns, flip, square crop): drawn at 512 × 512 through
 * outputMatrix and written as JPEG within the cap, quality stepping down, then the square a fifth smaller each round
 * (never under 256). `deps.encode(source, matrix, size, quality)` is the test seam. Throws
 * VoiciImageError("encode-failed") when the browser's encoder fails at every size, ("too-large") when nothing fits.
 */
export async function encodeEditedAvatar(img, edit, deps = {}) {
  const encode = deps.encode ?? encodeJpeg;
  let wrote = false;
  for (const size of VOICI_AVATAR_SIZES) {
    const matrix = outputMatrix(edit, size);
    for (const q of VOICI_AVATAR_QUALITIES) {
      let bytes = null;
      try {
        bytes = stripJpegMetadata(await encode(img.source, matrix, size, q));
      } catch {
        bytes = null;
      }
      if (!bytes || voiciJpegHasMetadata(bytes)) break;
      wrote = true;
      if (bytes.length <= VOICI_AVATAR_MAX_BYTES) return bytes;
    }
  }
  throw new VoiciImageError(wrote ? "too-large" : "encode-failed");
}

/** Re-encodes a picked image file with the centred square crop. Resolves the JPEG bytes. */
export async function reencodeAvatar(file, deps = {}) {
  const img = await decodeForEditing(file, deps);
  return encodeEditedAvatar(img, newEdit(img.width, img.height), deps);
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

async function decodeImage(file, maxSide = VOICI_EDITOR_MAX_SIDE) {
  let bitmap = await createImageBitmap(file, { imageOrientation: "from-image", colorSpaceConversion: "default" });
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (k < 1) {
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const smaller = await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    bitmap.close?.();
    bitmap = smaller;
  }
  return { width: bitmap.width, height: bitmap.height, source: bitmap };
}

/** Draws `source` through `matrix` ([a, b, c, d, tx, ty]) onto a white size × size canvas. */
export function drawEdited(g, source, matrix, size) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size, size);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  g.drawImage(source, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

async function encodeJpeg(source, matrix, size, quality) {
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(size, size) : Object.assign(document.createElement("canvas"), { width: size, height: size });
  const g = canvas.getContext("2d", { colorSpace: "srgb" });
  drawEdited(g, source, matrix, size);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/jpeg", quality })
    : await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob) throw new Error("no blob");
  return new Uint8Array(await blob.arrayBuffer());
}

/** An object URL for bytes shown in an <img> (the shell's CSP allows blob:). */
export function jpegUrl(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}
