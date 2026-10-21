// A fresh unlock for one admin signature: the browser's stand-in for the
// phones' Face ID per order (lib/sessionTiers.js maps Face ID to the wrap
// passphrase). The device's passphrase must unwrap the same key the open
// session holds; an unlocked tab alone can't sign what this gates.

import { inlinePrompt } from "./modal.js";
import { unlockUmk } from "../keystore.js";
import { getSession } from "./state.js";

import { tr } from "./i18n.js";
export const FRESH_UNLOCK_WRONG = tr("That passphrase doesn't unlock this device.");

function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * Ask for this device's passphrase and check it. Resolves `{ok: true}`,
 * `{ok: false, cancelled: true}` or `{ok: false, error}`.
 * `deps.prompt` / `deps.unlock` / `deps.session` are test seams.
 */
export async function confirmFreshUnlock({ title, message, okLabel = "Confirm" }, deps = {}) {
  const prompt = deps.prompt ?? inlinePrompt;
  const unlock = deps.unlock ?? unlockUmk;
  const session = deps.session ?? getSession();
  const passphrase = await prompt({
    title,
    message: tr("{0} Enter this device's passphrase to sign it.", message),
    placeholder: tr("Passphrase"),
    type: "password",
    okLabel,
  });
  if (passphrase === null || passphrase === undefined) return { ok: false, cancelled: true };
  let seed;
  try {
    seed = await unlock(String(passphrase));
  } catch {
    return { ok: false, error: FRESH_UNLOCK_WRONG };
  }
  return sameBytes(seed, session?.umk) ? { ok: true } : { ok: false, error: FRESH_UNLOCK_WRONG };
}
