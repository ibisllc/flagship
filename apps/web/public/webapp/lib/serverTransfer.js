// Transfer-a-box — webapp client (docs/account-deletion-and-name-reclaim.md §4).
//
// A cross-account ownership handoff brokered by `.com`. Two phones:
//
//   GIVER (current owner), on the server's detail page:
//     - build + IRK-sign a one-time, short-TTL ServerTransferOffer
//     - deposit it (IRK mailbox-auth) → POST <controlApex>/api/server/:d/transfer/offer
//     - render the OFFER as a QR (serverDomain, transferNonce, giver IRK pub,
//       expiresAt, the offer signature) — enough for the acquirer to claim and
//       for `.com` to verify.
//     - later: poll GET .../transfer/claim to learn the acquirer IRK so the
//       giver's phone can re-seal the LUKS disk key for the new owner.
//
//   ACQUIRER, from Home → Add a server → "Pair an existing box":
//     - parse the QR (paste-able so it's headlessly testable; camera optional)
//     - build + IRK-sign a ServerTransferClaim binding their username + IRK pub
//       to the offer's nonce → POST .../transfer/claim → take ownership.
//
// Canonical bytes are built here byte-identical to @flagship/protocol's
// canonicalServerTransferOffer / canonicalServerTransferClaim + the
// device-endpoint mailbox-auth (the same bytes the broker re-derives + verifies).

import { controlApex } from "./apex.js";
import { ed25519PubToX25519 } from "./edToMont.js";
import { sealForBrowserKey } from "./buildDraft.js";
import { openSealedWithIrk } from "./leases.js";

// ---- Canonical-bytes tags — MUST match @flagship/protocol ----
export const TAG_SERVER_TRANSFER_OFFER = "flagship/server-transfer-offer/v1";
export const TAG_SERVER_TRANSFER_CLAIM = "flagship/server-transfer-claim/v1";
export const TAG_DEVICE_ENDPOINT_CLAIM = "flagship/device-endpoint-claim/v1";

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

/** ServerTransferOffer canonical bytes (giver IRK). serverDomain + nonce are
 *  lowercased to match the TS canonicalServerTransferOffer. */
export function canonicalOfferBytes({ serverDomain, transferNonce, issuedAt, expiresAt }) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_TRANSFER_OFFER,
      String(serverDomain).toLowerCase(),
      String(transferNonce).toLowerCase(),
      issuedAt,
      expiresAt,
    ].join("|"),
  );
}

/** ServerTransferClaim canonical bytes (acquirer IRK). serverDomain, nonce +
 *  acquirerUsername lowercased; acquirerIrkPub is its raw hex. */
export function canonicalClaimBytes({
  serverDomain,
  transferNonce,
  acquirerUsername,
  acquirerIrkPubHex,
  issuedAt,
}) {
  return new TextEncoder().encode(
    [
      TAG_SERVER_TRANSFER_CLAIM,
      String(serverDomain).toLowerCase(),
      String(transferNonce).toLowerCase(),
      String(acquirerUsername).toLowerCase(),
      String(acquirerIrkPubHex).toLowerCase(),
      issuedAt,
    ].join("|"),
  );
}

/** DeviceEndpointClaim mailbox-auth canonical bytes. NOTE: username is NOT
 *  lowercased here (matches @flagship/protocol's canonicalDeviceEndpointClaim,
 *  which uses c.username verbatim). */
