// Maintainer-trust verify — the browser-JS port of @ibisllc/maintainers'
// pin → verifyMandateChainFromPin → currentAuthority → authorizedCaKeys, plus
// the Flagship blessing check (verifyComBlessing).
//
// WHY this exists (docs/maintainer-trust-enforcement.md): the whole
// maintainer→CA authority chain is built but nothing at the edges verifies it.
// This is the webapp's verifier: it decides whether the `.com` control server
// it is about to talk to actually holds a CA key authorized, RIGHT NOW, by the
// pinned maintainer mandate. If it does not, the app halts all backend calls
// (lib/serverTrust.js) until the owner grants a signed override.
//
// PORT FIDELITY: the canonical-bytes layout, the forward-chain walk, the
// CaEndorsement lease semantics (judged at the VERIFIER'S clock, ±5min skew),
// and the fail-closed behaviour are ported faithfully from
//   maintainers/packages/protocol/src/{canonical,verifier,caEndorsement}.ts
// (the v2 LOCKED model). It is pinned by cross-platform vectors generated from
// the real package (apps/web/tests/fixtures/maintainerTrust.webapp.vectors.json).
//
// CRYPTO: Ed25519 verify uses WebCrypto subtle. This app already hard-depends
// on WebCrypto X25519 (lib/leases.js — Chrome 130+/Safari 17+/Firefox 130+);
// every browser with X25519 also ships Ed25519, so WebCrypto is the correct
// baseline and no JS-vendored fallback is needed. SHA-256 uses
// crypto.subtle.digest. Everything is async because pin-hashing the mandate
// log is async under WebCrypto.

const SEP = "|";
const TAG_PREFIX = "maintainers";

// ±5 min window-edge tolerance (maintainers caEndorsement.ts DEFAULT_CLOCK_SKEW_MS).
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/* ---------- hex + bytes ---------- */

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex char");
    out[i] = b;
  }
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

/* ---------- Ed25519 verify (WebCrypto subtle) ---------- */

/** Verify an Ed25519 signature (all hex inputs). Never throws → false. */
export async function edVerify(sigHex, msg, pubHex) {
  if (
    typeof sigHex !== "string" ||
    typeof pubHex !== "string" ||
    sigHex.length !== 128 ||
    pubHex.length !== 64
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(pubHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(sigHex), msg);
  } catch {
    return false;
  }
}

/* ---------- SHA-256 ---------- */

async function sha256Hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(h);
}

/* ---------- canonical bytes (port of canonical.ts) ---------- */

class CanonicalError extends Error {}

function validateField(name, value) {
  if (typeof value !== "string") throw new CanonicalError(`${name} must be a string`);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x7c) throw new CanonicalError(`${name} contains '|'`);
    if (c <= 0x1f || c === 0x7f) throw new CanonicalError(`${name} contains control char`);
  }
}

function validateNoComma(name, value) {
  validateField(name, value);
  if (value.indexOf(",") !== -1) throw new CanonicalError(`${name} contains ','`);
}

function validateHex(name, value, length) {
  if (typeof value !== "string") throw new CanonicalError(`${name} must be a string`);
  if (value.length !== length) {
    throw new CanonicalError(`${name} must be exactly ${length} hex chars`);
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
    if (!ok) throw new CanonicalError(`${name} must be lower-case hex`);
  }
}

function canonicalUint(name, n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new CanonicalError(`${name} must be a non-negative safe integer`);
  }
  return String(n);
}

function encode(parts) {
  return new TextEncoder().encode(parts.join(SEP));
}

/**
 * Mandate canonical bytes. Tag: maintainers/mandate/v1
 * Order: mandateId|track|holder|issuedAt|expiresAt|successors(,)|
 *        approvalThreshold|minSuccessors|maxDurationSeconds|
 *        defaultDurationSeconds|projectName|projectContact|projectHomepage|
 *        projectTracks(,)|signedBy
 */
