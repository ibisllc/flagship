// "Choose your own account name" at sign-up (owner decision 2026-11-23).
//
// `.com` has no free choice of name at sign-up: an account opens under a name it suggested. So the webapp opens the
// account under the suggested name as always, then at once runs the paid rename (`POST /api/account/name-change`,
// packages/control-plane/src/nameChange.ts) to the name the person chose, paid with a name code or with ten $1
// vouchers bought by card. To the person it looks like naming the account before it exists. `.com`'s rename moves
// the account's rows and its names-registry entry (a sign-up rename releases the suggested name at once); what it
// can't move is anything signed over the old name, so this device then:
//   1. keeps its device key (derived from the old name) as a stored key under the new name;
//   2. mints its device grant again under the new name (admin root) and revokes the old one (IRK);
//   3. puts the account profile and its own device profile again, encrypted and signed for the new name;
//   4. moves this browser's copy of the account (keys, profile records) to the new name, and mints a read token.
// Only after that may the admin root's quantum-safe binding run (adminSigning.js waits while a choice is pending:
// a binding under the suggested name would make `.com` refuse the rename) and the voi.ci intro show.
//
// A small record (`flagship.nameChoice.v1`) survives a reload, a crash and the trip to Stripe's page, so the choice
// is finished (or dropped, keeping the suggested name) at the next unlock. Nothing paid is lost: `.com` puts a code
// or the vouchers back when the rename fails, and bought vouchers stay in the account's wallet.

import { controlApex } from "./apex.js";
import { canonicalNameChangeBytes } from "./nameChange.js";
import { nameProblemText, nameTakenText, voiciNameProblem } from "./nameRules.js";
import { tr } from "./i18n.js";

export const NAME_PACK_UNITS = 10;
export const NAME_CHOICE_KEY = "flagship.nameChoice.v1";
const SCOPES = ["browse", "install-service", "vibe-code", "add-device", "manage-services", "revoke-others", "admin", "view-directory"];

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const enc = (parts) => new TextEncoder().encode(parts.join("|"));

// ── the pending record ───────────────────────────────────────────────────────