function canonicalMailboxAuthBytes({
  username,
  endpointLabel,
  phoneIrkPubHex,
  issuedAt,
  expiresAt,
  nonceHex,
}) {
  return new TextEncoder().encode(
    [
      TAG_DEVICE_ENDPOINT_CLAIM,
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
 * Build an IRK mailbox-auth credential (signed DeviceEndpointClaim) — the same
 * credential the secret-mailbox / deposit lanes use. Returns the wire object
 * `{ auth, authSignature }`.
 */
async function buildMailboxAuth(args, deps) {
  const { username, umk, signWithIrk, irkPubHex } = args;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const now = (deps.now || Date.now)();
  const nonceHex = randHex(32, deps.getRandomValues);
  const auth = {
    username,
    endpointLabel: deps.endpointLabel || "webapp",
    phoneIrkPub: irkPubHex,
    issuedAt: now,
    expiresAt: now + 120_000,
    nonce: nonceHex,
  };
  const sig = await signWithIrk(
    umk,
    canonicalMailboxAuthBytes({
      username,
      endpointLabel: auth.endpointLabel,
      phoneIrkPubHex: irkPubHex,
      issuedAt: now,
      expiresAt: auth.expiresAt,
      nonceHex,
    }),
  );
  return { auth, authSignature: toHex(sig) };
}

/**
 * GIVER: build + sign the offer, deposit it, and return both the QR payload and
 * the deposit response.
 *
 * @param {object} args
 * @param {string} args.serverDomain    the box FQDN being transferred
 * @param {string} args.username        the giver's account name (current owner)
 * @param {Uint8Array} args.umk         session UMK (for IRK signing)
 * @param {string} args.irkPubHex       the giver's IRK pubkey, hex
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {number} [args.ttlMs]         offer TTL (default 15 min)
 * @param {object} [deps]
 * @returns {Promise<{ ok: true, qr: object, qrText: string, expiresAt: number, body: any }>}
 */
export async function createTransferOffer(args, deps = {}) {
  const { serverDomain, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!irkPubHex) throw err("irkPubHex required", 400);
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || controlApex();
  const issuedAt = (deps.now || Date.now)();
  const ttlMs = Number.isFinite(args.ttlMs) ? args.ttlMs : 15 * 60_000;
  const expiresAt = issuedAt + ttlMs;
  const transferNonce = randHex(32, deps.getRandomValues);

  const offer = { serverDomain, transferNonce, issuedAt, expiresAt };
  const offerSig = await signWithIrk(umk, canonicalOfferBytes(offer));
  const offerSignatureHex = toHex(offerSig);

  const mailboxAuth = await buildMailboxAuth(
    { username, umk, signWithIrk, irkPubHex },
    deps,
  );
  const reqBody = { ...mailboxAuth, offer, offerSignature: offerSignatureHex };

  let resp;
  try {
    resp = await f(`${origin}/api/server/${encodeURIComponent(serverDomain)}/transfer/offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);

  // The QR carries everything the acquirer + `.com` need to claim + verify.
  const qr = {
    v: 1,
    kind: "flagship-transfer-offer",
    serverDomain,
    transferNonce,
    giverIrkPub: String(irkPubHex).toLowerCase(),
    issuedAt,
    expiresAt: (body && body.expiresAt) || expiresAt,
    offerSignature: offerSignatureHex,
  };
  return { ok: true, qr, qrText: JSON.stringify(qr), expiresAt: qr.expiresAt, body };
}

/**
 * ACQUIRER: parse a pasted/scanned QR payload. Accepts the JSON string or an
 * already-parsed object. Throws on a malformed / wrong-kind payload.
 */
export function parseTransferOfferQR(input) {
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      throw err("not a transfer QR", 400);
    }
  }
  if (!obj || obj.kind !== "flagship-transfer-offer") throw err("not a transfer QR", 400);
  if (
    typeof obj.serverDomain !== "string" ||
    typeof obj.transferNonce !== "string" ||
    typeof obj.giverIrkPub !== "string" ||
    typeof obj.expiresAt !== "number"
  ) {
    throw err("malformed transfer QR", 400);
  }
  return {
    serverDomain: obj.serverDomain,
    transferNonce: obj.transferNonce,
    giverIrkPub: obj.giverIrkPub,
    issuedAt: obj.issuedAt,
    expiresAt: obj.expiresAt,
    offerSignature: obj.offerSignature,
  };
}

/**
 * ACQUIRER: build + sign a ServerTransferClaim for a parsed offer and POST it.
 * Resolves `{ ok: true, body }` (body carries newServerDomain) on 200; throws
 * with `.status` on a non-2xx.
 *
 * @param {object} args
 * @param {object} args.offer           the parsed QR (parseTransferOfferQR)
 * @param {string} args.acquirerUsername
 * @param {Uint8Array} args.umk
 * @param {string} args.acquirerIrkPubHex   the acquirer's registered IRK pubkey
 * @param {(umk, bytes) => Promise<Uint8Array>} args.signWithIrk
 */
export async function submitTransferClaim(args, deps = {}) {
  const { offer, acquirerUsername, umk, acquirerIrkPubHex, signWithIrk } = args;
  if (!offer || !offer.serverDomain || !offer.transferNonce) throw err("invalid offer", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!acquirerUsername || !acquirerIrkPubHex) throw err("acquirer identity required", 400);
  if (typeof offer.expiresAt === "number" && offer.expiresAt <= (deps.now || Date.now)()) {
    throw err("this transfer code has expired", 410);
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || controlApex();
  const issuedAt = (deps.now || Date.now)();
  const lowered = String(acquirerUsername).toLowerCase();

  const claimSig = await signWithIrk(
    umk,
    canonicalClaimBytes({
      serverDomain: offer.serverDomain,
      transferNonce: offer.transferNonce,
      acquirerUsername: lowered,
      acquirerIrkPubHex,
      issuedAt,
    }),
  );
  const reqBody = {
    claim: {
      serverDomain: offer.serverDomain,
      transferNonce: offer.transferNonce,
      acquirerUsername: lowered,
      acquirerIrkPub: String(acquirerIrkPubHex).toLowerCase(),
      issuedAt,
    },
    claimSignature: toHex(claimSig),
  };

  let resp;
  try {
    resp = await f(
      `${origin}/api/server/${encodeURIComponent(offer.serverDomain)}/transfer/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      },
    );
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return { ok: true, body };
}

/**
 * GIVER: poll for "did someone claim my offer?" (IRK mailbox-auth). Returns
 * `{ claimed: false }` while pending, or `{ claimed: true, acquirerIrkPub,
 * acquirerUsername, newServerDomain }` once claimed — the acquirer IRK the
 * giver's phone re-seals the LUKS disk key for.
 */
export async function pollTransferClaim(args, deps = {}) {
  const { serverDomain, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();
  const mailboxAuth = await buildMailboxAuth(
    { username, umk, signWithIrk, irkPubHex },
    deps,
  );
  let resp;
  try {
    // POST (not GET) — the IRK mailbox-auth rides the body; a GET-with-body is
    // non-portable. The broker routes claim-poll to the giver-auth read handler.
    resp = await f(`${origin}/api/server/${encodeURIComponent(serverDomain)}/transfer/claim-poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mailboxAuth),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  if (resp.status === 404) return { claimed: false };
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return {
    claimed: true,
    acquirerIrkPub: body.acquirerIrkPub,
    acquirerUsername: body.acquirerUsername,
    newServerDomain: body.newServerDomain,
  };
}

// ── Layer B — giver-phone disk-key re-seal ─────────────────────────────────
//
// Only the GIVER's phone can unseal the box's LUKS disk key (it holds the giver
// IRK; the box holds only the sealed blob). After the acquirer claims, the
// giver's phone:
//   1. fetches the box-sealed disk key (sealed to the GIVER IRK at install) and
//      opens it with the giver IRK;
//   2. RE-SEALS it to the ACQUIRER IRK (learned from `pollTransferClaim`);
//   3. deposits the sealed blob via .../transfer/disk-key (giver IRK
//      mailbox-auth). `.com` stays content-blind — only the acquirer IRK opens
//      it. The acquirer then picks it up + completes the box-sealed-lease
//      deposit (the accepted two-phone handshake, giver first).

/**
 * GIVER: unseal the box's disk key with the giver IRK, re-seal it to the
 * acquirer IRK, and deposit it. `args.acquirerIrkPubHex` comes from
 * `pollTransferClaim`. Resolves `{ ok: true }` on a 200.
 */
export async function resealDiskKeyForAcquirer(args, deps = {}) {
  const { serverDomain, username, umk, irkPubHex, signWithIrk, acquirerIrkPubHex } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  if (!acquirerIrkPubHex) throw err("acquirerIrkPubHex required", 400);
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();

  // 1. Fetch + open the giver-sealed disk key. Injectable for tests.
  const diskKey =
    typeof deps.openDiskKey === "function"
      ? await deps.openDiskKey()
      : await defaultOpenGiverDiskKey({ serverDomain, umk, origin, fetch: f });

  // 2. Re-seal to the acquirer IRK (Ed25519 pub → X25519 → seal).
  const acquirerX = ed25519PubToX25519(hexFromHexString(acquirerIrkPubHex));
  const sealed = await (deps.sealForRecipient || sealForBrowserKey)(diskKey, bytesToHexStr(acquirerX));
  const sealedHex = bytesToHexStr(sealed);

  // 3. Deposit (giver IRK mailbox-auth).
  const mailboxAuth = await buildMailboxAuth({ username, umk, signWithIrk, irkPubHex }, deps);
  let resp;
  try {
    resp = await f(`${origin}/api/server/${encodeURIComponent(serverDomain)}/transfer/disk-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...mailboxAuth, sealedDiskKey: sealedHex }),
    });
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  return { ok: true };
}

/**
 * ACQUIRER: pick up the giver's re-sealed disk key (acquirer IRK mailbox-auth),
 * open it with the acquirer IRK. Returns the raw disk key bytes; the caller then
 * completes the standard box-sealed-lease deposit. Resolves `{ ready: false }`
 * (404) while the giver hasn't re-sealed yet.
 */
export async function claimResealedDiskKey(args, deps = {}) {
  const { serverDomain, username, umk, irkPubHex, signWithIrk } = args;
  if (!serverDomain) throw err("serverDomain required", 400);
  if (!(umk instanceof Uint8Array) || typeof signWithIrk !== "function") {
    throw err("unlock the webapp first", 400);
  }
  const f = deps.fetch || fetch;
  const origin = deps.origin || controlApex();
  const mailboxAuth = await buildMailboxAuth({ username, umk, signWithIrk, irkPubHex }, deps);
  let resp;
  try {
    resp = await f(
      `${origin}/api/server/${encodeURIComponent(serverDomain)}/transfer/disk-key-claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mailboxAuth),
      },
    );
  } catch (e) {
    throw err(`network error: ${(e && e.message) || e}`);
  }
  if (resp.status === 404) return { ready: false };
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw err((body && body.error) || `HTTP ${resp.status}`, resp.status);
  if (typeof body.sealedDiskKey !== "string") throw err("malformed handoff", 502);
  const diskKey = await openSealedWithIrk(umk, hexFromHexString(body.sealedDiskKey));
  return { ready: true, diskKey };
}

async function defaultOpenGiverDiskKey({ serverDomain, umk, origin, fetch: f }) {
  const sealedRes = await f(
    `${origin}/api/server/${encodeURIComponent(serverDomain)}/sealed-luks-key`,
  );
  if (!sealedRes.ok) {
    throw err(`no sealed key on file for ${serverDomain}: ${sealedRes.status}`, sealedRes.status);
  }
  const sealedJson = await sealedRes.json();
  return openSealedWithIrk(umk, hexFromHexString(sealedJson.sealedKey));
}

function hexFromHexString(hex) {
  const clean = String(hex).toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHexStr(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Test seam: seal `plaintext` to an Ed25519 recipient pubkey (hex), exactly as
 *  resealDiskKeyForAcquirer does (Ed25519 pub → X25519 → sealForBrowserKey).
 *  Exported for the cross-platform crypto round-trip test against
 *  @flagship/protocol's openSealedFromEd25519Recipient. */
export async function __sealToEd25519ForTest(plaintext, recipientEdPubHex) {
  const x = ed25519PubToX25519(hexFromHexString(recipientEdPubHex));
  return sealForBrowserKey(plaintext, bytesToHexStr(x));
}
