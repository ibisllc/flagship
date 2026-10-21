// "Update this server" — webapp client of the phone-ordered, dual-signed
// in-place server update (docs/server-update-mechanism.md).
//
// This is the AUTHORIZATION half of the 2-of-2 gate: an admin device signs a
// `flagship/server-update/v1` UpdateOrder naming THIS box + the target commit,
// and deposits it on `.com`'s update lane. The AUTHENTICITY half (the target
// commit is maintainer-ENDORSED) is enforced box-side by the daemon's
// ReleaseGate — there is no maintainer envelope here, and neither half alone
// can push code.
//
// TWO KEYS in the deposit body (like the transfer deposits, NOT the sealed lanes):
//   - the ORDER signature routes through the tag-gated sensitive signer
//     (`flagship/server-update/v1` ∈ SENSITIVE_TAGS) — the admin master root
//     when the account has one, legacy owner IRK otherwise;
//   - the co-signed mailbox AUTH (`device-endpoint-claim`) stays the
//     membership IRK the deposit lane requires (the same gated signer
//     tag-routes it to the legacy key).
//
// Canonical bytes are built byte-identical to @flagship/protocol's
// `canonicalUpdateOrder`:
//   flagship/server-update/v1|serverDomain|targetCommit|fromCommit|nonce|issuedAt

import { controlApex } from "./apex.js";

import { tr } from "./i18n.js";
// ---- Canonical-bytes tag — MUST match @flagship/protocol ----
export const TAG_SERVER_UPDATE = "flagship/server-update/v1";

/** A full lowercase git commit SHA — the only targetCommit form this phase
 *  accepts from the UI (the maintainer-endorsement check is box-side). */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function err(message, status) {
  const e = new Error(message);
  if (status != null) e.status = status;
  return e;
}

function randHex(n, getRandom) {
  const b = new Uint8Array(n);
  (getRandom || ((x) => crypto.getRandomValues(x)))(b);
  return defaultBytesToHex(b);
}

/** Mirror of @flagship/protocol legacyFieldGuard — reject '|' + control chars
 *  in every string field so the canonical bytes can never be ambiguous. */
function fieldGuard(name, value) {
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) {
      throw err(`field "${name}" contains a reserved canonical-bytes char`, 400);
    }
  }
  return s;
}

/**
 * UpdateOrder canonical bytes, byte-identical to @flagship/protocol
 * `canonicalUpdateOrder`. All fields verbatim (no case-folding — commits are
 * matched exactly by the box); issuedAt stringified by join.
 *
 * @param {{ serverDomain: string, targetCommit: string, fromCommit: string,
 *           nonce: string, issuedAt: number }} order
 */
export function canonicalUpdateOrderBytes(order) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_UPDATE,
      fieldGuard("serverDomain", order.serverDomain),
      fieldGuard("targetCommit", order.targetCommit),
      fieldGuard("fromCommit", order.fromCommit),
      fieldGuard("nonce", order.nonce),
      String(order.issuedAt),
    ].join("|"),
  );
}

/** DeviceEndpointClaim mailbox-auth canonical bytes (username verbatim —
 *  matches @flagship/protocol canonicalDeviceEndpointClaim). */
function canonicalMailboxAuthBytes({ username, endpointLabel, phoneIrkPubHex, issuedAt, expiresAt, nonceHex }) {
  return new TextEncoder().encode(
    [
      "flagship/device-endpoint-claim/v1",
      username,
      endpointLabel,
      String(phoneIrkPubHex).toLowerCase(),
      issuedAt,
      expiresAt,
      String(nonceHex).toLowerCase(),
    ].join("|"),
  );
}