function store(storage) {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The pending choice `{suggested, wanted, method, stage, deviceId, oldGrantId}`, or null. */
export function loadNameChoice(storage) {
  try {
    const v = JSON.parse(store(storage)?.getItem(NAME_CHOICE_KEY) ?? "null");
    return v && typeof v.suggested === "string" && typeof v.wanted === "string" ? v : null;
  } catch {
    return null;
  }
}

export function saveNameChoice(rec, storage) {
  try {
    // A name code is a bearer secret: it stays in memory, never in storage.
    const { code: _code, ...kept } = rec;
    store(storage)?.setItem(NAME_CHOICE_KEY, JSON.stringify(kept));
  } catch {
    /* storage blocked: the choice then lives only for this page */
  }
  return rec;
}

export function clearNameChoice(storage) {
  try {
    store(storage)?.removeItem(NAME_CHOICE_KEY);
  } catch {
    /* nothing kept */
  }
}

/** True while a choice for `username` (either name) is not finished: nothing may bind its keys to that name yet. */
export function nameChoicePendingFor(username, storage) {
  const p = loadNameChoice(storage);
  const u = String(username ?? "").toLowerCase();
  return !!p && !!u && (p.suggested === u || p.wanted === u);
}

// ── a name set aside by the owner (packages/control-plane/src/nameGrant.ts) ──

export const NAME_GRANT_KEY = "flagship.nameGrant.v1";
export const NAME_GRANT_PATH = "/app/choose-name";

/** `https://<apex>/app/choose-name#n=<name>&g=<code>&e=<expiresAt>[&f=1]` → `{name, code, expiresAt, paid}`, or null. */
export function parseNameGrantLink(href) {
  try {
    const u = new URL(href);
    if (u.pathname.replace(/\/+$/, "") !== NAME_GRANT_PATH) return null;
    const f = new URLSearchParams(u.hash.replace(/^#/, ""));
    const name = String(f.get("n") ?? "").trim().toLowerCase();
    const code = String(f.get("g") ?? "").trim();
    const expiresAt = Number(f.get("e"));
    if (!name || voiciNameProblem(name) || !code || !Number.isSafeInteger(expiresAt)) return null;
    return { name, code, expiresAt, paid: f.get("f") === "1" };
  } catch {
    return null;
  }
}

/** On load: keep a grant link for after the sign-up or unlock (this tab only) and take it off the address bar. */
export function stashNameGrantFromLocation(loc = globalThis.location, hist = globalThis.history, session = globalThis.sessionStorage) {
  const g = parseNameGrantLink(loc?.href ?? "");
  if (!g) return null;
  try {
    session?.setItem(NAME_GRANT_KEY, JSON.stringify(g));
    hist?.replaceState({}, "", "/");
  } catch {
    /* storage blocked: the link can be opened again */
  }
  return g;
}

export function peekNameGrant(session = globalThis.sessionStorage) {
  try {
    const g = JSON.parse(session?.getItem(NAME_GRANT_KEY) ?? "null");
    return g && typeof g.name === "string" && typeof g.code === "string" && typeof g.expiresAt === "number" ? g : null;
  } catch {
    return null;
  }
}

export function forgetNameGrant(session = globalThis.sessionStorage) {
  try {
    session?.removeItem(NAME_GRANT_KEY);
  } catch {
    /* nothing kept */
  }
}

const grantWire = (g) => (g ? { nameGrant: { code: g.code, expiresAt: g.expiresAt } } : {});

// ── sentences ───────────────────────────────────────────────────────────────

/** The sentence for a typed name that can't be one, or null (the local check; `.com` has the last word). */
export function localNameProblem(raw) {
  const p = voiciNameProblem(String(raw ?? "").trim());
  return p ? nameProblemText(p) : null;
}

function heldDate(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * The sentence for a refusal of the chosen name or its payment. `kept` is the name the account keeps; `paidWith` is
 * "vouchers" or "code" once something was paid (it is not lost: say so).
 */
export function nameChoiceRefusalText(body, { wanted = "", kept = "", paidWith = null, existing = false } = {}) {
  const code = body?.code ?? "";
  if (existing && ["rename-unavailable", "has-servers", "cooldown", "demo", "other-devices"].includes(code)) {
    return tr("Open this link when you create your account.");
  }
  switch (code) {
    case "grant-expired":
      return tr("This link has expired. Ask for a new one.");
    case "grant-invalid":
    case "grant-used":
      return tr("This link doesn't work any more. Ask for a new one.");
    case "invalid":
      return nameProblemText(body?.problem);
    case "taken":
    case "offered":
    case "same-name":
      return nameTakenText();
    case "dibs-held":
    case "dibs-used":
      return typeof body?.heldUntil === "number"
        ? tr("This name is held for the owner of {0}.com until {1}.", wanted, heldDate(body.heldUntil))
        : nameTakenText();
    case "code-invalid":
    case "code-wrong-kind":
    case "code-needs-dibs":
      return tr("That voucher code isn't valid for an account name.");
    case "code-used":
      return tr("That voucher code was already used.");
    case "cancelled":
      return tr("Payment cancelled. Your account keeps the name {0}.", kept);
    case "pay-failed":
      return tr("The payment didn't go through. Your account keeps the name {0}.", kept);
    default:
      return paidWith === "vouchers"
        ? tr("The name change didn't go through. Your account keeps the name {0}, and your $10 stays in your account as vouchers.", kept)
        : tr("The name change didn't go through. Your account keeps the name {0}, and your voucher code still works.", kept);
  }
}

/** The grant this choice carries, only while it is for the chosen name (it opens nothing else). */
function grantFor(rec) {
  return rec.grant && rec.grant.name === rec.wanted ? rec.grant : null;
}

/** Refusals the person can fix on the same screen (another name, another code); the rest end the choice. */
export function isFixableRefusal(code) {
  return ["invalid", "taken", "offered", "same-name", "dibs-held", "dibs-used", "code-invalid", "code-wrong-kind", "code-needs-dibs", "code-used"].includes(code);
}

// ── .com ────────────────────────────────────────────────────────────────────

async function json(r) {
  return r.json().catch(() => ({}));
}

/** `POST /api/account/name-change/quote` (public; the account must exist). */
export async function quoteName(oldName, newName, io, grant = null) {
  const r = await io.fetch(`${io.apex ?? controlApex()}/api/account/name-change/quote`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: oldName, newUsername: newName, ...grantWire(grant) }),
  });
  const body = await json(r);
  if (!r.ok) return { available: false, code: body?.code ?? "rename-failed" };
  return body;
}

/** `POST /api/account/name-change`, signed by the admin root, paid by `{voucherCode}` or `{vouchers}`. */
export async function renameOnCom({ aidPubHex, oldName, newName, payment, grant = null }, io) {
  const request = { aidPubHex: aidPubHex.toLowerCase(), oldUsername: oldName, newUsername: newName, issuedAt: io.now() };
  const signature = hex(await io.signAdmin(canonicalNameChangeBytes(request)));
  const r = await io.fetch(`${io.apex ?? controlApex()}/api/account/name-change`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request, signature, ...payment, ...grantWire(grant) }),
  });
  const body = await json(r);
  return r.ok ? { ok: true, body } : { ok: false, status: r.status, body };
}

