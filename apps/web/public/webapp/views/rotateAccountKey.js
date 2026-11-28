// "Change your account key" (docs/account-key-rotation.md): the question in Remove from account, the summary,
// the run, the progress card on Trusted devices, and the banner a kept browser shows while it takes the new key.

import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { getActiveProfile } from "../lib/profiles.js";
import { formatWhen } from "../lib/dateFormat.js";
import { accountReadFetch } from "../lib/accountRead.js";
import { screensFetchForPod } from "../lib/api.js";
import { controlApex } from "../lib/apex.js";
import { strictInForce } from "../lib/assurancePolicy.js";
import { isAdminRootKey } from "../lib/keyCustody.js";
import { hasCloudRecovery } from "../lib/recovery.js";
import { bytesToHex, deriveAccountDeviceSeedFromSeed, persistAccountDeviceSeed } from "../keystore.js";
import { fetchDecryptedDirectory, updateSelfDisplayName } from "../lib/accountDirectory.js";
import {
  ACCOUNT_KEY_COPY,
  fetchAccountKeys,
  fetchServerKeyStatuses,
  migrateDerivedDeviceKey,
  planRotation,
  rotationComplete,
  rotationProgress,
  runRotation,
  serverNotReady,
} from "../lib/accountKeyChange.js";
import {
  accountKeyDeps,
  clearRecoveryOffWarning,
  clearRotationProgress,
  keyChangeWaiting,
  onAccountKeyState,
  recoveryOffAfterKeyChange,
  rotationInProgress,
  runAccountKeyUpkeep,
} from "../lib/accountKeyUpkeep.js";
import { tr } from "../lib/i18n.js";
import { deriveAidSeed } from "../lib/accountKeyRotation.js";
import { ed25519 } from "../vendor/noble-post-quantum/pq-seal.js";

export const BROWSER_ADVICE = ACCOUNT_KEY_COPY.browserAdvice;
export const CHANGE_LABEL = ACCOUNT_KEY_COPY.change;

/** "no" | "yes" | null (closed). */
export async function askCouldSomeoneUnlock(modal) {
  return modal.inlineChoice({
    title: ACCOUNT_KEY_COPY.question,
    choices: [
      { id: "no", label: ACCOUNT_KEY_COPY.answerNo, secondary: true },
      { id: "yes", label: ACCOUNT_KEY_COPY.answerYes, danger: true },
    ],
  });
}

/** The summary's body (escaped HTML). Exported for tests. */
export function summaryHtml({ plan, recoveryOn, nameOf }) {
  const lines = [];
  if (plan.removedHeldAdmin) lines.push(`<p><strong>${escapeHtml(ACCOUNT_KEY_COPY.adminFirst(nameOf(plan.removed)))}</strong></p>`);
  lines.push(`<p>${escapeHtml(ACCOUNT_KEY_COPY.othersKeep)}</p>`);
  lines.push(`<p>${escapeHtml(ACCOUNT_KEY_COPY.serversFollow)}</p>`);
  const others = plan.kept.filter((k) => !k.self);
  if (others.length) {
    lines.push(`<p>${escapeHtml(ACCOUNT_KEY_COPY.keptHeading)}</p><ul data-kept>${others
      .map((k) => `<li>${escapeHtml(ACCOUNT_KEY_COPY.addedOn(nameOf(k.device), formatWhen(k.device.createdAt)))}</li>`).join("")}</ul>`);
  }
  if (plan.excluded.length) {
    lines.push(`<p>${escapeHtml(ACCOUNT_KEY_COPY.mustReAdd)}</p><ul data-excluded>${plan.excluded
      .map((e) => `<li>${escapeHtml(e.reason === "derived" ? ACCOUNT_KEY_COPY.reasonDerived(nameOf(e.device)) : ACCOUNT_KEY_COPY.reasonNoReceiveKey(nameOf(e.device)))}</li>`).join("")}</ul>`);
  }
  lines.push(`<p>${escapeHtml(ACCOUNT_KEY_COPY.browsersApprove)}</p>`);
  if (recoveryOn) lines.push(`<p>${escapeHtml(ACCOUNT_KEY_COPY.recoveryAgain)}</p>`);
  lines.push(`<p class="note small">${escapeHtml(ACCOUNT_KEY_COPY.oldBackups)}</p>`);
  return lines.join("");
}

