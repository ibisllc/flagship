// Service access gating — friend deep-link redeem (docs/service-access-gating.md).
//
// The owner shares `https://<server>.<user>/invite#<secret>&a=<authorAID>&i=<inviteId>`.
// The friend opens it; the webapp is served from the BOX origin, so this view
// redeems against the SAME origin (location.origin = the box's pinned pipe):
//
//   1. parse #k=<secret>&a=<authorAID>&i=<inviteId> from the URL fragment,
//   2. ensure the friend is unlocked (their OWN UMK),
//   3. derive their PER-AUTHOR CONTACT AID (deriveContactAccountId(UMK,authorAID))
//      so the binding is unlinkable across authors — NOT the global AID,
//   4. CONTACT-AID-sign the redeem + POST it to <box>/api/service-invites/redeem,
//   5a. AUTO-approve → bound; the friend can open the restricted service.
//   5b. MANUAL-approve {pending} → the friend EMITS a contact-AID-signed
//       acceptance (link/code/QR) to send back to the author, who finalizes it.
//
// Back-compat: a v1 bare `#<secret>` link (no author AID) falls back to the
// GLOBAL AID and has no manual loop (the author can't have asked for one).
//
// Boot hook (lib/inviteRedeem.js → boot() / app.js): when this load IS a
// /invite#… landing, boot routes here BEFORE the normal unlock/first-run
// dispatch. The context is held in module state across an unlock so we can
// finish the redeem once the friend has their key.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { hasWrappedUmk } from "../keystore.js";
import {
  deriveAccountIdFromSeed,
  deriveContactAccountIdFromSeed,
  signWithAccountId,
  signWithContactAccountId,
} from "../keystore.js";
import { redeemInvite, signAcceptServiceInvite, buildAcceptReply } from "../lib/serviceInvite.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-invite-redeem");

// The secret the friend is redeeming, held across an unlock detour.
let pendingSecretHex = null;
// The box origin this /invite was served from (the redeem target).
let boxOrigin = null;
// v2 context from the link fragment: the author's AID (hex) + the inviteId (hex).
let pendingAuthorAidHex = null;
let pendingInviteId = null;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Enter the redeem flow with a parsed secret. `boxBaseUrl` is the origin the
 * /invite page was served from (defaults to the live location.origin). `ctx`
 * carries the v2 `{ authorAID, inviteId }` from the link fragment (when present).
 */
export async function enterInviteRedeem(secretHex, boxBaseUrl, ctx = {}) {
  pendingSecretHex = secretHex;
  boxOrigin = boxBaseUrl ?? (typeof location !== "undefined" ? location.origin : null);
  pendingAuthorAidHex =
    typeof ctx.authorAID === "string" && /^[0-9a-f]{64}$/i.test(ctx.authorAID) ? ctx.authorAID.toLowerCase() : null;
  pendingInviteId =
    typeof ctx.inviteId === "string" && /^[0-9a-f]{64}$/i.test(ctx.inviteId) ? ctx.inviteId.toLowerCase() : null;
  setSubtitle("invite");
  show("view-invite-redeem");
  await renderInviteRedeem();
}

async function renderInviteRedeem() {
  const root = $("invite-redeem-content");
  if (!pendingSecretHex) {
    root.innerHTML = `<div class="card"><p class="err-text">This invite link is missing its code.</p></div>`;
    return;
  }
  // The friend needs their own account (UMK) to prove control of their AID.
  let hasIdentity = false;
  try {
    hasIdentity = await hasWrappedUmk();
  } catch {
    hasIdentity = false;
  }
  const session = getSession();
  const unlocked = !!(session && session.umk);

  if (!hasIdentity) {
    root.innerHTML = `
      <div class="card">
        <div class="card-title">You've been invited</div>
        <p class="note mt-2">
          To accept, you need a Flagship account on this device. Set one up,
          then reopen this invite link.
        </p>
        <button id="ir-setup" class="full-width mt-2">Set up an account</button>
      </div>`;
    $("ir-setup")?.addEventListener("click", () => {
      // Send them through the normal first-run; they reopen the link after.
      show("view-bootstrap");
    });
    return;
  }

  if (!unlocked) {
    root.innerHTML = `
      <div class="card">
        <div class="card-title">You've been invited</div>
        <p class="note mt-2">Unlock this device to accept the invite.</p>
        <button id="ir-unlock" class="full-width mt-2">Unlock</button>
      </div>`;
    $("ir-unlock")?.addEventListener("click", () => {
      // Route to the unlock view; app.js re-dispatches to the pending redeem
      // after a successful unlock (resumePendingInviteRedeem).
      show("view-unlock");
    });
    return;
  }

  // Unlocked + has identity — show the accept CTA.
  root.innerHTML = `
    <div class="card">
      <div class="card-title">Accept this invite</div>
      <p class="note mt-2">
        This grants your account access to a restricted service. A private
        per-owner identity is recorded so the owner can manage access; your
        Flagship username is never shared, and the owner can't link you across
        their different services.
      </p>
      <button id="ir-accept" class="full-width mt-2">Accept &amp; get access</button>
      <div id="ir-status" class="mt-2 text-sm"></div>
    </div>`;
  $("ir-accept")?.addEventListener("click", () => onAccept().catch((e) => { console.error(e); toast(humanError(e), "err"); }));
}