/** The founding device's grant canonical bytes (openAccount.js signs the same shape). */
export function canonicalGrantBytes(g) {
  return enc(["flagship/device-capability-grant/v2", g.grantId, g.username, g.deviceId, g.devicePubHex, g.scopes.join(","), g.issuedAt, g.expiresAt]);
}

export function canonicalGrantRevokeBytes(r) {
  return enc(["flagship/revoke-device-capability-grant/v1", r.grantId, r.username, r.reason, r.issuedAt]);
}

/**
 * Everything `.com`'s rename leaves signed over the old name, done again for the new one (header, steps 1 to 4).
 * Safe to run twice (a resume after a crash): the key is stored again, a second grant is harmless, a revoked grant
 * stays revoked, and a profile already readable under the new name is left alone.
 */
export async function settleRenamedAccount({ oldName, newName, deviceId, oldGrantId, oldGrantIds = [] }, io) {
  const umk = io.session.umk;
  // 1. The key `.com` registered was derived from the old name.
  const seed = await io.deriveAccountDeviceSeed(umk, oldName, deviceId);
  await io.persistAccountDeviceSeed(umk, newName, deviceId, seed);
  const deviceKey = await io.deriveAccountDeviceKey(umk, newName, deviceId);
  const apex = io.apex ?? controlApex();
  // 2. A grant that verifies under the new name, then the old one revoked (.com's admin check takes the first grant
  //    it finds for the device key, so the broken one must not stay).
  const issuedAt = io.now();
  const grant = {
    grantId: io.randomUUID(),
    username: newName,
    deviceId,
    devicePubHex: hex(deviceKey.publicKey),
    scopes: SCOPES,
    issuedAt,
    expiresAt: issuedAt + 90 * 24 * 3_600_000,
  };
  const minted = await io.fetch(`${apex}/api/users/${encodeURIComponent(newName)}/device-grants`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant: { grantId: grant.grantId, username: newName, deviceId, devicePubKey: grant.devicePubHex, scopes: SCOPES, issuedAt, expiresAt: grant.expiresAt },
      signature: hex(await io.signAdmin(canonicalGrantBytes(grant))),
    }),
  });
  if (!minted.ok) throw new Error(`device grant (${minted.status})`);
  for (const id of [...new Set([oldGrantId, ...oldGrantIds].filter(Boolean))]) {
    const revoke = { grantId: id, username: newName, reason: "replaced", issuedAt: io.now() };
    const r = await io.fetch(`${apex}/api/users/${encodeURIComponent(newName)}/device-grants/revoke`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: revoke, signature: hex(await io.signIrk(canonicalGrantRevokeBytes(revoke))) }),
    });
    if (!r.ok && r.status !== 404) throw new Error(`grant revoke (${r.status})`);
  }
  // 3. The two profiles, readable and signed under the new name.
  const profile = { accountId: newName, deviceId };
  await io.reputProfiles({ oldName, newName, profile });
  // 4. This browser's copy, and a read token for the new name.
  await io.moveLocalAccount(oldName, newName);
  await io.mintReadToken(newName);
}

// ── the whole choice ────────────────────────────────────────────────────────

/**
 * Finishes (or starts paying for) the choice in `rec` for the account opened as `rec.suggested`. Returns one of
 * `{ok:true, name}`, `{ok:false, refusal, fixable}` (the account keeps `rec.suggested`), or `{redirected:true}` (off
 * to Stripe; the choice resumes after the unlock).
 */
