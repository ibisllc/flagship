/**
 * The CA keys keyd checks `.com`'s revocation lists against (`<keyd state>/ca-keys.json`;
 * protocol deviceRevocationList.ts). Written by root (setup step `keyd-ca-keys`) from the box's
 * own baked maintainer pin and `.maintainers/` chain, never by the daemon, so a daemon can
 * withhold a list but can't sign one. The keys vouch for lists issued from a day before the
 * write to KEYD_CA_KEYS_WINDOW_MS after it; the daemon asks root to rewrite the file twice a day,
 * and a box whose file runs out stops taking lists (keyd then signs no master, the admins get
 * manager) until root writes it again.
 */
import { join } from "node:path";
import { authorizedCaKeysOrFailClosed, type CaTrustChain, type KeydCaKeys } from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";

export const KEYD_CA_KEYS_FILE = "ca-keys.json";
export const KEYD_CA_KEYS_WINDOW_MS = 3 * 24 * 60 * 60_000;
const BEFORE_MS = 24 * 60 * 60_000;

/** What root writes: the CA keys the chain authorizes now (none when it authorizes none). */
export function keydCaKeys(chain: CaTrustChain | null, now: number): KeydCaKeys {
  const gate = authorizedCaKeysOrFailClosed(chain, now);
  const keys = gate.ok ? [...new Set(gate.keys.map((k) => k.toLowerCase()))].filter((k) => /^[0-9a-f]{64}$/.test(k)).sort() : [];
  return { v: 1, keys, validFrom: now - BEFORE_MS, validUntil: now + KEYD_CA_KEYS_WINDOW_MS };
}

/** Root's step: write `ca-keys.json` into keyd's state (0644: keyd reads it, only root writes it). */
export async function writeKeydCaKeys(opts: {
  keydState: string;
  chain: () => CaTrustChain | null;
  now?: number;
  write?: (path: string, text: string, mode: number) => Promise<void>;
}): Promise<{ keys: number }> {
  let chain: CaTrustChain | null = null;
  try {
    chain = opts.chain();
  } catch {
    chain = null;
  }
  const out = keydCaKeys(chain, opts.now ?? Date.now());
  await (opts.write ?? writeFileDurable)(join(opts.keydState, KEYD_CA_KEYS_FILE), `${JSON.stringify(out)}\n`, 0o644);
  return { keys: out.keys.length };
}
