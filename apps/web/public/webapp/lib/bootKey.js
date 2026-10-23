// A box's boot key (packages/protocol/src/bootKey.ts): the only key a box
// keeps on its unencrypted /boot, used before its disk is open. Disk-key
// replies and auto-unlock leases are sealed to it, never to the STK (which
// stays inside the encrypted root). This browser adopts a boot key only
// through a binding the server's PINNED STK signed (boxKeyPins.js), never
// because `.com` lists it.
//
// A box installed before boot keys has none: callers then seal to the STK, as
// before (that box still keeps its STK on /boot).

import { acceptBootKeyBinding, acceptStkPqBinding, pinnedBootKey, verifyBootKeyBinding } from "./boxKeyPins.js";

const HEX32 = /^[0-9a-f]{64}$/;

async function fetchBinding(serverDomain, deps) {
  const f = deps.fetch || fetch;
  const r = await f(`${deps.comBase}/api/server/${encodeURIComponent(String(serverDomain).toLowerCase())}/boot-key`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`boot-key: HTTP ${r.status}`);
  const w = await r.json();
  const b = w?.binding;
  if (!b || typeof b.serverDomain !== "string" || typeof b.issuedAt !== "number" || typeof w.signature !== "string") return null;
  const bootPubHex = String(b.bootPubHex ?? "").toLowerCase();
  if (!HEX32.test(bootPubHex)) return null;
  const hybridSignature = typeof w.hybridSignature === "string" ? w.hybridSignature : undefined;
  return { binding: { serverDomain: b.serverDomain, bootPubHex, issuedAt: b.issuedAt }, signature: w.signature, hybridSignature };
}

/** The box's STK→ML-DSA key binding, or null when `.com` has none (architecture v2). */
async function fetchPqBinding(serverDomain, deps) {
  const f = deps.fetch || fetch;
  const r = await f(`${deps.comBase}/api/server/${encodeURIComponent(String(serverDomain).toLowerCase())}/pq-key-binding`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

/**
 * The boot key to seal to for `serverDomain` on this account, or null when the
 * server has none. A binding that does not verify under the pinned STK is
 * ignored (the pinned boot key, if any, still wins).
 */
export async function bootKeyFor(username, serverDomain, deps = {}) {
  // Pin the box's ML-DSA key first (only through the pinned STK), so a binding stripped of its
  // hybrid signature is refused below. A changed ML-DSA key throws BoxKeyChangedError.
  let pq = null;
  try {
    pq = await fetchPqBinding(serverDomain, deps);
  } catch {
    pq = null;
  }
  if (pq) acceptStkPqBinding(username, serverDomain, pq, deps);
  let w = null;
  try {
    w = await fetchBinding(serverDomain, deps);
  } catch {
    w = null;
  }
  if (w) {
    const accepted = await acceptBootKeyBinding(username, serverDomain, w.binding, w.signature, deps, w.hybridSignature);
    if (accepted) return accepted;
  }
  return pinnedBootKey(username, serverDomain, deps);
}

/** For a shared server: the boot key the STK pinned in the owner's offer vouches for, or null. */
export async function sharedBootKeyFor(serverDomain, pinnedStkHex, deps = {}) {
  let w = null;
  try {
    w = await fetchBinding(serverDomain, deps);
  } catch {
    return null;
  }
  if (!w || w.binding.bootPubHex === String(pinnedStkHex).toLowerCase()) return null;
  const stk = Uint8Array.from(String(pinnedStkHex).match(/../g) ?? [], (h) => parseInt(h, 16));
  const sig = Uint8Array.from(String(w.signature).toLowerCase().match(/../g) ?? [], (h) => parseInt(h, 16));
  return (await verifyBootKeyBinding(w.binding, sig, stk, serverDomain)) ? w.binding.bootPubHex : null;
}
