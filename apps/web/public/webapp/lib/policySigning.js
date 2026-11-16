// The strict opt-in from the browser (docs/webapp-key-custody.md item 4; pq-suites.md §15): an
// owner-signed `flagship/assurance-policy/v1` change, hybrid, by the admin root whose ML-DSA half this
// browser holds bound (lib/keyCustody.js). Port of the phones' QuantumSafety.strictChange /
// compatibilityChange. Returning to strict after a compatibility period needs re-entry evidence
// (fresh checks of every device, a rekey and a tested recovery), which only the phone app collects.

import { assurancePolicyDigest, canonicalAssurancePolicyChange } from "./assurancePolicy.js";
import { controlApex } from "./apex.js";
import { isLockedKey, withAdminRoot } from "./keyCustody.js";
import { hybridEnvelope } from "./pqSign.js";
import { tr } from "./i18n.js";

export const BROWSER_LOSS = "browser-without-pq-authentication";
export const LEAVING_STRICT_LOSS = ["classical-signatures-accepted", "classical-key-exchange-accepted", BROWSER_LOSS];

const enc = new TextEncoder();
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** SHA-256 of the sorted, distinct, lower-case peers joined by `|` (every port computes it alike). */
export async function affectedPeersDigest(peers) {
  const joined = [...new Set(peers.map((p) => String(p).toLowerCase()))].sort().join("|");
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(joined))));
}

/** The change that turns strict on. `browsersAllowed` is the owner's explicit answer. */
export async function strictChange({ account, scope, state, browsersAllowed, peers, signerKeyId, now = Date.now() }) {
  if (typeof browsersAllowed !== "boolean") throw new Error("the browser question needs an answer");
  return {
    account: account.toLowerCase(),
    scope,
    prior: state.profile,
    next: "strict",
    generation: state.generation + 1,
    prevDigest: state.headDigest,
    affectedPeersDigest: await affectedPeersDigest(peers),
    acknowledgedLoss: browsersAllowed ? [BROWSER_LOSS] : [],
    signerKind: "admin-root",
    signerKeyId: signerKeyId.toLowerCase(),
    suite: "hybrid-ed25519-mldsa65/v1",
    issuedAt: now,
  };
}

/** The change back to compatibility, naming every loss the owner read and accepted. */
export async function compatibilityChange({ account, scope, state, loss, peers, signerKeyId, now = Date.now() }) {
  return {
    account: account.toLowerCase(),
    scope,
    prior: state.profile,
    next: "compatibility",
    generation: state.generation + 1,
    prevDigest: state.headDigest,
    affectedPeersDigest: await affectedPeersDigest(peers),
    acknowledgedLoss: [...new Set(loss)].sort(),
    signerKind: "admin-root",
    signerKeyId: signerKeyId.toLowerCase(),
    suite: "hybrid-ed25519-mldsa65/v1",
    issuedAt: now,
  };
}

/** Why this browser can't sign a policy change, or null when it can. */
export function policySignerProblem(key) {
  if (!isLockedKey(key)) return "not-admin";
  if (!key.pqBound) return "not-bound";
  return null;
}

/** Signs `change` hybrid with the admin root (one passkey prompt) and posts it. Resolves null, or `.com`'s refusal code. */
export async function signAndPostPolicyChange(change, key, deps = {}) {
  const msg = canonicalAssurancePolicyChange(change);
  const signature = await withAdminRoot(key, async ({ edSeed, mldsaSeed, pqBound }) => {
    if (!mldsaSeed || !pqBound) throw Object.assign(new Error("not-bound"), { code: "not-bound" });
    return hybridEnvelope(msg, edSeed, mldsaSeed);
  });
  const f = deps.fetch ?? fetch;
  let res;
  try {
    res = await f(`${deps.apex ?? controlApex()}/api/accounts/${encodeURIComponent(change.account)}/assurance-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change, signature }),
    });
  } catch {
    return "network";
  }
  if (res.ok) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return String(body?.code ?? body?.error ?? `http ${res.status}`);
}

/** The digest the next change must name, for tests. */
export const changeDigest = assurancePolicyDigest;

/** `.com`'s refusal code as a sentence. */
export function policyRefusalText(code) {
  switch (code) {
    case "not-prepared":
      return tr("The server isn't ready yet: every device, the server and your recovery need their post-quantum keys first.");
    case "not-bound":
    case "classical-signer-refused":
    case "strict-requires-hybrid":
    case "strict-requires-binding":
      return tr("This browser's admin key has no quantum-safe half on record. Use the Flagship app on the admin phone that set the account up.");
    case "not-admin":
      return tr("Only an admin device of this account can change quantum-safe protection.");
    case "stale-generation":
    case "fork":
      return tr("Another device changed this at the same time. Refresh and try again.");
    case "reentry-incomplete":
      return tr("Turning strict on again needs a fresh check of every device, a rekey and a tested recovery. Do it from the Flagship app on an admin phone.");
    case "network":
      return tr("Couldn't reach flagshipserver.com. Check your connection and try again.");
    default:
      return tr("flagshipserver.com didn't accept the change ({0}).", code);
  }
}
