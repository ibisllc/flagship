/**
 * The adapter-vetting keys this box's release pins (`release/adapter-vetting-keys.json`). The file
 * ships in the box's own tree, so the keys move only with an endorsed release. Anything unreadable
 * or malformed pins nothing, which keeps community adapter lookup off.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PinnedVettingKey } from "@flagship/protocol";

// src/buildmodes and dist/buildmodes sit at the same depth below the repo root.
export const ADAPTER_VETTING_KEYS_PATH = fileURLToPath(new URL("../../../../release/adapter-vetting-keys.json", import.meta.url));

export function parseAdapterVettingKeys(text: string): PinnedVettingKey[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const { schema, keys } = doc as { schema?: unknown; keys?: unknown };
  if (schema !== 1 || !Array.isArray(keys)) return null;
  const out: PinnedVettingKey[] = [];
  for (const k of keys as unknown[]) {
    const { pubHex, notBefore, notAfter } = (k ?? {}) as Record<string, unknown>;
    if (typeof pubHex !== "string" || !/^[0-9a-f]{64}$/.test(pubHex)) return null;
    if (typeof notBefore !== "string" || typeof notAfter !== "string") return null;
    const from = Date.parse(notBefore);
    const to = Date.parse(notAfter);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    out.push({ pubHex, notBefore: from, notAfter: to });
  }
  return out;
}

export function loadAdapterVettingKeys(path = ADAPTER_VETTING_KEYS_PATH): PinnedVettingKey[] {
  try {
    return parseAdapterVettingKeys(readFileSync(path, "utf8")) ?? [];
  } catch {
    return [];
  }
}

/** Whether any pinned key can sign right now. */
export function hasCurrentVettingKey(keys: readonly PinnedVettingKey[], now = Date.now()): boolean {
  return keys.some((k) => k.notBefore <= now && now < k.notAfter);
}