export function canonicalMandate(m) {
  if (!m || m.kind !== "Mandate" || m.version !== 1) {
    throw new CanonicalError("not a Mandate envelope");
  }
  validateField("mandateId", m.mandateId);
  validateField("track", m.track);
  validateHex("holder", m.holder, 64);
  validateField("issuedAt", m.issuedAt);
  validateField("expiresAt", m.expiresAt);
  if (!Array.isArray(m.successors)) throw new CanonicalError("successors must be an array");
  for (const s of m.successors) validateHex("successor", s, 64);
  if (!m.approvalRule || m.approvalRule.kind !== "threshold") {
    throw new CanonicalError('approvalRule.kind must be "threshold"');
  }
  const threshold = canonicalUint("approvalRule.threshold", m.approvalRule.threshold);
  const minSucc = canonicalUint("minSuccessors", m.minSuccessors);
  const maxDur = canonicalUint("maxDurationSeconds", m.maxDurationSeconds);
  const defDur = canonicalUint("defaultDurationSeconds", m.defaultDurationSeconds);
  const p = m.project;
  const projName = p?.name ?? "";
  const projContact = p?.contact ?? "";
  const projHome = p?.homepage ?? "";
  const projTracks = p?.tracks ?? [];
  validateField("project.name", projName);
  validateField("project.contact", projContact);
  validateField("project.homepage", projHome);
  if (!Array.isArray(projTracks)) throw new CanonicalError("project.tracks must be an array");
  for (const t of projTracks) validateNoComma("project.track", t);
  validateHex("signedBy", m.signedBy, 64);
  return encode([
    `${TAG_PREFIX}/mandate/v1`,
    m.mandateId,
    m.track,
    m.holder,
    m.issuedAt,
    m.expiresAt,
    m.successors.join(","),
    threshold,
    minSucc,
    maxDur,
    defDur,
    projName,
    projContact,
    projHome,
    projTracks.join(","),
    m.signedBy,
  ]);
}

/**
 * CaEndorsement canonical bytes. Tag: maintainers/ca-endorsement/v1
 * Order: endorsementId|track|caPubkey|scope|notBefore|notAfter|issuedAt|signedBy
 */
export function canonicalCaEndorsement(e) {
  validateField("endorsementId", e.endorsementId);
  validateField("track", e.track);
  validateHex("caPubkey", e.caPubkey, 64);
  validateField("scope", e.scope);
  validateField("notBefore", e.notBefore);
  validateField("notAfter", e.notAfter);
  validateField("issuedAt", e.issuedAt);
  validateHex("signedBy", e.signedBy, 64);
  return encode([
    `${TAG_PREFIX}/ca-endorsement/v1`,
    e.endorsementId,
    e.track,
    e.caPubkey,
    e.scope,
    e.notBefore,
    e.notAfter,
    e.issuedAt,
    e.signedBy,
  ]);
}

/** Pin: sha256-hex of a mandate's canonical bytes (mandatePinHash). */
export async function mandatePinHash(m) {
  return sha256Hex(canonicalMandate(m));
}

/* ---------- forward-chain walk (port of verifier.ts) ---------- */

function isMandateShape(m) {
  if (typeof m !== "object" || m === null) return false;
  return (
    m.kind === "Mandate" &&
    m.version === 1 &&
    typeof m.mandateId === "string" &&
    typeof m.track === "string" &&
    typeof m.holder === "string" &&
    typeof m.issuedAt === "string" &&
    typeof m.expiresAt === "string" &&
    Array.isArray(m.successors) &&
    typeof m.approvalRule === "object" &&
    m.approvalRule !== null &&
    typeof m.minSuccessors === "number" &&
    typeof m.maxDurationSeconds === "number" &&
    typeof m.signedBy === "string" &&
    Array.isArray(m.signatures)
  );
}

function canonicalOrNull(m) {
  try {
    return canonicalMandate(m);
  } catch {
    return null;
  }
}

async function pinHashOrNull(m) {
  try {
    return await sha256Hex(canonicalMandate(m));
  } catch {
    return null;
  }
}

function windowMs(issuedAt, expiresAt) {
  const i = Date.parse(issuedAt);
  const e = Date.parse(expiresAt);
  if (!isFinite(i) || !isFinite(e)) return null;
  return e - i;
}

async function allSignaturesValid(m) {
  const bytes = canonicalOrNull(m);
  if (bytes === null) return false;
  if (!Array.isArray(m.signatures) || m.signatures.length === 0) return false;
  for (const s of m.signatures) {
    if (typeof s?.pubkey !== "string" || typeof s?.sig !== "string") return false;
    if (!(await edVerify(s.sig, bytes, s.pubkey))) return false;
  }
  return true;
}

