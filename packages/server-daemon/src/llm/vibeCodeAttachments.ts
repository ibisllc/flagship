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
 *
 * Two more kinds arrive on the wire and become text before any model sees
 * them (`prepareAttachments`):
 *   - `data`: a CSV or JSON file of sample data, ≤ 2 MB. The model reads a
 *     preview; the whole file goes into the app's private test copy only
 *     (`$FLAGSHIP_FILES_DIR/sample/<name>`), never the live app — sample
 *     data follows the staging-only rule (docs/ai-privacy-and-staging.md).
 *   - `document`: a PDF, ≤ 10 MB. Its text is extracted on the box (≤ 256 KB
 *     kept); the PDF itself goes nowhere.
 */

import type { Attachment } from "@flagship/llm-providers";

export const MAX_ATTACHMENTS_PER_TURN = 6;
/** Decoded byte ceilings. Base64 inflates ~4/3, so we check the decoded size. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_TEXT_BYTES = 256 * 1024; // 256 KB
export const MAX_DATA_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB
/** What the model reads of a sample data file. */
export const DATA_PREVIEW_CHARS = 16 * 1024;
const DATA_PREVIEW_LINES = 200;
const DATA_MEDIA_TYPES = new Set(["text/csv", "application/json"]);
/** A sample file's name inside the test copy: plain, no paths. */
const SAMPLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

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

/** A sample data file for the app's private test copy. */
export interface SampleFile {
  name: string;
  mediaType: string;
  text: string;
}

export type PreparedAttachments =
  | { ok: true; attachments: Attachment[]; samples: SampleFile[] }
  | { ok: false; reason: string };

/** Turns a PDF's bytes into its text. */
export type PdfText = (pdf: Uint8Array) => Promise<string>;

/** The box's PDF text extraction (unpdf: pdf.js, no native code, nothing leaves the box). */
export const extractPdfText: PdfText = async (pdf) => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(pdf);
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : text;
};

/** A file name made safe for the test copy's folder. */
export function sampleFileName(raw: string | undefined, mediaType: string): string {
  const ext = mediaType === "application/json" ? ".json" : ".csv";
  const base = (raw ?? "").split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const name = base.length > 0 ? base.slice(0, 100) : `sample${ext}`;
  return SAMPLE_NAME_RE.test(name) ? name : `sample${ext}`;
}

function preview(text: string): { shown: string; lines: number; cut: boolean } {
  const lines = text.split("\n");
  let shown = lines.slice(0, DATA_PREVIEW_LINES).join("\n");
  if (shown.length > DATA_PREVIEW_CHARS) shown = shown.slice(0, DATA_PREVIEW_CHARS);
  return { shown, lines: lines.length, cut: shown.length < text.length };
}

/**
 * Validate a turn's attachments and turn every kind into what a model may
 * read: images and text as they are, sample data as a preview (the file
 * itself kept for the test copy), a PDF as its extracted text.
 */
export async function prepareAttachments(raw: unknown, opts: { pdfText?: PdfText } = {}): Promise<PreparedAttachments> {
  if (raw == null) return { ok: true, attachments: [], samples: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "attachments must be an array" };
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    return { ok: false, reason: `too many attachments (max ${MAX_ATTACHMENTS_PER_TURN})` };
  }
  const plain: unknown[] = [];
  const extra: Array<{ index: number; item: Record<string, unknown> }> = [];
  raw.forEach((item, index) => {
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (kind === "data" || kind === "document") extra.push({ index, item: item as Record<string, unknown> });
    else plain.push(item);
  });
  const base = validateAttachments(plain);
  if (!base.ok) return base;
  const converted = new Map<number, Attachment>();
  const samples: SampleFile[] = [];
  for (const { index, item } of extra) {
    const name = typeof item.name === "string" ? item.name : undefined;
    if (item.kind === "data") {
      const mediaType = typeof item.mediaType === "string" ? item.mediaType.toLowerCase() : "";
      if (!DATA_MEDIA_TYPES.has(mediaType)) return { ok: false, reason: "sample data must be CSV or JSON" };
      if (typeof item.text !== "string") return { ok: false, reason: "sample data needs text" };
      if (Buffer.byteLength(item.text, "utf8") > MAX_DATA_BYTES) {
        return { ok: false, reason: "sample data too large (max 2 MB)" };
      }
      if (mediaType === "application/json") {
        try {
          JSON.parse(item.text);
        } catch {
          return { ok: false, reason: `${name ?? "the JSON file"} isn't valid JSON` };
        }
      }
      const file = sampleFileName(name, mediaType);
      samples.push({ name: file, mediaType, text: item.text });
      const p = preview(item.text);
      converted.set(index, {
        kind: "text",
        name: file,
        text:
          `Sample data the owner attached (${mediaType}, ${p.lines} lines). The whole file is copied into the app's private ` +
          `test copy at $FLAGSHIP_FILES_DIR/sample/${file} when the app declares data.stores.files; the live app starts ` +
          `without it. Use it to shape the schema and to try the app; never write it into a migration.\n` +
          `${p.cut ? "The first lines" : "The file"}:\n${p.shown}`,
      });
    } else {
      if (item.mediaType !== "application/pdf" || typeof item.dataBase64 !== "string") {
        return { ok: false, reason: "a document must be a PDF" };
      }
      if (base64DecodedBytes(item.dataBase64) > MAX_DOCUMENT_BYTES) {
        return { ok: false, reason: "document too large (max 10 MB)" };
      }
      let text: string;
      try {
        text = (await (opts.pdfText ?? extractPdfText)(new Uint8Array(Buffer.from(item.dataBase64, "base64")))).trim();
      } catch {
        return { ok: false, reason: `couldn't read the text in ${name ?? "the PDF"}` };
      }
      if (text.length === 0) return { ok: false, reason: `${name ?? "the PDF"} has no text to read (a scan?)` };
      let kept = text;
      while (Buffer.byteLength(kept, "utf8") > MAX_TEXT_BYTES) kept = kept.slice(0, Math.floor(kept.length * 0.9));
      converted.set(index, {
        kind: "text",
        name: `${name ?? "document.pdf"} (text)`,
        text: kept.length < text.length ? `${kept}\n… [the rest of the document was cut]` : kept,
      });
    }
  }
  // Back in the owner's order.
  const out: Attachment[] = [];
  let next = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = converted.get(i);
    if (c) out.push(c);
    else out.push(base.attachments[next++]!);
  }
  return { ok: true, attachments: out, samples };
}
