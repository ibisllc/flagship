// Delete server — available for every registered server (online, offline,
// never came online, revoked). Two steps under one unlock of the
// sensitive-order key:
//
//   1. Best-effort: ask the box to erase itself. A wipe-now ServerDecommission
//      order (the same builder + deposit "Replace this server" uses) bound to
//      the box's registered STK. An online box picks it up and powers off; an
//      offline one never comes back anyway once its name is released.
//   2. Release the name (ReleaseServerName, the "Delete server (free name)" /
//      cancel flow). This is the step that must succeed: on failure nothing is
//      removed locally and the error is surfaced.
//
// A still-pending (never registered) server keeps the plain release flow in
// home.js.

import { depositDecommission, resolveReplacementContext } from "./serverReplacement.js";
import { releaseServerName } from "./releaseServer.js";
import { REVOCATION_REASONS } from "./revokeServer.js";
import { escapeHtml } from "./util.js";

const HEX64 = /^[0-9a-f]{64}$/i;

/** The `<server>` label of `<server>.<user>.flagship.services`. */
export function serverLabelOf(serverDomain) {
  const s = String(serverDomain ?? "").trim().toLowerCase();
  return s.split(".")[0] || s;
}

/** The typed-name gate: the server label, trimmed, case-insensitive. */
export function deleteNameMatches(typed, serverDomain) {
  const want = serverLabelOf(serverDomain);
  return want.length > 0 && String(typed ?? "").trim().toLowerCase() === want;
}

/** Whether a revocation reason still belongs in the server list (with
 *  Un-revoke). Any other reason, or none, means the server is gone. */
export function isListableRevocation(reason) {
  return REVOCATION_REASONS.includes(reason);
}

/** The pod entry for `serverDomain` in a `/pods` list, or null. */
export function findPod(pods, serverDomain) {
  const want = String(serverDomain ?? "").toLowerCase();
  if (!want || !Array.isArray(pods)) return null;
  return pods.find((p) => String(p?.serverDomain ?? "").toLowerCase() === want) ?? null;
}

// Servers deleted in this tab, so a stale /pods snapshot or server list can't
// paint them back before `.com` catches up. Short-lived on purpose: the name is
// free again, and a new server may take it.
const RECENTLY_DELETED_TTL_MS = 5 * 60_000;
const recentlyDeleted = new Map();

export function markRecentlyDeleted(serverDomain, now = Date.now()) {
  recentlyDeleted.set(String(serverDomain).toLowerCase(), now);
}

export function isRecentlyDeleted(serverDomain, now = Date.now()) {
  const key = String(serverDomain ?? "").toLowerCase();
  const at = recentlyDeleted.get(key);
  if (at == null) return false;
  if (now - at > RECENTLY_DELETED_TTL_MS) {
    recentlyDeleted.delete(key);
    return false;
  }
  return true;
}

/** The success toast. `depositOk` is null when the server never registered a
 *  box key, so there was nothing to ask. */
export function deleteToastCopy(serverDomain, depositOk) {
  const base = `Deleted ${serverLabelOf(serverDomain)}.`;
  if (depositOk === true) return `${base} If it's online it will erase itself and power off.`;
  if (depositOk === false) return `${base} It couldn't be asked to erase itself.`;
  return base;
}

/**
 * Run the delete. `signWithIrk` is the sensitive-order signer, obtained once by
 * the caller and used for both the order and the release.
 *
 * Resolves `{ ok: true, depositOk }`, or `{ ok: false, pending: true, ... }`
 * when a companion profile's release was queued for the owner (the caller
 * shows the pending sheet and calls `finishDelete` on approval). Throws when
 * the release fails; the server is then left as it was.
 *
 * @param {object} args
 * @param {string} args.serverDomain
 * @param {string} args.username
 * @param {string|null} [args.identityPubKey]  the box STK from /pods; undefined ⇒ looked up
 * @param {Uint8Array} args.umk
 * @param {string} args.irkPubHex
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {object} [deps]  test seams: depositDecommission, releaseServerName, resolveIdentity, now
 */
