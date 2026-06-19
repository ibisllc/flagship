// Service access gating — friend deep-link redeem (docs/service-access-gating.md).
//
// The owner shares `https://<server>.<user>/invite#<secret>`. The friend opens
// it; the webapp is served from the BOX origin, so this view redeems against
// the SAME origin (location.origin = the box's pinned pipe):
//
//   1. parse #<secret> from the URL fragment (never sent to .com),
//   2. ensure the friend is unlocked (their OWN UMK → their stable AID),
//   3. AID-sign the redeem + POST it to <box>/api/service-invites/redeem,
//   4. the box re-verifies the AID sig, delegates the first-bind to .com,
//      then adds the friend's AID to the service's allow-list,
//   5. confirm — the friend can now open the restricted service.
//
// Boot hook (lib/inviteRedeem.js → boot()): when this load IS a /invite#<secret>
// landing, boot routes here BEFORE the normal unlock/first-run dispatch (the
// same shape as /join + ?companion). The secret is held in module state across
// an unlock so we can finish the redeem once the friend has their key.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { hasWrappedUmk } from "../keystore.js";
import {
  deriveAccountIdFromSeed,
  signWithAccountId,
} from "../keystore.js";
import { redeemInvite } from "../lib/serviceInvite.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-invite-redeem");

// The secret the friend is redeeming, held across an unlock detour.
let pendingSecretHex = null;
// The box origin this /invite was served from (the redeem target).
let boxOrigin = null;

/**
 * Enter the redeem flow with a parsed secret. `boxBaseUrl` is the origin the
 * /invite page was served from (defaults to the live location.origin).
 */
export async function enterInviteRedeem(secretHex, boxBaseUrl) {
  pendingSecretHex = secretHex;
  boxOrigin = boxBaseUrl ?? (typeof location !== "undefined" ? location.origin : null);
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
        This grants your account access to a restricted service. Your account
        identity is recorded so the owner can manage access; nothing else about
        you is shared.
      </p>
      <button id="ir-accept" class="full-width mt-2">Accept &amp; get access</button>
      <div id="ir-status" class="mt-2 text-sm"></div>
    </div>`;
  $("ir-accept")?.addEventListener("click", () => onAccept().catch((e) => { console.error(e); toast(humanError(e), "err"); }));
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
    const aid = await deriveAccountIdFromSeed(session.umk);
    const r = await redeemInvite({
      baseUrl: boxOrigin,
      secretHex: pendingSecretHex,
      visitorAID: aid.publicKey,
      umk: session.umk,
      signWithAccountId,
    });
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
    // The restricted service lives at its tier-1 label on this box; without a
    // resolvable label here we route to the box root, which front-pages or
    // lists its services.
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
    // Clear the pending secret so a reload doesn't re-redeem.
    pendingSecretHex = null;
    try {
      // Strip the fragment so a refresh lands on a clean URL.
      if (typeof history !== "undefined" && history.replaceState) {
        history.replaceState(null, "", boxOrigin && new URL(boxOrigin).pathname ? "/" : location.pathname);
      }
    } catch {
      /* best-effort */
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
