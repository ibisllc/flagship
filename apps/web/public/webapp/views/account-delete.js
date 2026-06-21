// Account-deletion ceremony — full-page irreversible warning (webapp parity of
// the iOS/Android last-device deletion screen; docs/account-deletion-and-name-
// reclaim.md §2 step 2/3).
//
// Reached only when removing the last device of an account with NO cloud
// recovery (the account-DEATH branch decided by accountDeletePolicy). It states
// the irreversible consequences, offers the opt-in "ask all my servers to
// delete their content" checkbox (default OFF), and gates the final confirm
// behind TYPING the username + the in-memory UMK strong-confirm. On a 200 the
// ceremony wipes local key material and drops to Welcome.
//
// The crypto + network live in lib/accountDeletion.js (pure + tested); this
// module is the DOM shell + wiring.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession, lockSession } from "../lib/state.js";
import { signWithIrk, resetDevice } from "../keystore.js";
import { remove as profileRemove } from "../lib/profilesStore.js";
import { stopRenewals } from "./home.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { runDeletionCeremony } from "../lib/accountDeletion.js";

registerView("view-account-delete");

let ceremonyUsername = "";

/** Enable the final delete button only when the typed handle matches the
 *  account username (case-insensitive — the canonical bytes lowercase it). */
function refreshConfirmGate() {
  const typed = ($("account-delete-confirm-input")?.value || "").trim().toLowerCase();
  const matches = typed.length > 0 && typed === ceremonyUsername.toLowerCase();
  const btn = $("account-delete-go");
  if (btn) btn.disabled = !matches;
}

async function runDelete() {
  const session = getSession();
  if (!session.umk) {
    toast("unlock first", "err");
    return;
  }
  const includeServers = !!$("account-delete-wipe-content")?.checked;
  const btn = $("account-delete-go");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Deleting…";
  }
  try {
    await runDeletionCeremony({
      username: ceremonyUsername,
      includeServers,
      umk: session.umk,
      signWithIrk,
      resetDevice,
      lockSession,
      profileRemove,
      stopRenewals,
      show,
      setSubtitle,
    });
    toast("account deleted");
  } catch (e) {
    // 403 "not the last device", stale request, etc. — surface and leave the
    // device intact (nothing local was touched: the wipe runs only after 200).
    console.error("account deletion failed", e);
    toast(humanError(e), "err");
    if (btn) {
      btn.textContent = "Delete my account";
      refreshConfirmGate();
    }
  }
}

export function initAccountDeleteView() {
  $("account-delete-back")?.addEventListener("click", () => show("view-settings"));
  $("account-delete-confirm-input")?.addEventListener("input", refreshConfirmGate);
  $("account-delete-go")?.addEventListener("click", () => {
    runDelete().catch((e) => {
      console.error("account deletion error", e);
      toast(humanError(e), "err");
    });
  });
}

/** Present the deletion ceremony for the active account. Resets the form to a
 *  safe, gated state every time so a previous typed handle can't carry over. */
export function enterAccountDelete() {
  ceremonyUsername = getSession().username || "";
  const nameEl = $("account-delete-username");
  if (nameEl) nameEl.textContent = ceremonyUsername;
  const promptEl = $("account-delete-confirm-prompt");
  if (promptEl) promptEl.textContent = ceremonyUsername;
  const input = $("account-delete-confirm-input");
  if (input) input.value = "";
  const wipe = $("account-delete-wipe-content");
  if (wipe) wipe.checked = false;
  const btn = $("account-delete-go");
  if (btn) {
    btn.textContent = "Delete my account";
    btn.disabled = true;
  }
  show("view-account-delete");
}