/** A plain dialog: the summary and "Change account key" / "Cancel". Resolves true to go ahead. */
function openSummary(bodyHtml) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "ceremony-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML = `
      <form method="dialog" class="modal-card">
        <h3 class="modal-title">${escapeHtml(ACCOUNT_KEY_COPY.title)}</h3>
        <div class="modal-message">${bodyHtml}</div>
        <div class="row-2 mt-3">
          <button type="button" class="secondary" data-cancel>${escapeHtml(ACCOUNT_KEY_COPY.cancel)}</button>
          <button type="button" class="danger" data-primary>${escapeHtml(ACCOUNT_KEY_COPY.change)}</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    const close = (v) => {
      try { dialog.close(); } catch { /* polyfilled */ }
      dialog.remove();
      resolve(v);
    };
    dialog.querySelector("[data-cancel]").addEventListener("click", () => close(false));
    dialog.querySelector("[data-primary]").addEventListener("click", () => close(true));
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(false); });
  });
}

async function getJson(url) {
  const r = await accountReadFetch(url, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

async function accountPods(username) {
  return (await getJson(`${controlApex()}/api/users/${encodeURIComponent(username)}/pods`).catch(() => null))?.pods ?? [];
}

/** True when any of the account's servers is under strict (`.com` would then ask for the hybrid companion). */
async function anyServerStrict(username, pods) {
  for (const p of pods) {
    const fqdn = String(p.serverDomain ?? "").toLowerCase();
    if (!fqdn || p.revokedAt) continue;
    const served = await getJson(`${controlApex()}/api/accounts/${encodeURIComponent(username)}/assurance-policy/installation/${encodeURIComponent(fqdn)}`).catch(() => null);
    if (served?.state && strictInForce(served.state)) return true;
  }
  return false;
}

/**
 * The "Yes, or I'm not sure" path for `device`. `nameOf(device)` names a directory row. Resolves true when the
 * key was changed. Every refusal is shown in its own sentence.
 */
export async function startAccountKeyChange(device, { nameOf, modal }) {
  const session = getSession();
  const profile = getActiveProfile();
  const u = String(profile?.accountId ?? session.username ?? "").toLowerCase();
  const alert = (message) => modal.inlineAlert({ title: ACCOUNT_KEY_COPY.title, message });
  if (!isAdminRootKey(session.adminRootSeed)) {
    await alert(ACCOUNT_KEY_COPY.notAdmin);
    return false;
  }
  const pods = await accountPods(u);
  const statuses = await fetchServerKeyStatuses(pods, { screensFetchForPod });
  const notReady = serverNotReady(statuses);
  if (notReady) {
    await alert(ACCOUNT_KEY_COPY.updateServers(notReady.name));
    return false;
  }
  if (await anyServerStrict(u, pods)) {
    await alert(ACCOUNT_KEY_COPY.strictWeb);
    return false;
  }
  const account = await fetchAccountKeys(u);
  const localIrk = bytesToHex(session.irk.publicKey);
  if (account.irkPub !== localIrk) {
    // Another admin device changed it already: take the new key first.
    await runAccountKeyUpkeep({ force: true });
    await alert(ACCOUNT_KEY_COPY.conflict);
    return false;
  }
  let directory = await fetchDecryptedDirectory();
  let plan;
  try {
    plan = planRotation({ username: u, directory, removedDeviceId: device.deviceId, selfDeviceId: profile.deviceId, umk: session.umk });
  } catch (e) {
    if (e?.code !== "self-derived") throw e;
    // This browser's own key still comes from the account key: give it its own first (the admin root signs).
    const me = directory.devices.find((d) => d.deviceId === profile.deviceId);
    const res = await migrateDerivedDeviceKey({ session, profile, grant: me?.grant ?? null }, {
      deriveAccountDeviceSeed: deriveAccountDeviceSeedFromSeed,
      persistAccountDeviceSeed,
    });
    if (res !== "migrated") {
      await alert(ACCOUNT_KEY_COPY.failed);
      return false;
    }
    if (me?.selfDisplayName) {
      await updateSelfDisplayName(me.selfDisplayName, directory.selfProfiles.find((p) => p.deviceId === profile.deviceId) ?? null).catch(() => {});
    }
    directory = await fetchDecryptedDirectory();
    plan = planRotation({ username: u, directory, removedDeviceId: device.deviceId, selfDeviceId: profile.deviceId, umk: session.umk });
  }
  const recoveryOn = await hasCloudRecovery(u);
  if (!(await openSummary(summaryHtml({ plan, recoveryOn, nameOf })))) return false;
  const ownName = directory.devices.find((d) => d.deviceId === profile.deviceId)?.selfDisplayName ?? null;
  toast(ACCOUNT_KEY_COPY.changing);
  const aidPubHex = bytesToHex(ed25519.getPublicKey(deriveAidSeed(session.umk)));
  try {
    await runRotation(
      { session, profile, plan, directory, account: { username: u, keyEpoch: account.keyEpoch, irkPubHex: localIrk, aidPubHex }, recoveryWasOn: recoveryOn },
      accountKeyDeps(),
    );
  } catch (e) {
    console.error("account key change failed", e);
    await alert(e?.message || ACCOUNT_KEY_COPY.failed);
    return false;
  }
  await updateSelfDisplayName(ownName ?? tr("This browser"), null).catch(() => {});
  toast(ACCOUNT_KEY_COPY.changed, "ok");
  return true;
}

/** The progress card's HTML for a change this browser made (empty when there is none). Exported for tests. */
export function progressHtml(progress, { recoveryOff }) {
  const parts = [`<div class="weight-600">${escapeHtml(ACCOUNT_KEY_COPY.progressTitle)}</div>`];
  if (progress) {
    parts.push(`<p class="note small" data-devices>${escapeHtml(ACCOUNT_KEY_COPY.devicesUpdated(progress.devices.updated, progress.devices.total))}</p>`);
    parts.push(`<p class="note small" data-servers>${escapeHtml(ACCOUNT_KEY_COPY.serversUpdated(progress.servers.updated, progress.servers.total))}</p>`);
    for (const name of progress.servers.waiting) parts.push(`<p class="note small" data-waiting>${escapeHtml(ACCOUNT_KEY_COPY.waitingFor(name))}</p>`);
    for (const r of progress.servers.rekeyDue) parts.push(`<p class="note small" data-rekey>${escapeHtml(ACCOUNT_KEY_COPY.stillToDo(r.name, r.what))}</p>`);
    if (!rotationComplete(progress)) parts.push(`<button class="secondary mt-2" data-key-change-retry>${escapeHtml(ACCOUNT_KEY_COPY.retry)}</button>`);
  }
  if (recoveryOff) {
    parts.push(`<p class="note small err-text" data-recovery-off>${escapeHtml(ACCOUNT_KEY_COPY.recoveryOff)}</p>`);
    parts.push(`<button class="secondary mt-2" data-key-change-recovery>${escapeHtml(ACCOUNT_KEY_COPY.setUpRecovery)}</button>`);
  }
  return `<div class="card" id="account-key-progress">${parts.join("")}</div>`;
}

/** The card above Trusted devices while a change this browser made is finishing. Returns its HTML or "". */
export async function renderAccountKeyProgress() {
  const profile = getActiveProfile();
  const u = String(profile?.accountId ?? "").toLowerCase();
  if (!u) return "";
  const marker = rotationInProgress(u);
  let recoveryOff = recoveryOffAfterKeyChange(u);
  if (recoveryOff && (await hasCloudRecovery(u))) {
    clearRecoveryOffWarning(u);
    recoveryOff = false;
  }
  if (!marker && !recoveryOff) return "";
  let progress = null;
  if (marker) {
    const directory = await fetchDecryptedDirectory().catch(() => null);
    const statuses = await fetchServerKeyStatuses(await accountPods(u), { screensFetchForPod });
    progress = rotationProgress({ keyEpoch: marker.keyEpoch, kept: marker.kept, selfProfiles: directory?.selfProfiles ?? [], serverStatuses: statuses });
    if (rotationComplete(progress)) clearRotationProgress(u);
  }
  return progressHtml(progress, { recoveryOff });
}

/** Buttons of the progress card; `rerender` draws the view again. */
export function bindAccountKeyProgress(root, rerender) {
  root.querySelector("[data-key-change-retry]")?.addEventListener("click", () => rerender());
  root.querySelector("[data-key-change-recovery]")?.addEventListener("click", () => show("view-recovery"));
}

let banner = null;

function setBanner(text, kind) {
  if (typeof document === "undefined") return;
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "account-key-banner";
    banner.className = "card";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    document.body.prepend(banner);
  }
  banner.textContent = text;
  banner.dataset.kind = kind;
  banner.hidden = false;
}

/** The kept browser's banner: while a change waits, when it is done, when it can't be checked. Idempotent. */
export function initAccountKeyBanner() {
  if (typeof document === "undefined" || initAccountKeyBanner._done) return;
  initAccountKeyBanner._done = true;
  onAccountKeyState(({ state, message }) => {
    setBanner(message, state);
    if (state === "updated") setTimeout(() => { if (banner) banner.hidden = true; }, 6000);
  });
  if (keyChangeWaiting()) setBanner(ACCOUNT_KEY_COPY.bannerPlain, "waiting");
}
