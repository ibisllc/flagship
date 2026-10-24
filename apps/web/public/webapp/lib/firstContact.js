// First contact (docs/first-contact.md): what a server's first request means on this device, the
// six-digit code box above Approve, and the app-name certificate grant signed in the same moment.

import { getSession } from "./state.js";
import { verifyEnrollmentProof, serverCode } from "./enrollment.js";
import { serverWildcardGrantBody } from "./serverWildcardGrant.js";
import { sensitiveSigner } from "./adminRoot.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { screensFetchForPod } from "./api.js";
import { escapeHtml } from "./util.js";
import { tr } from "./i18n.js";
import {
  pinnedStk,
  noteKeyChanged,
  codeConfirmed,
  loadEnrollmentSecret,
} from "./serverPins.js";

export const NOT_YOUR_RECIPE = "not-your-recipe";
export const KEY_CHANGED = "key-changed";
export const WILDCARD_GRANT_PATH = "/api/screens/server-wildcard-grant";

/** The refusal sentence a person reads for each refusal. */
export function refusalText(refusal) {
  if (refusal === NOT_YOUR_RECIPE) return tr("This server was not built from your recipe. Do not approve it.");
  if (refusal === KEY_CHANGED) return tr("This server's key changed. If you did not rebuild it, do not approve anything for it.");
  return "";
}

/** "482913" → "482 913". */
export function formatServerCode(code) {
  const c = String(code ?? "");
  return /^\d{6}$/.test(c) ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/**
 * Classify a request signed by `stkPubHex` (already verified under that key) for this device:
 *   - pinState "pinned": the key is the pin;
 *   - "proven": no pin yet, this device made the recipe and the box's proof verifies;
 *   - "awaiting-proof": no pin yet, this device made the recipe, and the request can't carry a proof
 *     (a start-up unlock, asked before the disk is open): approving unlocks it without pinning;
 *   - "first-sight": no pin yet and no secret here (another device, a demo account, or a server
 *     that came online before this device saw it): pin on Approve, with the code shown;
 *   - refusal KEY_CHANGED or NOT_YOUR_RECIPE: no Approve.
 * `code` is always computed here from the key, never taken from the box or `.com`.
 */
export async function classifyFirstContact(req, deps = {}) {
  const domain = String(req.serverDomain ?? "").toLowerCase();
  const stk = String(req.stkPubHex ?? "").toLowerCase();
  const code = await serverCode(stk);
  const base = { code, studioConfirmed: codeConfirmed(domain, stk) };
  const pin = (deps.pinnedStk || pinnedStk)(domain);
  if (pin) {
    if (pin !== stk) {
      noteKeyChanged(domain, stk);
      return { ...base, pinState: "changed", refusal: KEY_CHANGED };
    }
    return { ...base, pinState: "pinned", refusal: null };
  }
  const umk = deps.umk ?? getSession()?.umk;
  const secret = umk ? await (deps.loadEnrollmentSecret || loadEnrollmentSecret)(umk, domain) : null;
  if (!secret || req.cameOnline) return { ...base, pinState: "first-sight", refusal: null };
  if (req.purpose === "unlock-key") return { ...base, pinState: "awaiting-proof", refusal: null };
  const ok = await verifyEnrollmentProof(
    secret.secretHex,
    { serverDomain: domain, stkPubHex: stk, authCodeSerial: secret.serial },
    req.deviceInfo?.enrollmentProof,
  );
  return ok ? { ...base, pinState: "proven", refusal: null } : { ...base, pinState: "unproven", refusal: NOT_YOUR_RECIPE };
}

/** The small box directly above Approve: the code, or "Confirmed by Studio". Empty once pinned. */
export function codeBoxHtml(fc) {
  if (!fc || fc.refusal || fc.pinState === "pinned" || !fc.code) return "";
  if (fc.studioConfirmed) {
    return `<div class="server-code-box mt-2" data-server-code-confirmed>${escapeHtml(tr("Confirmed by Studio"))}</div>`;
  }
  const code = formatServerCode(fc.code);
  return `<div class="server-code-box mt-2" data-server-code="${escapeHtml(fc.code)}">${escapeHtml(tr("If your machine has a monitor, it is showing this code: {0}", code))}</div>`;
}

export function refusalHtml(fc) {
  if (!fc?.refusal) return "";
  return `<p class="err-text mt-2" data-first-contact-refusal="${escapeHtml(fc.refusal)}">${escapeHtml(refusalText(fc.refusal))}</p>`;
}

// ── App-name certificate grant ──────────────────────────────────────────────

const PENDING_KEY = "flagship.wildcardGrantPending.v1";

function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writePending(map) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(map));
  } catch { /* storage off: the grant is signed again at the next upkeep */ }
}