export async function claimChosenName(rec, io) {
  const kept = rec.suggested;
  const fail = (body, paidWith = null) => {
    const code = body?.code ?? "rename-failed";
    const fixable = isFixableRefusal(code);
    if (!fixable) clearNameChoice(io.storage);
    return { ok: false, code, fixable, refusal: nameChoiceRefusalText(body, { wanted: rec.wanted, kept, paidWith, existing: rec.existing === true }) };
  };
  saveNameChoice(rec, io.storage);

  if (rec.stage !== "paying") {
    const q = await quoteName(kept, rec.wanted, io, grantFor(rec));
    if (!q.available) return fail(q);
  }

  let payment;
  let vouchers = null;
  if (grantFor(rec)?.paid) {
    payment = {};
  } else if (rec.method === "code") {
    payment = { voucherCode: rec.code };
  } else if (rec.stage === "paying") {
    const back = io.consumeShopReturn();
    if (back === "cancel") {
      clearNameChoice(io.storage);
      return { ok: false, code: "cancelled", fixable: false, refusal: nameChoiceRefusalText({ code: "cancelled" }, { kept }) };
    }
    await io.finishShopOrders();
    vouchers = await io.takeVouchers(NAME_PACK_UNITS);
    if (vouchers.length < NAME_PACK_UNITS) {
      // Not paid (yet): Stripe can take a moment. The choice waits for the next unlock (a day at most, as the order).
      return { ok: false, code: "payment-pending", fixable: false, pending: true, refusal: null };
    }
    payment = { vouchers };
  } else {
    // Pay $10: the ten-voucher pack by card; the choice resumes when Stripe sends the person back.
    saveNameChoice({ ...rec, stage: "paying" }, io.storage);
    let url;
    try {
      ({ url } = await io.buyPack(NAME_PACK_UNITS));
    } catch {
      clearNameChoice(io.storage);
      return { ok: false, code: "pay-failed", fixable: false, refusal: nameChoiceRefusalText({ code: "pay-failed" }, { kept }) };
    }
    io.navigate(url);
    return { redirected: true };
  }

  saveNameChoice({ ...rec, stage: "renaming" }, io.storage);
  const r = await renameOnCom({ aidPubHex: io.aidPubHex, oldName: kept, newName: rec.wanted, payment, grant: grantFor(rec) }, io);
  if (!r.ok) {
    if (vouchers && r.body?.code === "voucher-spent" && Array.isArray(r.body.spent)) await io.dropSpentVouchers(r.body.spent);
    return fail(r.body, vouchers ? "vouchers" : "code");
  }
  saveNameChoice({ ...rec, stage: "settling" }, io.storage);
  await settleRenamedAccount({ oldName: kept, newName: rec.wanted, deviceId: rec.deviceId, oldGrantId: rec.oldGrantId, oldGrantIds: rec.oldGrantIds }, io);
  if (vouchers) await io.dropSpentVouchers(vouchers.map((v) => io.voucherNullifier(v)));
  clearNameChoice(io.storage);
  return { ok: true, name: rec.wanted };
}

/**
 * After an unlock: a choice this browser left unfinished for the signed-in account. Paying resumes; a rename `.com`
 * already made is settled (`GET /api/username/<wanted>` names this account's key); anything else is dropped and the
 * account keeps its suggested name. Returns what {@link claimChosenName} returns, or null when there is nothing.
 */
export async function resumeNameChoice(io) {
  const rec = loadNameChoice(io.storage);
  const u = String(io.session?.username ?? "").toLowerCase();
  if (!rec || !u) return null;
  if (u === rec.wanted) {
    clearNameChoice(io.storage);
    return null;
  }
  if (u !== rec.suggested) return null;
  if (rec.stage === "paying") return claimChosenName(rec, io);
  if (rec.stage === "renaming" || rec.stage === "settling") {
    const r = await io.fetch(`${io.apex ?? controlApex()}/api/username/${encodeURIComponent(rec.wanted)}`, { cache: "no-store" });
    const body = r.ok ? await json(r) : null;
    if (body?.irkPub && String(body.irkPub).toLowerCase() === io.irkPubHex.toLowerCase()) {
      await settleRenamedAccount({ oldName: rec.suggested, newName: rec.wanted, deviceId: rec.deviceId, oldGrantId: rec.oldGrantId, oldGrantIds: rec.oldGrantIds }, io);
      clearNameChoice(io.storage);
      return { ok: true, name: rec.wanted };
    }
  }
  clearNameChoice(io.storage);
  return null;
}
