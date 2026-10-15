/**
 * The DeepInfra key: from DEEPINFRA_API_KEY, else from
 * ~/.config/flagship/deepinfra-eval.key. It is never printed, logged or
 * written; every error text that leaves the harness goes through
 * `redactSecrets` first, so a provider echoing the key (or a stack trace
 * holding a header) can't put it in a report.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEY_ENV = "DEEPINFRA_API_KEY";
export const KEY_FILE = join(homedir(), ".config", "flagship", "deepinfra-eval.key");

export type KeySource = { key: string; from: "env" | "file" } | { key: null; reason: string };

export function loadKey(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
  file: string = KEY_FILE,
): KeySource {
  const fromEnv = env[KEY_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, from: "env" };
  let text: string;
  try {
    text = readFile(file);
  } catch {
    return { key: null, reason: `no key: set ${KEY_ENV} or put it in ${file}` };
  }
  const key = text.trim();
  if (!key) return { key: null, reason: `${file} is empty` };
  return { key, from: "file" };
}

const MASK = "[redacted]";

/**
 * Replace every secret in `text` (and its common encodings: as a Bearer
 * value, URL-encoded, base64) with a mask. Secrets shorter than 8 characters
 * are ignored so a short placeholder can't blank out ordinary words.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    for (const form of new Set([s, encodeURIComponent(s), Buffer.from(s).toString("base64")])) {
      out = out.split(form).join(MASK);
    }
  }
  return out;
}

/** A redactor bound to the key in use (identity when there is none). */
export function keyRedactor(key: string | null): (text: string) => string {
  return (text) => redactSecrets(text, [key]);
}
