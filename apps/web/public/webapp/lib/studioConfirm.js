// "Confirmed by Studio" (docs/first-contact.md, item 4). For a VM it hosts, Studio reads the box's
// console line `flagship-server-code <domain> <code> <stkPubHex>` and reports the key it saw on the
// order status as `serverSeen: [{ stkPubHex, macHex, at }]` (up to 4, newest last), each with
//   macHex = HMAC-SHA256(studioConfirmKey, `flagship/server-code-seen/v1|<domain lowercase>|<stkPubHex>`)
// under a per-server key the device handed Studio beside the recipe. A report whose MAC verifies
// marks the code confirmed for that key; anything else is ignored and the code box stays.
//
// The webapp hands Studio a recipe file, never over the paired channel, so it holds no key today
// and this only acts once a key was kept with `keepStudioConfirmKey`.

import { loadStudioConfirmKey, markCodeConfirmed } from "./serverPins.js";
import { getSession } from "./state.js";
import { SERVER_CODE_SEEN_TAG, serverSeenMacHex } from "./enrollment.js";

export { SERVER_CODE_SEEN_TAG, serverSeenMacHex };

/** Constant-time check of Studio's report. */
export async function verifyServerSeen(keyHex, serverDomain, seen) {
  const stk = String(seen?.stkPubHex ?? "").toLowerCase();
  const want = await serverSeenMacHex(keyHex, serverDomain, stk);
  const got = String(seen?.macHex ?? "").toLowerCase();
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/**
 * Feed an order status body (`/api/order/<serial>/status`) for `serverDomain`. Every entry whose MAC
 * verifies under the key this device kept marks the code confirmed for that key; the blessing shows
 * "Confirmed by Studio" only when one of them is the key in its request. Returns the keys confirmed.
 */
export async function noteServerSeen(serverDomain, statusBody, deps = {}) {
  const raw = statusBody?.serverSeen;
  const entries = (Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : []).slice(-4);
  if (!entries.length) return [];
  const umk = deps.umk ?? getSession()?.umk;
  if (!umk) return [];
  const keyHex = await (deps.loadKey || loadStudioConfirmKey)(umk, serverDomain);
  if (!keyHex) return [];
  const out = [];
  for (const seen of entries) {
    if (!(await verifyServerSeen(keyHex, serverDomain, seen))) continue;
    const stk = String(seen.stkPubHex).toLowerCase();
    markCodeConfirmed(serverDomain, stk);
    out.push(stk);
  }
  return out;
}