/**
 * Build, sign and deposit the admin-authorized UpdateOrder on `.com`'s update
 * lane (POST /api/server/:domain/update). The box claims it on its heartbeat,
 * re-verifies it under the pinned admin authority AND separately confirms the
 * target commit is maintainer-endorsed before applying — a deposit alone never
 * updates anything.
 *
 * issuedAt is minted HERE at send time — `.com` enforces freshness on both the
 * auth wrapper and the order.
 *
 * @param {object} args
 * @param {string} args.serverDomain   the box FQDN this order names
 * @param {string} args.targetCommit   the blessed commit to move to (40-hex)
 * @param {string} args.fromCommit     the box-reported CURRENT commit (40-hex)
 * @param {string} args.username       the owner account name
 * @param {Uint8Array} args.umk        session UMK (for signing)
 * @param {string} args.irkPubHex      the owner's membership IRK pubkey, hex
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 *   the tag-gated sensitive signer (sensitiveSigner()) — routes the order to
 *   the admin root when present, keeps the mailbox auth on the IRK
 * @param {{ fetch?: typeof fetch, comBase?: string, now?: () => number,
 *           getRandomValues?: Function, bytesToHex?: Function }} [deps]
 * @returns {Promise<{ ok: true, order: object, expiresAt?: number }>}
 */
