// Permissions a restore held back (SECURITY-HARDENING-PLAN.md 18.9, N09). A restored app comes back
// members-only with nobody on its list; the backup's list waits as a draft until an admin approves
// THAT draft: the signature covers the app and the draft's SHA-256, so it cannot approve another
// draft, a replaced one, or another app. Mirrors packages/protocol/src/appAccessOrders.ts.

import { bytesToHex } from "../keystore.js";

export const TAG_RESTORED_ACCESS_APPROVE = "flagship/restored-access-approve/v1";

export const RESTORED_COPY = Object.freeze({
  title: "Restored permissions",
  intro: "This app came back from a backup. Until an admin approves, nobody from the old list can open it.",
  approve: "Approve this list",
  discard: "Discard it",
  adminOnly: "Only an admin device can approve restored permissions.",
});

const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export function canonicalRestoredAccessApproveBytes({ serviceRef, draftSha256, issuedAt }) {
  if (typeof serviceRef !== "string" || !SERVICE_REF_RE.test(serviceRef)) throw new Error(`${TAG_RESTORED_ACCESS_APPROVE}: bad serviceRef`);
  if (typeof draftSha256 !== "string" || !/^[0-9a-f]{64}$/.test(draftSha256)) throw new Error(`${TAG_RESTORED_ACCESS_APPROVE}: draftSha256 must be 64 lowercase hex`);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error(`${TAG_RESTORED_ACCESS_APPROVE}: bad issuedAt`);
  return new TextEncoder().encode([TAG_RESTORED_ACCESS_APPROVE, serviceRef, draftSha256, String(issuedAt)].join("|"));
}

/** The draft waiting for this app, or null (also null on a box from before restores held drafts). */
export async function fetchRestoredDraft(serviceRef, fetchJson) {
  try {
    const r = await fetchJson("/api/screens/restored-access");
    return (r?.drafts ?? []).find((d) => d.serviceRef === serviceRef) ?? null;
  } catch (e) {
    if (e?.status === 404 || e?.status === 503) return null;
    throw e;
  }
}

export async function discardRestoredDraft(serviceRef, fetchJson) {
  return fetchJson("/api/screens/restored-access/discard", { method: "POST", body: JSON.stringify({ serviceRef }) });
}

/** Sign the exact draft shown and send it to the box. `signWithIrk` is the sensitive-order signer. */
export async function approveRestoredDraft({ baseUrl, serviceRef, draftSha256, umk, signWithIrk }, deps = {}) {
  if (!umk || typeof signWithIrk !== "function") throw new Error("unlock the webapp first");
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("pod baseUrl must be https://");
  const order = { serviceRef, draftSha256, issuedAt: (deps.now || Date.now)() };
  const sig = await signWithIrk(umk, canonicalRestoredAccessApproveBytes(order));
  const resp = await (deps.fetch || fetch)(`${base}/api/service-access/restored`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: order, signature: bytesToHex(sig) }),
  });
  if (!resp.ok) {
    const e = new Error(`request failed (${resp.status})`);
    e.status = resp.status;
    throw e;
  }
  return resp.json().catch(() => ({}));
}

export function restoredCardHtml(draft, { admin, escape }) {
  if (!draft) return "";
  const n = draft.people;
  return `
    <div class="card mt-3" id="sa-restored" data-testid="restored-access">
      <div class="card-title">${escape(RESTORED_COPY.title)}</div>
      <p class="note mt-1">${escape(RESTORED_COPY.intro)}</p>
      <p class="mt-1">${n} ${n === 1 ? "person" : "people"} on the old list.${draft.mode === "open" ? " The app was open to all." : ""}</p>
      ${admin
        ? `<div class="row-2 mt-2"><button type="button" id="sa-restored-approve">${escape(RESTORED_COPY.approve)}</button><button type="button" class="secondary" id="sa-restored-discard">${escape(RESTORED_COPY.discard)}</button></div>`
        : `<p class="note mt-1">${escape(RESTORED_COPY.adminOnly)}</p>`}
    </div>`;
}