async function verifyForwardStep(pred, m) {
  if (!isMandateShape(m)) return "envelope-shape-invalid";
  if (m.track !== pred.track) return "wrong-track";
  const w = windowMs(m.issuedAt, m.expiresAt);
  if (w === null) return "envelope-shape-invalid";
  if (w <= 0) return "expires-before-issuance";
  if (Date.parse(m.issuedAt) < Date.parse(pred.issuedAt)) return "issued-before-predecessor";
  if (!(await allSignaturesValid(m))) return "signature-invalid";

  const signerPubkeys = m.signatures.map((s) => s.pubkey);
  if (!signerPubkeys.includes(m.signedBy)) return "signed-by-not-in-signatures";

  const successorSet = new Set(pred.successors);
  for (const pk of signerPubkeys) {
    if (!successorSet.has(pk)) return "signer-not-in-successor-set";
  }
  const distinct = new Set();
  for (const pk of signerPubkeys) if (successorSet.has(pk)) distinct.add(pk);
  if (
    pred.approvalRule.kind !== "threshold" ||
    !Number.isInteger(pred.approvalRule.threshold) ||
    pred.approvalRule.threshold < 1 ||
    distinct.size < pred.approvalRule.threshold
  ) {
    return "approval-threshold-unmet";
  }
  if (m.successors.length < pred.minSuccessors) return "under-min-successors";
  if (
    !Number.isInteger(pred.maxDurationSeconds) ||
    pred.maxDurationSeconds < 0 ||
    w > pred.maxDurationSeconds * 1000
  ) {
    return "over-max-duration";
  }
  return null;
}

/**
 * Verify a track's mandate log FORWARD from a baked pin. Fail-closed
 * everywhere: empty/absent pin, a pin matching no mandate, or a malformed
 * root ⇒ validMandates: [].
 * @returns {{pin:string, root:object|null, rootError?:string, validMandates:object[], rejections:object[]}}
 */
export async function verifyMandateChainFromPin(pinnedHash, mandates) {
  const base = { pin: pinnedHash, root: null, validMandates: [], rejections: [] };
  if (typeof pinnedHash !== "string" || pinnedHash.length === 0) {
    return { ...base, rootError: "no-pin" };
  }
  const list = Array.isArray(mandates) ? mandates : [];

  let rootIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!isMandateShape(m)) continue;
    if ((await pinHashOrNull(m)) === pinnedHash) {
      rootIdx = i;
      break;
    }
  }
  if (rootIdx === -1) return { ...base, rootError: "pin-not-in-log" };

  const root = list[rootIdx];
  if (!isMandateShape(root)) return { ...base, rootError: "root-shape-invalid" };
  const rw = windowMs(root.issuedAt, root.expiresAt);
  if (rw === null) return { ...base, rootError: "root-shape-invalid" };
  if (rw <= 0) return { ...base, rootError: "root-expires-before-issuance" };
  if (!(await allSignaturesValid(root))) return { ...base, rootError: "root-signature-invalid" };
  if (!root.signatures.some((s) => s.pubkey === root.signedBy)) {
    return { ...base, rootError: "root-not-self-signed" };
  }

  const accepted = [root];
  const rejections = [];
  const seenIds = new Set([root.mandateId]);

  for (let i = rootIdx + 1; i < list.length; i++) {
    const m = list[i];
    if (!isMandateShape(m)) continue;
    if (m.track !== root.track) continue;
    if (seenIds.has(m.mandateId)) {
      rejections.push({ mandate: m, reason: "duplicate-mandate-id" });
      continue;
    }
    const pred = accepted[accepted.length - 1];
    const fail = await verifyForwardStep(pred, m);
    if (fail === null) {
      accepted.push(m);
      seenIds.add(m.mandateId);
    } else {
      rejections.push({ mandate: m, reason: fail });
    }
  }

  return { pin: pinnedHash, root, validMandates: accepted, rejections };
}

/**
 * Operational authority at `now`: holder of the most-recent valid mandate
 * whose [issuedAt, expiresAt) contains `now`. null ⇒ no live authority.
 */
export function currentAuthority(chain, now) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  for (let i = chain.validMandates.length - 1; i >= 0; i--) {
    const m = chain.validMandates[i];
    const issued = Date.parse(m.issuedAt);
    const expiry = Date.parse(m.expiresAt);
    if (isFinite(issued) && isFinite(expiry) && issued <= nowMs && nowMs < expiry) {
      return { holder: m.holder, mandate: m, successors: m.successors };
    }
  }
  return null;
}

/* ---------- CaEndorsement verify (port of caEndorsement.ts) ---------- */