export async function depositUpdateOrder(args, deps = {}) {
  const { serverDomain, targetCommit, fromCommit, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!username) throw err("username required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!irkPubHex) throw err("irkPubHex required", 400);
  if (!COMMIT_SHA_RE.test(String(targetCommit))) {
    throw err("targetCommit must be a full lowercase 40-hex commit", 400);
  }
  if (!COMMIT_SHA_RE.test(String(fromCommit))) {
    throw err("this server hasn't reported its current version yet", 400);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const comBase = deps.comBase || controlApex();
  const now = (deps.now || Date.now)();

  const order = {
    serverDomain: String(serverDomain),
    targetCommit: String(targetCommit),
    fromCommit: String(fromCommit),
    nonce: randHex(32, deps.getRandomValues),
    issuedAt: now,
  };
  const orderSig = await signWithIrk(umk, canonicalUpdateOrderBytes(order));

  // IRK mailbox-auth — same shape as the transfer deposits. The
  // gated signer tag-routes device-endpoint-claim to the membership IRK.
  const authNonceHex = randHex(32, deps.getRandomValues);
  const auth = {
    username,
    endpointLabel: "webapp",
    phoneIrkPub: String(irkPubHex).toLowerCase(),
    issuedAt: now,
    expiresAt: now + 120_000,
    nonce: authNonceHex,
  };
  const authSig = await signWithIrk(
    umk,
    canonicalMailboxAuthBytes({
      username,
      endpointLabel: auth.endpointLabel,
      phoneIrkPubHex: auth.phoneIrkPub,
      issuedAt: now,
      expiresAt: auth.expiresAt,
      nonceHex: authNonceHex,
    }),
  );

  const body = {
    auth,
    authSignature: toHex(authSig),
    deposit: {
      serverDomain: order.serverDomain,
      requestNonceHex: randHex(32, deps.getRandomValues),
    },
    order,
    signature: toHex(orderSig),
  };
  let resp;
  try {
    resp = await f(`${comBase}/api/server/${encodeURIComponent(order.serverDomain)}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((out && out.error) || `HTTP ${resp.status}`, resp.status);
  return { ok: true, order, expiresAt: out.expiresAt };
}

const REFUSAL_COPY = {
  unendorsed: tr("Flagship's maintainers haven't endorsed that release."),
  "from-commit-mismatch":
    "the server was no longer on the version the update was made for. Send it again.",
  "apply-failed": "it couldn't download or build the new version. Nothing changed.",
  rejected: "the request wasn't signed by this account's admin key.",
  stale: "the request was too old. Send it again.",
  "wrong-domain": "the request was for a different server.",
};

/**
 * One sentence for the box-reported `lastUpdate` verdict (server-detail), or
 * null when there is nothing to say (no update yet, or an older daemon).
 */
export function describeLastUpdate(lastUpdate) {
  if (!lastUpdate || typeof lastUpdate !== "object") return null;
  const short = (sha) => (COMMIT_SHA_RE.test(String(sha)) ? String(sha).slice(0, 8) : null);
  const target = short(lastUpdate.targetCommit);
  const previous = short(lastUpdate.previousCommit);
  if (lastUpdate.outcome === "applied") {
    return target ? tr("Last update: {0} installed and running.", target) : tr("Last update installed and running.");
  }
  if (lastUpdate.outcome === "rolled-back") {
    const to = target ? ` to ${target}` : "";
    const back = previous ? ` to ${previous}` : "";
    return tr("The last update{0} didn't start cleanly, so the server went back{1} on its own.", to, back);
  }
  if (lastUpdate.outcome === "refused") {
    const why = REFUSAL_COPY[lastUpdate.reason];
    return why ? tr("The server refused the last update: {0}", why) : tr("The server refused the last update.");
  }
  return null;
}

export const DOWNGRADE_WARNING =
  tr("Older releases don't have the fixes made since, and may not understand changes made to this server after them, such as a rotated admin key. In the worst case the server stops accepting updates and has to be reinstalled. Only go back if a newer release broke something.");

/** GET /api/screens/updates path (the box's own verified release list). */
export function releaseCatalogPath(refresh = false) {
  return refresh ? "/api/screens/updates?refresh=1" : "/api/screens/updates";
}

/**
 * The releases a box can move to. A box lists and verifies them itself; one
 * from before that answers 404, and then flagshipserver.com lists the endorsed
 * releases for its commit instead. That only decides what is offered: the box
 * still checks the endorsement before it applies an order.
 *
 * @param {{ fetchBox: (path: string) => Promise<object>, currentCommit: string,
 *           refresh?: boolean, fetch?: typeof fetch, comBase?: string }} args
 */
export async function loadReleaseCatalog({ fetchBox, currentCommit, refresh = false, fetch: f = fetch, comBase }) {
  try {
    return await fetchBox(releaseCatalogPath(refresh));
  } catch (e) {
    if (e?.status !== 404 || !COMMIT_SHA_RE.test(String(currentCommit))) throw e;
  }
  const q = `current=${encodeURIComponent(currentCommit)}${refresh ? "&refresh=1" : ""}`;
  const resp = await f(`${comBase || controlApex()}/api/releases?${q}`);
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((out && out.error) || `HTTP ${resp.status}`, resp.status);
  return out;
}

/**
 * The update dialog's view of the box's release list: the latest newer
 * release, the other newer ones, the older ones (Advanced only) and the tag of
 * the running release. Entries without a full commit are dropped, since an
 * order must name one exact commit.
 */
export function groupReleases(catalog) {
  const valid = (r) => r && typeof r === "object" && COMMIT_SHA_RE.test(String(r.commit));
  const releases = Array.isArray(catalog?.releases) ? catalog.releases.filter(valid) : [];
  const latest = valid(catalog?.latest) ? catalog.latest : null;
  return {
    latest,
    currentTag: releases.find((r) => r.relation === "current")?.tag ?? null,
    otherNewer: releases.filter((r) => r.relation === "newer" && r.commit !== latest?.commit),
    older: releases.filter((r) => r.relation === "older"),
    stale: catalog?.stale === true,
  };
}

// ---- The order this device sent and is waiting on ----------------------
//
// The box takes up to about five minutes to pick an order up, so a sent order
// is remembered per server (this device only) until server-detail shows its
// outcome. Without it, closing the sheet forgot the order and the page offered
// the button again, inviting a duplicate that does nothing.

export const PENDING_UPDATE_STALE_MS = 30 * 60_000;
export const PENDING_UPDATE_POLL_MS = 15_000;
const PENDING_UPDATE_KEY_PREFIX = "flagship.pendingUpdate.v1:";

export function pendingUpdateKey(serverFqdn) {
  return PENDING_UPDATE_KEY_PREFIX + String(serverFqdn).toLowerCase();
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parsePendingUpdate(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!COMMIT_SHA_RE.test(String(raw.targetCommit)) || !COMMIT_SHA_RE.test(String(raw.fromCommit))) return null;
  if (typeof raw.orderedAt !== "number" || !Number.isFinite(raw.orderedAt)) return null;
  const out = { targetCommit: raw.targetCommit, fromCommit: raw.fromCommit, orderedAt: raw.orderedAt };
  if (typeof raw.targetTag === "string" && raw.targetTag) out.targetTag = raw.targetTag;
  return out;
}

/** Remember a sent order. Returns false when storage is unavailable. */
export function savePendingUpdate(serverFqdn, pending, storage = defaultStorage()) {
  const entry = parsePendingUpdate(pending);
  if (!entry || !storage) return false;
  try {
    storage.setItem(pendingUpdateKey(serverFqdn), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * Deposit the order and, once `.com` accepted it, remember it as this server's
 * pending update. A failed deposit leaves nothing behind.
 *
 * @param {Parameters<typeof depositUpdateOrder>[0]} args
 * @param {{ targetTag?: string, storage?: Storage | null, deps?: object }} [opts]
 */
export async function orderServerUpdate(args, { targetTag, storage = defaultStorage(), deps } = {}) {
  const sent = await depositUpdateOrder(args, deps);
  const pending = {
    targetCommit: sent.order.targetCommit,
    fromCommit: sent.order.fromCommit,
    orderedAt: sent.order.issuedAt,
    ...(targetTag ? { targetTag } : {}),
  };
  savePendingUpdate(args.serverDomain, pending, storage);
  return { ...sent, pending };
}

export function readPendingUpdate(serverFqdn, storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingUpdateKey(serverFqdn));
    return raw ? parsePendingUpdate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearPendingUpdate(serverFqdn, storage = defaultStorage()) {
  try {
    storage?.removeItem(pendingUpdateKey(serverFqdn));
  } catch {}
}

/**
 * Whether server-detail shows the outcome of the pending order: the box runs
 * the target, or it recorded a verdict for that target (applied / rolled back)
 * since the order was sent. A refusal is recorded without a target (the box
 * may refuse before decoding the order), so any refusal since then counts.
 * A box too old to report `lastUpdate` settles on its current commit only.
 */
export function pendingUpdateSettled(pending, detail) {
  if (!pending) return true;
  if (detail?.currentCommit === pending.targetCommit) return true;
  const last = detail?.lastUpdate;
  if (!last || typeof last !== "object" || typeof last.at !== "number" || last.at < pending.orderedAt) {
    return false;
  }
  if (last.targetCommit === pending.targetCommit) return true;
  return last.outcome === "refused" && !last.targetCommit;
}

/** The stored order for this server if it is still unsettled; a settled one
 *  is cleared. */
export function reconcilePendingUpdate(serverFqdn, detail, storage = defaultStorage()) {
  const pending = readPendingUpdate(serverFqdn, storage);
  if (!pending) return null;
  if (pendingUpdateSettled(pending, detail)) {
    clearPendingUpdate(serverFqdn, storage);
    return null;
  }
  return pending;
}

export function isPendingUpdateStale(pending, now = Date.now()) {
  return !!pending && now - pending.orderedAt >= PENDING_UPDATE_STALE_MS;
}

/**
 * The pending order's block for the update card and the update sheet.
 *
 * @param {{ targetCommit: string, targetTag?: string, orderedAt: number }} pending
 * @param {{ now?: number, formatWhen: (ms: number, now: number) => string,
 *           escapeHtml: (s: string) => string }} deps
 */
export function renderPendingUpdate(pending, { now = Date.now(), formatWhen, escapeHtml }) {
  const name = pending.targetTag || String(pending.targetCommit).slice(0, 8);
  const sent = tr("Update to {0} sent {1}.", name, formatWhen(pending.orderedAt, now));
  if (isPendingUpdateStale(pending, now)) {
    return `
      <div data-update-pending="stale">
        <p class="note">${tr("{0} The server hasn't applied this update yet. It may be offline.", escapeHtml(sent))}</p>
        <div class="row-2 mt-2">
          <button class="secondary" data-update-send-again>${tr("Send again")}</button>
          <button class="secondary" data-update-forget>${tr("Forget it")}</button>
        </div>
      </div>`;
  }
  return `
      <div class="update-pending" data-update-pending="sent" role="status">
        <span class="update-pending-spinner" aria-hidden="true"></span>
        <p class="note">${tr("{0} The server picks it up within about five minutes, restarts, and goes back on its own if the new version doesn't start.", escapeHtml(sent))}</p>
      </div>`;
}
