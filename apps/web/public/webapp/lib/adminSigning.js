// Admin orders signed hybrid from the browser (docs/webapp-key-custody.md items 4 and 6).
//
// One passkey prompt opens the admin root and its ML-DSA half (lib/keyCustody.js); the order gets
// its Ed25519 signature and, when `.com` holds this browser's ML-DSA key for the admin root, the
// hybrid companion (`pqSignature`, flagship/hybrid-sig/ed25519-mldsa65/v1) a strict server needs.
// Both seeds are wiped when the order is signed.
//
// The admin root's binding (`flagship/pq-key-binding/v1`, role admin-root) is sent to `.com` the
// first time the ML-DSA half exists. `.com` keeps the first ML-DSA key per Ed25519 key
// (pq-suites.md §11.2): when a phone bound the admin root first, this browser keeps signing
// classically for that root and says so.

import { bytesToHex, signWithAdminRoot } from "../keystore.js";
import { controlApex } from "./apex.js";
import { getSession } from "./state.js";
import { isAdminRootKey, setCustodyBindHook, withAdminRoot } from "./keyCustody.js";
import { SENSITIVE_TAGS, canonicalTag, sensitiveSigner } from "./adminRoot.js";
import { hybridEnvelope, signPqKeyBinding } from "./pqSign.js";

/**
 * Signs `canonical` with the admin root. Returns `{ signature, signatureHex, pqSignature }`, where
 * `pqSignature` is `{ suite, signature }` or null (no bound ML-DSA half on this browser).
 */
export async function signAdminOrder(key, canonical, { reason = "" } = {}) {
  if (!isAdminRootKey(key)) throw Object.assign(new Error("not-admin"), { code: "not-admin" });
  return withAdminRoot(
    key,
    async ({ edSeed, mldsaSeed, pqBound }) => {
      const signature = await signWithAdminRoot(edSeed, canonical);
      const pqSignature = mldsaSeed && pqBound ? await hybridEnvelope(canonical, edSeed, mldsaSeed) : null;
      return { signature, signatureHex: bytesToHex(signature), pqSignature };
    },
    { reason },
  );
}

/**
 * The sensitive-order signer, hybrid where it can be: `(umk, bytes) => { signature, pqSignature }`.
 * A sensitive tag on a device holding the admin root signs both halves under one passkey prompt;
 * anything else goes through the classical gated signer (lib/adminRoot.js) with no companion.
 */
export function sensitiveHybridSigner(session = getSession()) {
  const classical = sensitiveSigner();
  return async (umk, bytes) => {
    const key = session?.adminRootSeed;
    if (isAdminRootKey(key) && SENSITIVE_TAGS.has(canonicalTag(bytes))) {
      const s = await signAdminOrder(key, bytes);
      return { signature: s.signature, pqSignature: s.pqSignature };
    }
    return { signature: await classical(umk, bytes), pqSignature: null };
  };
}

/** A signer's answer as `{ signature, pqSignature }`, whether it returned bytes or that object. */
export function signedParts(r) {
  if (r instanceof Uint8Array) return { signature: r, pqSignature: null };
  return { signature: r.signature, pqSignature: r.pqSignature ?? null };
}

/** PUT the admin root's binding; true when `.com` holds this ML-DSA key, false when another key holds the root. */
export async function bindAdminRootPq({ edSeed, mldsaSeed }, deps = {}) {
  const username = (deps.username ?? getSession()?.username ?? "").toLowerCase();
  if (!username) return null;
  const f = deps.fetch ?? fetch;
  const wire = await signPqKeyBinding({ role: "admin-root", subjectId: username, issuedAt: (deps.now ?? Date.now)() }, edSeed, mldsaSeed);
  const res = await f(`${deps.apex ?? controlApex()}/api/accounts/${encodeURIComponent(username)}/pq-key-bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(wire),
  });
  if (res.ok) return true;
  if (res.status === 409) {
    let code = "";
    try {
      const body = await res.json();
      code = String(body?.error ?? body?.code ?? body?.reason ?? "");
    } catch {
      /* no body */
    }
    if (code.includes("pq-key-changed")) return false;
    if (code.includes("stale")) return true;
  }
  return null;
}

/** Wires the binding into lib/keyCustody.js (once, at start-up). */
export function installAdminRootBinding() {
  setCustodyBindHook((seeds) => bindAdminRootPq(seeds));
}
