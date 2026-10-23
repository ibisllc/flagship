// An active admin's view of a pending recovery, and the veto that rejects it
// (SECURITY-HARDENING-PLAN.md 10.6 / N04). Mirrors packages/protocol/src/recovery.ts
// `RePairVeto`; the shared vectors are packages/protocol/test-vectors/re-pair-veto.
//
// The veto is signed with the account's admin root. It names the exact attempt (the
// pending device key, when it began, its deadline) so it cannot be replayed onto a later
// one. A veto cancels THIS attempt only; a retry starts a fresh full wait.

import { escapeHtml } from "./util.js";
import { formatWhen } from "./dateFormat.js";
import { adminRootPubHex, signWithAdminRoot } from "../keystore.js";
import { controlApex } from "./apex.js";

export const TAG_RE_PAIR_VETO = "flagship/re-pair-veto/v1";

export const VETO_CONFIRM_TITLE = "Reject this recovery?";
export const VETO_CONFIRM_MESSAGE =
  "This cancels the recovery attempt. If the real owner is trying to get back in, they will have to start again and wait the full time. Only reject it if you do not expect it.";
export const UNUSUAL_RECOVERY_NOTE =
  "If this is unusual, please check on the physical safety of your device and server.";

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function canonicalRePairVetoBytes(r) {
  for (const k of ["initiatedAt", "completesAt", "issuedAt"]) {
    if (!Number.isSafeInteger(r[k]) || r[k] < 0) throw new Error(`invalid ${k}`);
  }
  return new TextEncoder().encode(
    [TAG_RE_PAIR_VETO, r.username.toLowerCase(), r.newIrkPubHex, r.initiatedAt, r.completesAt, r.vetoerPubHex, r.issuedAt].join("|"),
  );
}

/** Should an admin see the recovery card? Only a live (not vetoed, not cancelled) attempt. */
export function shouldRenderRecoveryReview(snapshot, isAdmin) {
  const p = snapshot?.pending;
  return !!(isAdmin && p && !p.objectedAt);
}

export function renderRecoveryReview(snapshot, isAdmin, nowMs = Date.now()) {
  if (!shouldRenderRecoveryReview(snapshot, isAdmin)) return "";
  const p = snapshot.pending;
  const done = typeof p.completesAt === "number" && p.completesAt <= nowMs;
  return `
    <div class="card" data-recovery-review role="alert">
      <div class="weight-600"><span aria-hidden="true">⚠️</span> A recovery of this account is waiting</div>
      <p class="note small">A new device asked to take over this account. It becomes active ${done ? "as soon as it finishes" : `on ${escapeHtml(formatWhen(p.completesAt, nowMs))}`} unless an admin rejects it. It has no admin authority until then.</p>
      <p class="note small">${escapeHtml(UNUSUAL_RECOVERY_NOTE)}</p>
      <button class="danger" id="reject-recovery-btn">Reject recovery</button>
    </div>`;
}

/** Sign and submit the veto for the snapshot's attempt. The caller has already confirmed. */
export async function submitRecoveryVeto({ username, pending, adminRootSeed }, deps = {}) {
  if (!(adminRootSeed instanceof Uint8Array)) throw new Error("administrator authorization required");
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();
  const req = {
    username,
    newIrkPubHex: pending.newIrkPub,
    initiatedAt: pending.initiatedAt,
    completesAt: pending.completesAt,
    vetoerPubHex: await (deps.adminRootPubHex || adminRootPubHex)(adminRootSeed),
    issuedAt: (deps.now || Date.now)(),
  };
  const sig = await (deps.signWithAdminRoot || signWithAdminRoot)(adminRootSeed, canonicalRePairVetoBytes(req));
  const resp = await f(`${origin}/api/users/${encodeURIComponent(username)}/re-pair/veto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username, newIrkPub: req.newIrkPubHex, initiatedAt: req.initiatedAt, completesAt: req.completesAt, vetoerPub: req.vetoerPubHex, issuedAt: req.issuedAt },
      signature: typeof sig === "string" ? sig : hexOf(sig),
    }),
  });
  if (resp.status === 409) throw new Error("This recovery was already cancelled or finished.");
  if (!resp.ok) throw new Error(`Couldn't reject the recovery (${resp.status})`);
  return resp.json().catch(() => ({}));
}