/**
 * Derive the identity the friend redeems with: the PER-AUTHOR contact AID when
 * the link carried the author's AID (v2), else the GLOBAL AID (v1 back-compat).
 * Returns `{ visitorAID, sign }` where `sign(umk, bytes)` is the matching signer.
 */
async function redemptionIdentity(umk) {
  if (pendingAuthorAidHex) {
    const authorAidPub = hexToBytes(pendingAuthorAidHex);
    const contact = await deriveContactAccountIdFromSeed(umk, authorAidPub);
    return {
      visitorAID: contact.publicKey,
      // A contact-bound signer in the `(umk, bytes)` shape redeemInvite expects.
      sign: (u, bytes) => signWithContactAccountId(u, authorAidPub, bytes),
    };
  }
  const aid = await deriveAccountIdFromSeed(umk);
  return { visitorAID: aid.publicKey, sign: signWithAccountId };
}

async function onAccept() {
  const session = getSession();
  const status = $("ir-status");
  const btn = $("ir-accept");
  if (btn?.disabled) return;
  if (!session.umk) {
    show("view-unlock");
    return;
  }
  if (status) {
    status.className = "mt-2 text-sm";
    status.textContent = "accepting…";
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Accepting…";
  }
  try {
    const ident = await redemptionIdentity(session.umk);
    const r = await redeemInvite({
      baseUrl: boxOrigin,
      secretHex: pendingSecretHex,
      visitorAID: ident.visitorAID,
      umk: session.umk,
      signWithAccountId: ident.sign,
    });
    if (r.pending) {
      await renderPendingAcceptance(r.serviceRef, ident.visitorAID, session.umk);
    } else {
      renderGranted(r);
    }
  } catch (e) {
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = humanError(e);
    }
    throw e;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Accept & get access";
    }
  }
}

/** AUTO-approve success — the friend is bound and can open the service. */
function renderGranted(r) {
  const serviceRef = r.serviceRef ? escapeHtml(r.serviceRef) : "the service";
  const root = $("invite-redeem-content");
  root.innerHTML = `
    <div class="card">
      <div class="card-title">You're in</div>
      <p class="note mt-2">
        Your account now has access to <strong>${serviceRef}</strong>.
        ${r.firstBind === false ? "(You already had access — this link is linked to your account.)" : ""}
      </p>
      <button id="ir-open" class="full-width mt-2">Open it</button>
      <button id="ir-home" class="secondary full-width mt-2">Go to Flagship</button>
    </div>`;
  wireDoneButtons();
  finishRedeem();
}

/**
 * MANUAL-approve — the box held the redeem {pending}. The friend EMITS a
 * contact-AID-signed acceptance and shows the reply (link + QR + copy) to send
 * back to the author over the same private channel; the author finalizes it.
 */