export async function deleteServer(args, deps = {}) {
  const { serverDomain, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain || !username) throw new Error("serverDomain and username required");
  const deposit = deps.depositDecommission || depositDecommission;
  const release = deps.releaseServerName || releaseServerName;

  let stk = args.identityPubKey;
  if (stk === undefined) {
    const resolve = deps.resolveIdentity
      || (async () => (await resolveReplacementContext({ serverDomain, username }, deps)).retiredStkPubHex);
    stk = await resolve().catch(() => null);
  }

  let depositOk = null;
  if (typeof stk === "string" && HEX64.test(stk)) {
    try {
      await deposit(
        {
          serverDomain,
          username,
          retiredStkPubHex: stk.toLowerCase(),
          disposition: "wipe-now",
          backupEnrolled: false,
          finalBackup: false,
          umk,
          irkPubHex,
          signWithIrk,
        },
        deps,
      );
      depositOk = true;
    } catch (e) {
      console.warn("delete server: decommission deposit failed", e);
      depositOk = false;
    }
  }

  const out = await release({ username, serverDomain, umk, signWithIrk }, deps);
  if (out && out.pending) return { ...out, depositOk };
  finishDelete(serverDomain, deps);
  return { ok: true, depositOk };
}

/** Drop a deleted server from this tab's lists. */
export function finishDelete(serverDomain, deps = {}) {
  markRecentlyDeleted(serverDomain, (deps.now || Date.now)());
}

/**
 * The confirm dialog: typed-name gate, then the delete under one sensitive
 * signer. Resolves `{ deleted: true }` on success, `{ deleted: false }` when
 * dismissed or left pending.
 *
 * @param {{ serverDomain: string, username: string, identityPubKey?: string|null }} target
 * @param {{ session: object, signer: Function, irkPubHex: string, toast: Function, humanError: Function, onDeleted?: Function }} env
 */
export function openDeleteServerDialog(target, env) {
  const { serverDomain, username } = target;
  const label = serverLabelOf(serverDomain);
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Delete server");
  dlg.innerHTML = `
    <h3 class="modal-title">Delete ${escapeHtml(label)}?</h3>
    <p class="modal-message">
      Deletes <strong>${escapeHtml(label)}</strong> for good. If the box is
      online it erases its data and powers off; if it's offline it can never
      come back online. The name becomes free to reuse.
    </p>
    <label class="caption mt-2">Type <strong>${escapeHtml(label)}</strong> to confirm</label>
    <input class="full-width mt-1" data-delete-input placeholder="${escapeHtml(label)}" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <p class="modal-error err-text hidden" data-delete-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-delete-cancel>Cancel</button>
      <button class="danger" data-delete-go disabled>Delete server</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const input = dlg.querySelector("[data-delete-input]");
  const goBtn = dlg.querySelector("[data-delete-go]");
  const cancelBtn = dlg.querySelector("[data-delete-cancel]");
  const errEl = dlg.querySelector("[data-delete-error]");
  let busy = false;

  return new Promise((resolve) => {
    const done = (result) => {
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(result);
    };
    const onClose = () => { if (!busy) done({ deleted: false }); };
    dlg.addEventListener("close", onClose);
    dlg.addEventListener("cancel", (ev) => { if (busy) ev.preventDefault(); });
    cancelBtn.addEventListener("click", () => { if (!busy) done({ deleted: false }); });
    input.addEventListener("input", () => {
      goBtn.disabled = busy || !deleteNameMatches(input.value, serverDomain);
    });
    input.focus();

    goBtn.addEventListener("click", async () => {
      if (!deleteNameMatches(input.value, serverDomain)) return;
      busy = true;
      goBtn.disabled = true;
      cancelBtn.disabled = true;
      input.disabled = true;
      errEl.classList.add("hidden");
      goBtn.textContent = "Deleting…";
      try {
        const out = await deleteServer({
          serverDomain,
          username,
          identityPubKey: target.identityPubKey,
          umk: env.session.umk,
          irkPubHex: env.irkPubHex,
          signWithIrk: env.signer,
        });
        if (out.pending) {
          busy = false;
          done({ deleted: false });
          const { showCompanionPendingSheet, outcomeToastCopy } = await import("./companionPendingSheet.js");
          const result = await showCompanionPendingSheet(out);
          if (result.outcome === "approved") {
            finishDelete(serverDomain);
            env.toast(deleteToastCopy(serverDomain, out.depositOk), "ok");
            env.onDeleted?.();
          } else {
            const { text, kind } = outcomeToastCopy(result.outcome);
            env.toast(text, kind);
          }
          return;
        }
        busy = false;
        done({ deleted: true });
        env.toast(deleteToastCopy(serverDomain, out.depositOk), "ok");
        env.onDeleted?.();
      } catch (e) {
        busy = false;
        cancelBtn.disabled = false;
        input.disabled = false;
        goBtn.textContent = "Delete server";
        goBtn.disabled = !deleteNameMatches(input.value, serverDomain);
        errEl.textContent = `Delete failed: ${env.humanError(e)}`;
        errEl.classList.remove("hidden");
      }
    });
  });
}
