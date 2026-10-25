// SEC-REPAIR-001: a cloud-recovery record made before `.com` checked the passkey is released on the
// passphrase alone. Each device asks its owner once to update it (a new recovery passkey, whose
// public key `.com` keeps); "Not now" is remembered per account and Settings keeps an Update row.
// Everything keeps working either way.

import { recoveryPasskeyStatus, setupCloudRecovery } from "./recovery.js";
import { recoveryUpdateAsked, markRecoveryUpdateAsked } from "./recoveryUpdateFlag.js";
import { inlineChoice } from "./modal.js";
import { toast } from "./toast.js";
import { getSession } from "./state.js";
import { isCompanionProfile } from "./companionGuard.js";
import { getPodBaseUrl } from "./api.js";
import { tr } from "./i18n.js";

export const RECOVERY_UPDATE_COPY = Object.freeze({
  title: tr("Update your account recovery"),
  body: tr("Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy. Enter your recovery passphrase, then confirm with your passkey once."),
  update: tr("Update"),
  notNow: tr("Not now"),
  row: tr("Update account recovery"),
  done: tr("Account recovery updated."),
});

/** Run the update: the recovery window asks the passphrase, then one passkey sheet. */
export async function runRecoveryUpdate(username, { setup = setupCloudRecovery, notify = toast } = {}) {
  await setup(username);
  markRecoveryUpdateAsked(username);
  notify(RECOVERY_UPDATE_COPY.done, "ok");
}

/**
 * Ask once on this device when the account's record is from before. Resolves to "update", "later",
 * or null when nothing was asked.
 */
export async function maybeAskRecoveryUpdate(username, {
  status = recoveryPasskeyStatus,
  ask = () =>
    inlineChoice({
      title: RECOVERY_UPDATE_COPY.title,
      message: RECOVERY_UPDATE_COPY.body,
      choices: [
        { id: "later", label: RECOVERY_UPDATE_COPY.notNow, secondary: true },
        { id: "update", label: RECOVERY_UPDATE_COPY.update },
      ],
    }),
  run = runRecoveryUpdate,
  notify = toast,
} = {}) {
  if (!username || recoveryUpdateAsked(username)) return null;
  const st = await status(username);
  if (!st?.exists || !st.legacy) return null;
  const choice = await ask();
  if (choice !== "update" && choice !== "later") return null;
  markRecoveryUpdateAsked(username);
  if (choice === "update") {
    try {
      await run(username);
    } catch (e) {
      notify(tr("Setup failed: {0}", e?.message ?? e), "err");
    }
  }
  return choice;
}

/** On the first Home of an unlocked owner session with a server, once per page load. */
export function startRecoveryUpdatePrompt({ isUnlocked }) {
  let done = false;
  document.addEventListener("flagship:view-shown", (ev) => {
    if (done || ev.detail?.id !== "view-home") return;
    let username = "";
    try {
      if (!isUnlocked() || isCompanionProfile() || !getSession()?.umk || !getPodBaseUrl()) return;
      username = getSession()?.username ?? "";
    } catch {
      return;
    }
    if (!username) return;
    done = true;
    void maybeAskRecoveryUpdate(username).catch(() => {});
  });
}
