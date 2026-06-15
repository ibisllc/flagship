/**
 * Validation + summarization for vibe-code chat attachments.
 *
 * A user turn may carry up to a handful of small attachments — a
 * screenshot/mockup the AI should reproduce, or a text file (schema,
 * sample data, config) the app should use. These are NOT a secret
 * channel: the system prompt forbids the model from soliciting secret
 * VALUES via chat, and `looksLikePastedSecret` flags accidental pastes.
 *
 * Caps (server-enforced; the client mirrors them for a friendly toast):
 *   - ≤ 6 attachments per turn
 *   - image ≤ 4 MB decoded
 *   - text ≤ 256 KB
 *   - only common image/* media types + text
 */

import type { Attachment } from "@flagship/llm-providers";

export const MAX_ATTACHMENTS_PER_TURN = 6;
/** Decoded byte ceilings. Base64 inflates ~4/3, so we check the decoded size. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_TEXT_BYTES = 256 * 1024; // 256 KB

/** Image media types we accept. Mirrors the client's `accept="image/*"`. */
const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export type AttachmentValidation =
  | { ok: true; attachments: Attachment[] }
  | { ok: false; reason: string };

/** Decoded byte length of a base64 string (no allocation). */
function base64DecodedBytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Validate an untrusted attachments payload (e.g. an HTTP request body).
 * Returns a clean, typed array on success or a one-line reason on
 * failure. Value-free w.r.t. secrets — the validator never logs content.
 */
export function validateAttachments(raw: unknown): AttachmentValidation {
  if (raw == null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "attachments must be an array" };
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, reason: `too many attachments (max ${MAX_ATTACHMENTS_PER_TURN})` };
  }
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, reason: "each attachment must be an object" };
    }
    const a = item as Record<string, unknown>;
    const name = typeof a.name === "string" ? a.name : undefined;
    if (a.kind === "image") {
      if (typeof a.mediaType !== "string" || typeof a.dataBase64 !== "string") {
        return { ok: false, reason: "image attachment needs mediaType + dataBase64" };
      }
      if (!ALLOWED_IMAGE_MEDIA_TYPES.has(a.mediaType.toLowerCase())) {
        return { ok: false, reason: `unsupported image type '${a.mediaType}'` };
      }
      if (base64DecodedBytes(a.dataBase64) > MAX_IMAGE_BYTES) {
        return { ok: false, reason: "image too large (max 4 MB)" };
      }
      out.push({
        kind: "image",
        mediaType: a.mediaType,
        dataBase64: a.dataBase64,
        ...(name != null ? { name } : {}),
      });
    } else if (a.kind === "text") {
      if (typeof a.text !== "string") {
        return { ok: false, reason: "text attachment needs text" };
      }
      if (Buffer.byteLength(a.text, "utf8") > MAX_TEXT_BYTES) {
        return { ok: false, reason: "text attachment too large (max 256 KB)" };
      }
      out.push({ kind: "text", text: a.text, ...(name != null ? { name } : {}) });
    } else {
      return { ok: false, reason: `unknown attachment kind '${String(a.kind)}'` };
    }
  }
  return { ok: true, attachments: out };
}

/**
 * A value-free, one-line summary of an attachment for the build journal:
 * NAME + kind + size ONLY. The content / base64 / text body NEVER
 * appears here — the journal is shown back to the owner and (for mcp)
 * reflects external input, so it must never capture a value.
 */
export function summarizeAttachment(a: Attachment): string {
  const name = a.name && a.name.length > 0 ? a.name : "(unnamed)";
  if (a.kind === "image") {
    const bytes = base64DecodedBytes(a.dataBase64);
    return `image ${name} (${a.mediaType}, ${bytes} bytes)`;
  }
  const bytes = Buffer.byteLength(a.text, "utf8");
  return `text ${name} (${bytes} bytes)`;
}