/** Whether this device signs the grant: the account's admin device (or a demo account's device). */
export function signsWildcardGrant(deps = {}) {
  return (deps.canSign || canSignAdminOrders)();
}

/**
 * Sign `flagship/server-wildcard-grant/v1` for `serverDomain` over its PINNED key with the
 * sensitive-order key (admin root where the account has one, else the IRK).
 */
export async function signWildcardGrant(serverDomain, deps = {}) {
  const session = deps.session ?? getSession();
  if (!session?.umk || !session?.username) throw new Error("unlock the webapp first");
  const stk = (deps.pinnedStk || pinnedStk)(serverDomain);
  if (!stk) throw new Error("this server is not pinned on this device");
  const sign = deps.sign || sensitiveSigner();
  return serverWildcardGrantBody(
    { username: session.username, serverDomain: String(serverDomain).toLowerCase(), stkPubHex: stk, issuedAt: (deps.now || Date.now)() },
    (bytes) => sign(session.umk, bytes),
  );
}

async function postGrant(serverDomain, body, deps) {
  const send = deps.screensFetchForPod || screensFetchForPod;
  await send(String(serverDomain).toLowerCase(), WILDCARD_GRANT_PATH, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Sign the grant now (the session is unlocked) and send it to the server. A server that isn't up yet
 * (a first start-up) keeps it here until `sendPendingWildcardGrants` reaches it.
 */
export async function grantAppNames(serverDomain, deps = {}) {
  if (!signsWildcardGrant(deps)) return { sent: false, skipped: true };
  const d = String(serverDomain).toLowerCase();
  const body = await signWildcardGrant(d, deps);
  const map = readPending();
  map[d] = { ...body, stk: (deps.pinnedStk || pinnedStk)(d) };
  writePending(map);
  try {
    await postGrant(d, body, deps);
    const after = readPending();
    delete after[d];
    writePending(after);
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

/** Retry the signed grants the servers haven't taken yet (only for the key still pinned). */
export async function sendPendingWildcardGrants(domains, deps = {}) {
  const map = readPending();
  const want = domains ? new Set([...domains].map((x) => String(x).toLowerCase())) : null;
  for (const [d, g] of Object.entries(map)) {
    if (want && !want.has(d)) continue;
    if ((deps.pinnedStk || pinnedStk)(d) !== g.stk) {
      delete map[d];
      continue;
    }
    try {
      await postGrant(d, { issuedAt: g.issuedAt, signature: g.signature }, deps);
      delete map[d];
    } catch { /* still not reachable */ }
  }
  writePending(map);
}

export function pendingWildcardGrant(serverDomain) {
  return readPending()[String(serverDomain).toLowerCase()] ?? null;
}

/**
 * Grant upkeep: an admin device whose session is unlocked asks the server whether it holds a grant
 * and, on `granted: false`, signs one silently. Needs a pin (the grant names the pinned key).
 */
export async function upkeepWildcardGrant(serverDomain, deps = {}) {
  const session = deps.session ?? getSession();
  if (!session?.umk || !signsWildcardGrant(deps)) return { checked: false };
  const d = String(serverDomain).toLowerCase();
  if (!(deps.pinnedStk || pinnedStk)(d)) return { checked: false };
  const send = deps.screensFetchForPod || screensFetchForPod;
  let state;
  try {
    state = await send(d, WILDCARD_GRANT_PATH);
  } catch {
    return { checked: false };
  }
  if (state?.granted !== false) return { checked: true, granted: !!state?.granted };
  const r = await grantAppNames(d, deps);
  return { checked: true, granted: false, sent: r.sent };
}
