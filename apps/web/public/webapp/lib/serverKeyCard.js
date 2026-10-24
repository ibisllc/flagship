// The server page's key card (docs/first-contact.md): a server whose key this device hasn't pinned
// (one paired before pins, or one that never asks for approval again) shows its code beside a
// "Trust this server" button; a server naming another key than the pin says so. A pinned server shows
// nothing, and an admin device keeps its app-name grant in place.

import { getSession } from "./state.js";
import { serverCode } from "./enrollment.js";
import { escapeHtml } from "./util.js";
import { tr } from "./i18n.js";
import { toast } from "./toast.js";
import {
  pinnedStk,
  pinServerKey,
  serverKeyChanged,
  noteKeyChanged,
  codeConfirmed,
  loadEnrollmentSecret,
  forgetFirstContactSecrets,
} from "./serverPins.js";
import {
  codeBoxHtml,
  refusalHtml,
  KEY_CHANGED,
  upkeepWildcardGrant,
  sendPendingWildcardGrants,
  grantAppNames,
} from "./firstContact.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** What the card shows for `domain` with `/pods` row `pod`: "changed", "unpinned", or null. */
export async function serverKeyState(domain, pod, deps = {}) {
  const d = String(domain ?? "").toLowerCase();
  const offered = String(pod?.identityPubKey ?? "").toLowerCase();
  const pin = (deps.pinnedStk || pinnedStk)(d);
  if (pin) {
    if (HEX64.test(offered) && offered !== pin) {
      noteKeyChanged(d, offered);
      return { kind: "changed" };
    }
    return serverKeyChanged(d) ? { kind: "changed" } : null;
  }
  if (!HEX64.test(offered) || pod?.revokedAt != null) return null;
  // The device that made the recipe pins at the blessing, where the box's proof is checked.
  const cameOnline = pod?.lastReported != null || pod?.currentCert != null;
  const umk = deps.umk ?? getSession()?.umk;
  if (!umk) return null;
  if (!cameOnline && (await (deps.loadEnrollmentSecret || loadEnrollmentSecret)(umk, d))) return null;
  return {
    kind: "unpinned",
    stk: offered,
    fc: { pinState: "first-sight", refusal: null, code: await serverCode(offered), studioConfirmed: codeConfirmed(d, offered) },
  };
}

export function serverKeyCardHtml(state) {
  if (!state) return "";
  if (state.kind === "changed") {
    return `<div class="card warning mt-2" id="server-key-card" data-server-key="changed">${refusalHtml({ refusal: KEY_CHANGED })}</div>`;
  }
  return `<div class="card mt-2" id="server-key-card" data-server-key="unpinned">
      <p class="note">${escapeHtml(tr("This device hasn't checked this server's key yet."))}</p>
      ${codeBoxHtml(state.fc)}
      <button class="primary full-width mt-2" id="server-key-trust" type="button">${escapeHtml(tr("Trust this server"))}</button>
    </div>`;
}

/**
 * Paint the card into `slot` and wire it. A pinned server gets its grant upkeep instead
 * (best-effort, silent).
 */
export async function wireServerKeyCard(slot, domain, pod, deps = {}) {
  const d = String(domain ?? "").toLowerCase();
  if (!slot || !d) return;
  const state = await serverKeyState(d, pod, deps);
  slot.innerHTML = serverKeyCardHtml(state);
  if (!state) {
    if ((deps.pinnedStk || pinnedStk)(d)) {
      await sendPendingWildcardGrants([d], deps).catch(() => {});
      await upkeepWildcardGrant(d, deps).catch(() => {});
    }
    return;
  }
  if (state.kind !== "unpinned") return;
  slot.querySelector("#server-key-trust")?.addEventListener("click", async () => {
    try {
      pinServerKey(d, state.stk, state.fc.studioConfirmed ? "studio" : "first-sight");
      await forgetFirstContactSecrets(d).catch(() => {});
      slot.innerHTML = "";
      toast(tr("Trusted {0}.", d));
      await grantAppNames(d, deps).catch(() => {});
    } catch (e) {
      toast(e?.code === "server-key-changed" ? tr("This server's key changed. If you did not rebuild it, do not approve anything for it.") : String(e?.message || e), "err");
    }
  });
}