async function renderPendingAcceptance(serviceRef, contactAID, umk) {
  const root = $("invite-redeem-content");
  if (!pendingInviteId || !pendingAuthorAidHex) {
    // A manual invite MUST be a v2 link (it carries the inviteId + author AID).
    root.innerHTML = `
      <div class="card">
        <div class="card-title">Almost there</div>
        <p class="note mt-2">
          This invite needs the owner to approve you, but the link is missing the
          details to do that. Ask the owner to resend the invite link.
        </p>
        <button id="ir-home" class="secondary full-width mt-2">Go to Flagship</button>
      </div>`;
    wireDoneButtons();
    finishRedeem();
    return;
  }
  const authorAidPub = hexToBytes(pendingAuthorAidHex);
  const acceptedAt = Date.now();
  const accept = {
    inviteId: pendingInviteId,
    serviceRef,
    contactAID,
    authorAID: authorAidPub,
    acceptedAt,
    umk,
  };
  const sig = await signAcceptServiceInvite(accept, signWithContactAccountId);
  // Canonical deep-link reply carrying ONLY {accept, acceptSig} (the author's box
  // fetches the owner's create from .com). The box host is this /invite's origin.
  const replyHost = (() => {
    try {
      return boxOrigin ? new URL(boxOrigin).host : location.host;
    } catch {
      return location.host;
    }
  })();
  const reply = buildAcceptReply(
    replyHost,
    { inviteId: pendingInviteId, serviceRef, contactAID: bytesToHex(contactAID), acceptedAt },
    bytesToHex(sig),
  );
  const svc = serviceRef ? escapeHtml(serviceRef) : "this service";
  root.innerHTML = `
    <div class="card">
      <div class="card-title">Send this back to the owner</div>
      <p class="note mt-2">
        The owner approves each person for <strong>${svc}</strong>. Send them this
        acceptance code over the same channel they sent you the invite — once they
        finalize it, you're in. It doesn't reveal who you are.
      </p>
      <label>Acceptance code</label>
      <input id="ir-accept-reply" type="text" readonly class="mt-1" />
      <div id="ir-accept-qr" class="mt-2" style="text-align:center;"></div>
      <div class="row-2 mt-2">
        <button id="ir-accept-share" class="secondary">Share…</button>
        <button id="ir-accept-copy" class="secondary">Copy code</button>
      </div>
      <button id="ir-home" class="full-width mt-3">Done</button>
    </div>`;
  const input = $("ir-accept-reply");
  if (input) input.value = reply;
  await renderQrInto($("ir-accept-qr"), reply);
  $("ir-accept-share")?.addEventListener("click", () => shareText(reply));
  $("ir-accept-copy")?.addEventListener("click", () => copyText(reply));
  wireDoneButtons();
  finishRedeem();
}

/** Render an inline QR of `text` into `box` (in ADDITION to the copyable text). */
async function renderQrInto(box, text) {
  if (!box) return;
  try {
    const m = await import("/qrEncoder.js");
    box.innerHTML = m.renderQrSvg(text, { size: 200, foreground: "#0f172a", background: "#ffffff" });
  } catch {
    box.innerHTML = ""; // the text is the reliable fallback
  }
}

function wireDoneButtons() {
  $("ir-open")?.addEventListener("click", () => {
    try {
      window.location.href = boxOrigin || "/";
    } catch {
      show("view-home");
    }
  });
  $("ir-home")?.addEventListener("click", async () => {
    const { enterHome } = await import("./home.js");
    await enterHome();
  });
}

/** Clear the pending secret + strip the fragment so a reload doesn't re-redeem. */
function finishRedeem() {
  pendingSecretHex = null;
  pendingAuthorAidHex = null;
  pendingInviteId = null;
  try {
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", boxOrigin && new URL(boxOrigin).pathname ? "/" : location.pathname);
    }
  } catch {
    /* best-effort */
  }
}

async function shareText(text) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Flagship acceptance", text });
      return;
    } catch {
      /* user cancelled — fall through to copy */
    }
  }
  await copyText(text);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied — send it to the owner.");
  } catch {
    toast("Couldn't copy — long-press the field to copy.", "err");
  }
}

/** Is there a pending invite redeem to resume after an unlock? */
export function hasPendingInviteRedeem() {
  return !!pendingSecretHex;
}

/** Re-render the redeem flow after the friend unlocks (called from app.js). */
export async function resumePendingInviteRedeem() {
  if (!pendingSecretHex) return false;
  setSubtitle("invite");
  show("view-invite-redeem");
  await renderInviteRedeem();
  return true;
}

export function initInviteRedeemView() {
  // No back button by default — the redeem is the whole purpose of this load.
  // A "Go to Flagship" CTA appears on success.
}
