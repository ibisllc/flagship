import { APP_ONELINER_MAX_LEN } from "@flagship/protocol";

/**
 * Shortens an AI-written manifest's over-long `description` to the
 * validator's limit. Measured builds failed outright on this label alone
 * (GLM-5.3 wrote 40-60 characters and its fix rounds never shortened it),
 * and a cosmetic field shouldn't cost the owner a build. Anything else, or
 * text that isn't JSON, comes back unchanged for the validator to judge.
 */
export function tidyAiManifest(json: string): string {
  let m: unknown;
  try {
    m = JSON.parse(json);
  } catch {
    return json;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return json;
  const d = (m as { description?: unknown }).description;
  if (typeof d !== "string" || d.length <= APP_ONELINER_MAX_LEN) return json;
  return JSON.stringify({ ...m, description: shortenLabel(d, APP_ONELINER_MAX_LEN) }, null, 2) + "\n";
}

export function shortenLabel(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  const words = space >= max / 3 ? cut.slice(0, space) : t.slice(0, max);
  return words.replace(/[\s,;:.\-–—]+$/, "");
}