async function verifyOneEndorsement(e, caChain, nowMs, skewMs) {
  if (!e || e.kind !== "CaEndorsement" || e.version !== 1) {
    return { ok: false, reason: "wrong-envelope" };
  }
  const nb = Date.parse(e.notBefore);
  const na = Date.parse(e.notAfter);
  if (!isFinite(nb) || !isFinite(na) || na <= nb) {
    return { ok: false, reason: "lease-window-malformed" };
  }
  if (nowMs < nb - skewMs) return { ok: false, reason: "lease-not-yet" };
  if (nowMs >= na + skewMs) return { ok: false, reason: "lease-expired" };

  let bytes;
  try {
    bytes = canonicalCaEndorsement(e);
  } catch {
    return { ok: false, reason: "signature-invalid" };
  }
  if (!Array.isArray(e.signatures) || e.signatures.length === 0) {
    return { ok: false, reason: "signature-invalid" };
  }
  for (const s of e.signatures) {
    if (typeof s?.pubkey !== "string" || typeof s?.sig !== "string") {
      return { ok: false, reason: "signature-invalid" };
    }
    if (!(await edVerify(s.sig, bytes, s.pubkey))) {
      return { ok: false, reason: "signature-invalid" };
    }
  }

  const authority = currentAuthority(caChain, nowMs);
  if (!authority) return { ok: false, reason: "no-ca-authority-at-now" };

  const signerPubkeys = new Set(e.signatures.map((s) => s.pubkey));
  if (!signerPubkeys.has(e.signedBy)) {
    return { ok: false, reason: "signer-not-authorized" };
  }
  if (e.signedBy !== authority.holder) {
    return { ok: false, reason: "signer-not-authorized" };
  }
  return { ok: true };
}

/**
 * The §9 link-3 operational CA keys authorized NOW. Empty array ⇒ fail closed.
 * Deduped, insertion-order preserved.
 */
export async function authorizedCaKeys(endorsements, caChain, now, opts = {}) {
  const skewMs = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const list = Array.isArray(endorsements) ? endorsements : [];
  const valid = [];
  for (const e of list) {
    const r = await verifyOneEndorsement(e, caChain, nowMs, skewMs);
    if (r.ok) valid.push(e);
  }
  const seen = new Set();
  const out = [];
  for (const e of valid) {
    if (!seen.has(e.caPubkey)) {
      seen.add(e.caPubkey);
      out.push(e.caPubkey);
    }
  }
  return out;
}

/* ---------- the Flagship blessing check ---------- */

/**
 * The top-level control-server trust verdict. Given a fetched
 * GET /api/maintainer-blessing body and the CLIENT'S clock (never the
 * server's `now`), decide whether `.com`'s served CA pubkey is authorized.
 *
 *   trusted iff verifyMandateChainFromPin(pin, mandates) →
 *              authorizedCaKeys(caEndorsements, chain, CLIENT_NOW)
 *              includes blessing.caPubkey, live at CLIENT_NOW.
 *
 * The pinnedMandateHash MUST be the locally-baked anchor, not the one in the
 * response — a rogue `.com` could otherwise serve a self-consistent chain
 * anchored at its own pin. The caller passes the baked pin (lib/serverTrust.js
 * supplies BAKED_PIN). When omitted, falls back to blessing.pinnedMandateHash
 * ONLY for the verify-logic unit tests; production always passes the baked pin.
 *
 * @param {object} blessing  the parsed /api/maintainer-blessing body
 * @param {number} nowMs     the client's clock in epoch ms
 * @param {string} [pinnedMandateHash]  the locally-baked anchor (REQUIRED in prod)
 * @returns {Promise<{trusted:boolean, caPubkey:string|null, reason:string}>}
 */
export async function verifyComBlessing(blessing, nowMs, pinnedMandateHash) {
  if (!blessing || typeof blessing !== "object") {
    return { trusted: false, caPubkey: null, reason: "no-blessing" };
  }
  const pin =
    typeof pinnedMandateHash === "string" && pinnedMandateHash.length > 0
      ? pinnedMandateHash
      : blessing.pinnedMandateHash;
  if (typeof pin !== "string" || pin.length === 0) {
    return { trusted: false, caPubkey: null, reason: "pin-unconfigured" };
  }
  const servedKey = blessing.caPubkey;
  if (typeof servedKey !== "string" || servedKey.length !== 64) {
    return { trusted: false, caPubkey: null, reason: "no-served-key" };
  }

  let chain;
  try {
    chain = await verifyMandateChainFromPin(pin, blessing.mandates ?? []);
  } catch {
    return { trusted: false, caPubkey: servedKey, reason: "chain-error" };
  }

  let keys;
  try {
    keys = await authorizedCaKeys(blessing.caEndorsements ?? [], chain, nowMs);
  } catch {
    return { trusted: false, caPubkey: servedKey, reason: "endorsement-error" };
  }
  if (!keys || keys.length === 0) {
    return { trusted: false, caPubkey: servedKey, reason: "no-authorized-ca-keys" };
  }
  if (!keys.includes(servedKey)) {
    return { trusted: false, caPubkey: servedKey, reason: "served-key-not-authorized" };
  }
  return { trusted: true, caPubkey: servedKey, reason: "ok" };
}

export const _internal = { hexToBytes, bytesToHex, sha256Hex, canonicalError: CanonicalError };
