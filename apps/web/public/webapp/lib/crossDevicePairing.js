// Phase 3b — cross-device QR pairing (collaborator admit + add-profile).
//
// The business-adding-collaborators case (docs/login-and-account-redesign.md
// — "Cross-device sets", "Safeguards", "Multi-profile integration"): a
// multi-device account spanning ecosystems (a collaborator's own
// iPhone/Android, their own Apple ID) where iCloud can't carry the
// credential. Keys move OUT-OF-BAND via a pairing QR over the existing
// QrRelay transport.
//
// Two halves, both here so the crypto + branch logic is one auditable
// unit (all side-effecting collaborators injected → unit-testable
// without IndexedDB / the DOM / the network / a live relay):
//
//   ADMIN (desktop, the QR generator + sender):
//     - shows a pairing QR = the universal link
//         https://flagshipserver.com/join?sid=<relaySid>&pk=<adminEphemeralPubB64u>
//     - opens the relay as the sender, derives the SAS on peer connect,
//       shows it; the admin confirms the codes match.
//     - receives the incoming device's FRESH device pubkey, builds +
//       signs a `DeviceAdmit { username, newDevicePubHex, issuedAt }`
//       with the ACCOUNT IRK (the admin holds the registered key), and
//       SEALS `{ umkSeed, admit, admitSig }` over the relay's AEAD
//       channel. The umkSeed is the key material iCloud would otherwise
//       sync; the admit is the unforgeable vouch.
//
//   INCOMING (the scanned-in collaborator device):
//     - opens the /join link → connects the relay as the receiver,
//       derives + shows the SAS (the user verifies it matches the
//       admin's screen), mints a FRESH device key, sends its pubkey.
//     - receives the sealed bundle, verifies the admit under the
//       account IRK pub (fetched via /api/users/:u/pubkey-cert),
//       persists the UMK under a NEW profile (NEVER clobbering an
//       existing one — per-profile keystore keying), registers push +
//       POSTs /api/users/:u/devices/admit, adds the profile (set
//       active), and surfaces the 14-day quarantine.
//
// Safeguards (docs §"Safeguards (required for Phase 3b)"):
//   1. No screenshots — the webapp can't hard-block, so both screens
//      carry a prominent "don't screenshot this code" warning + a short
//      single-use relay TTL so a leaked still is useless fast.
//   2. A scanned-in device is NOT admin — it joins QUARANTINED (the
//      server stamps the 14-day window; we surface the countdown).
//   3. Explicit risk warning on both screens (the QR shares your account
//      keys; anyone who scans it can join).

import { controlApex } from "./apex.js";
import { persistAdminRootSeed as ksPersistAdminRootSeed } from "../keystore.js";

const APEX = controlApex();

/** Canonical-bytes tag for the device-admit envelope. MUST match
 *  packages/protocol/src/auth.ts TAG_DEVICE_ADMIT and the Worker. */
export const TAG_DEVICE_ADMIT = "flagship/device-admit/v2";

/** The relay session's single-use TTL. Short by design (Safeguard 1):
 *  a leaked screenshot of the QR is useless once the session expires.
 *  Mirrors the relay DO's own 5-min ceiling — the admin UI also offers a
 *  manual "new code" but should re-key well before this. */
export const PAIRING_TTL_MS = 5 * 60_000;

/** 14-day quarantine, mirrored from the server (push.ts QUARANTINE_MS /
 *  0028_account_type.sql). Surfaced as the countdown on the incoming
 *  device. The authoritative `quarantineUntil` is what the admit route
 *  returns; this is the fallback when the body omits it. */
export const QUARANTINE_MS = 14 * 86_400_000;

/** Risk-warning copy carried on BOTH screens (Safeguard 4). Pure exports
 *  so tests pin the exact wording and the iOS/Android surfaces can match. */
export const ADMIN_RISK_WARNING =
  "This shares your account keys with the new device. Anyone who scans this code can join your account — only do it for a device or person you intend to add.";
export const INCOMING_RISK_WARNING =
  "Scanning this links this device to someone else's Flagship account and copies their account keys here. Only continue if you trust the person showing the code.";
export const NO_SCREENSHOT_WARNING =
  "Don't screenshot this code. A captured still can be used to join the account. The code also expires shortly.";

/** `|`-joined, UTF-8 — same as every signed message. */
function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function defaultBytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function defaultHexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ─────────────────────────────────────────────────────────────────────
 * /join universal link — build (admin) + parse (incoming router).
 * ───────────────────────────────────────────────────────────────────── */

/** Build the pairing universal link the admin's QR encodes. The phone's
 *  native camera opens `https://flagshipserver.com/join?…` straight into
 *  the app; the webapp router parses the same query (see {@link
 *  parseJoinLink}). `pk` is the admin's ephemeral X25519 pubkey
 *  (base64url) — the relay session's other endpoint.
 *  @param {{ sid: string, pkB64u: string, baseUrl?: string }} args
 *  @returns {string}
 */
export function buildJoinLink({ sid, pkB64u, baseUrl = APEX }) {
  if (!sid || !pkB64u) throw new Error("buildJoinLink: sid + pkB64u required");
  return `${baseUrl}/join?sid=${encodeURIComponent(sid)}&pk=${encodeURIComponent(pkB64u)}`;
}

/** Parse a /join link (or a raw `sid=…&pk=…` query, or the current
 *  location's search string) into `{ sid, pk }`. Returns null when the
 *  input isn't a join link — the router uses that to fall through to the
 *  normal boot. Accepts the full URL, the `flagship://join?…` deep-link
 *  form, and a bare query fragment so a pasted link works everywhere.
 *  @param {string} raw
 *  @returns {{ sid: string, pk: string }|null}
 */
export function parseJoinLink(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  let sid, pk;
  try {
    if (text.includes("?")) {
      const normalized = text.startsWith("flagship://")
        ? text.replace("flagship://", "https://_/")
        : text;
      const u = new URL(normalized, APEX);
      // Only treat it as a join link when the path is /join (a stray
      // ?sid= on some other view must not hijack the boot).
      if (!/\/join\/?$/.test(u.pathname) && !text.startsWith("flagship://join")) {
        // A bare "/join?…" with no host parses pathname "/join"; an
        // absolute non-join URL won't match. Allow the query-only case
        // below to still catch a pasted "sid=…&pk=…".
        return parseJoinQueryOnly(text);
      }
      sid = u.searchParams.get("sid");
      pk = u.searchParams.get("pk");
    } else {
      return parseJoinQueryOnly(text);
    }
  } catch {
    return parseJoinQueryOnly(text);
  }
  if (!sid || !pk) return null;
  return { sid, pk };
}

function parseJoinQueryOnly(text) {
  if (!text.includes("=")) return null;
  try {
    const sp = new URLSearchParams(text.replace(/^\?/, ""));
    const sid = sp.get("sid");
    const pk = sp.get("pk");
    if (!sid || !pk) return null;
    return { sid, pk };
  } catch {
    return null;
  }
}

/** Read a join link out of `window.location` at boot — the webapp-router
 *  hook. Returns `{ sid, pk }` when this load IS a /join deep-link, else
 *  null. Tolerates a SSR/test env with no `window`.
 *  @param {{ href?: string, pathname?: string, search?: string }} [loc]
 *  @returns {{ sid: string, pk: string }|null}
 */
export function joinLinkFromLocation(loc) {
  const l = loc ?? (typeof window !== "undefined" ? window.location : null);
  if (!l) return null;
  // Only the /join path is a pairing entry. The path is the gate; the
  // query carries the session.
  const path = l.pathname ?? "";
  if (!/\/join\/?$/.test(path)) return null;
  const search = l.search ?? "";
  if (!search) return null;
  return parseJoinQueryOnly(search);
}

/* ─────────────────────────────────────────────────────────────────────
 * Device-admit envelope — build + sign (admin) / verify (incoming).
 * ───────────────────────────────────────────────────────────────────── */

/** Build a `DeviceAdmit` for the incoming device's pubkey. Pure.
 *  @param {{ username: string, newDevicePubHex: string, issuedAt?: number, now?: () => number }} args
 *  @returns {{ username: string, newDevicePubHex: string, issuedAt: number }}
 */
export function buildDeviceAdmit({ username, deviceId, newDevicePubHex, issuedAt, now }) {
  if (!username) throw new Error("buildDeviceAdmit: username required");
  if (!/^[0-9a-f]{64}$/.test(String(newDevicePubHex).toLowerCase())) {
    throw new Error("buildDeviceAdmit: newDevicePubHex must be 32 bytes hex");
  }
  if (!/^[0-9a-f]{32}$/.test(String(deviceId).toLowerCase())) {
    throw new Error("buildDeviceAdmit: deviceId must be 16 bytes hex");
  }
  const at = issuedAt ?? (now ?? (() => Date.now()))();
  return {
    username,
    deviceId: String(deviceId).toLowerCase(),
    newDevicePubHex: String(newDevicePubHex).toLowerCase(),
    issuedAt: at,
  };
}

/** Canonical-bytes for a DeviceAdmit. MUST match canonicalDeviceAdmit in
 *  packages/protocol/src/auth.ts (`tag|username|newDevicePubHex|issuedAt`).
 *  @param {{ username: string, newDevicePubHex: string, issuedAt: number }} admit
 *  @returns {Uint8Array}
 */
export function deviceAdmitCanonicalBytes(admit) {
  return canonical([
    TAG_DEVICE_ADMIT,
    admit.username,
    admit.deviceId,
    admit.newDevicePubHex,
    admit.issuedAt,
  ]);
}

/** Sign a DeviceAdmit with the ACCOUNT IRK (derived from the admin's UMK
 *  seed). Returns hex. The admin holds the registered key, so this is the
 *  unforgeable vouch the Worker verifies under `users.irk_pub_hex`.
 *  @param {{
 *    admit: object,
 *    seed: Uint8Array,
 *    signWithIrk: (seed: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>,
 *    bytesToHex?: (b: Uint8Array) => string,
 *  }} args
 *  @returns {Promise<string>}  hex Ed25519 signature
 */
export async function signAdmit({ admit, seed, signWithIrk, bytesToHex = defaultBytesToHex }) {
  const sig = await signWithIrk(seed, deviceAdmitCanonicalBytes(admit));
  return bytesToHex(sig);
}

/** Verify a DeviceAdmit signature under the account's IRK pubkey. Pure
 *  apart from the injected verifier (WebCrypto Ed25519 on the browser).
 *  @param {{
 *    admit: object,
 *    admitSigHex: string,
 *    irkPubHex: string,
 *    verifyEd25519: (pub: Uint8Array, sig: Uint8Array, bytes: Uint8Array) => Promise<boolean>,
 *    hexToBytes?: (hex: string) => Uint8Array,
 *  }} args
 *  @returns {Promise<boolean>}
 */
export async function verifyAdmit({ admit, admitSigHex, irkPubHex, verifyEd25519, hexToBytes = defaultHexToBytes }) {
  try {
    const pub = hexToBytes(irkPubHex);
    const sig = hexToBytes(admitSigHex);
    return await verifyEd25519(pub, sig, deviceAdmitCanonicalBytes(admit));
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Account IRK-pub resolution — the incoming side fetches the account's
 * CURRENTLY-REGISTERED IRK pub to verify the admit under it. We use the
 * /api/users/:u/pubkey-cert binding (the only endpoint that returns the
 * pub), which is CA-signed; the resolve preflight does NOT carry a pub.
 * ───────────────────────────────────────────────────────────────────── */

/** GET /api/users/:u/pubkey-cert → the account's registered IRK pub hex.
 *  Throws on a non-2xx (a missing account here is a genuine failure — the
 *  incoming side only reaches this AFTER a successful resolve).
 *  @param {{ username: string, fetch?: typeof fetch, baseUrl?: string }} args
 *  @returns {Promise<string>}  lowercased IRK pub hex
 */
export async function fetchAccountIrkPubHex({ username, fetch: f = fetch, baseUrl = APEX }) {
  const resp = await f(
    `${baseUrl}/api/users/${encodeURIComponent(username)}/pubkey-cert`,
    { method: "GET" },
  );
  if (!resp.ok) {
    throw new Error(`couldn't resolve account key (${resp.status})`);
  }
  const body = await resp.json();
  const pub = body?.binding?.pubKey;
  if (typeof pub !== "string" || !/^[0-9a-f]{64}$/i.test(pub)) {
    throw new Error("account key response malformed");
  }
  return pub.toLowerCase();
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/users/:u/devices/admit — the vouched cross-device admit.
 * ───────────────────────────────────────────────────────────────────── */

/** POST the admit envelope + the incoming device's push registration.
 *  The server verifies the admit under the account IRK and admits the
 *  device QUARANTINED. Returns the parsed body (`{ ok, tokenId,
 *  quarantineUntil }`). Throws on a non-2xx so the caller surfaces it.
 *  @param {{
 *    username: string,
 *    admit: object,
 *    admitSigHex: string,
 *    request: object,        the PushTokenRegister fields (username, platform, providerToken, pushX25519Pub, label, issuedAt)
 *    signatureHex: string,   carried for storage; the server does NOT verify it (the admit is the IRK consent)
 *    fetch?: typeof fetch,
 *    baseUrl?: string,
 *  }} args
 *  @returns {Promise<{ ok?: boolean, tokenId?: string, quarantineUntil?: number }>}
 */
export async function postDeviceAdmit(args) {
  const f = args.fetch || fetch;
  const baseUrl = args.baseUrl || APEX;
  const resp = await f(
    `${baseUrl}/api/users/${encodeURIComponent(args.username)}/devices/admit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        admit: args.admit,
        admitSig: args.admitSigHex,
        request: args.request,
        signature: args.signatureHex,
      }),
    },
  );
  if (!resp.ok) {
    const txt = await safeText(resp);
    throw new Error(`device admit failed (${resp.status}): ${txt}`.trim());
  }
  return resp.json();
}

/* ─────────────────────────────────────────────────────────────────────
 * Quarantine countdown — surfaced on the incoming device (Safeguard 3).
 * ───────────────────────────────────────────────────────────────────── */

/** Derive the quarantine-countdown view-model from the admit response.
 *  Pure; the host re-calls it on each tick with a fresh `now`. The copy
 *  is byte-stable across surfaces so iOS/Android can mirror it.
 *  @param {{ quarantineUntil?: number }} admitResponse
 *  @param {number} [now]
 *  @returns {{
 *    quarantined: boolean,
 *    until: number,
 *    remainingMs: number,
 *    label: string,
 *  }}
 */
export function quarantineTimeline(admitResponse, now = Date.now()) {
  const until = Number(admitResponse?.quarantineUntil ?? 0);
  const quarantined = until > now;
  const remainingMs = Math.max(0, until - now);
  const label = quarantined
    ? `This device is under review for ${formatRemaining(remainingMs)} — it can't manage other devices until then, and the account owner is being asked to confirm it.`
    : "This device's review window has elapsed.";
  return { quarantined, until, remainingMs, label };
}

/** Human "Nd Nh" / "Nh Nm" / "Nm Ns" remaining string. Pure; no locale
 *  dependency so tests pin the exact wording across surfaces. (Same as
 *  loginTakeover.formatRemaining — kept local to avoid a cross-import.) */
export function formatRemaining(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/* ─────────────────────────────────────────────────────────────────────
 * ADMIN orchestrator — vouch + seal the bundle for the incoming device.
 *
 * The relay handshake (open session, render QR, derive SAS, confirm,
 * exchange pubkeys, AEAD-seal) is injected as `relay`: a transport object
 * with the methods this orchestrator drives. This keeps the choreography
 * (which is genuinely the existing QrRelay v2 protocol) swappable + the
 * vouch logic unit-testable without a live WebSocket.
 * ───────────────────────────────────────────────────────────────────── */

/** Run the admin side: open a pairing session, wait for the peer + SAS
 *  confirmation, receive the incoming device pubkey, sign a DeviceAdmit,
 *  and seal `{ umkSeed, admit, admitSig }` over the relay.
 *
 *  @param {{
 *    username: string,
 *    seed: Uint8Array,                 the account UMK seed (admin holds it)
 *    signWithIrk: (seed: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>,
 *    promoteAdmin?: boolean,           Slice D (D-4): ALSO make the new device an admin
 *    adminRootSeed?: Uint8Array|null,  this admin device's 32-byte admin-root seed (required when promoteAdmin)
 *    relay: {
 *      open: () => Promise<{ sid: string, pkB64u: string }>,   open session, return its QR fields
 *      onSas: (cb: (sas: string) => void) => void,             SAS derived on peer connect
 *      awaitConfirm: () => Promise<boolean>,                   admin confirms the codes match
 *      receivePeerPub: () => Promise<string>,                  incoming device pubkey (hex)
 *      seal: (plaintextBytes: Uint8Array) => Promise<void>,    AEAD-seal + deliver
 *      close?: () => void,
 *    },
 *    bytesToHex?: (b: Uint8Array) => string,
 *    onJoinLink?: (link: string) => void,                      surface the QR link
 *    now?: () => number,
 *    baseUrl?: string,
 *  }} deps
 *  @returns {Promise<{ outcome: "sealed"|"cancelled", admit?: object, admitSigHex?: string, promotedAdmin?: boolean }>}
 */
export async function runAdminAddDevice(deps) {
  const { username, seed } = deps;
  if (!username) throw new Error("runAdminAddDevice: username required");
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("runAdminAddDevice: account seed unavailable");
  }
  // Slice D (D-4): promote-at-add-time seals the admin master root INTO the
  // bundle so the new device becomes a bare-root admin. Only meaningful when
  // the caller opts in (default OFF) AND this admin device actually holds the
  // 32-byte admin root. A malformed/absent root with promote ON is a hard
  // error — never silently drop the admin the operator asked to grant.
  const promoteAdmin = deps.promoteAdmin === true;
  const adminRootSeed = deps.adminRootSeed ?? null;
  if (promoteAdmin && (!(adminRootSeed instanceof Uint8Array) || adminRootSeed.length !== 32)) {
    throw new Error("runAdminAddDevice: promote requested but this device holds no admin root");
  }
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const now = deps.now ?? (() => Date.now());
  const relay = deps.relay;

  const { sid, pkB64u } = await relay.open();
  if (typeof deps.onJoinLink === "function") {
    deps.onJoinLink(buildJoinLink({ sid, pkB64u, baseUrl: deps.baseUrl }));
  }

  // SAS is surfaced via the injected callback as soon as the peer
  // connects; the admin compares it on-screen and confirms.
  const confirmed = await relay.awaitConfirm();
  if (!confirmed) {
    relay.close?.();
    return { outcome: "cancelled" };
  }

  // Receive the incoming device's FRESH device pubkey; bind it in the
  // admit so a captured admit can't be re-aimed at a different device.
  const peer = await relay.receivePeerPub();
  const admit = buildDeviceAdmit({
    username,
    deviceId: peer.deviceId,
    newDevicePubHex: peer.devicePubHex,
    now,
  });
  const admitSigHex = await signAdmit({
    admit,
    seed,
    signWithIrk: deps.signWithIrk,
    bytesToHex: toHex,
  });

  // Seal { umkSeed, admit, admitSig } over the relay's AEAD channel. The
  // umkSeed is the key material iCloud would otherwise sync. When promoting,
  // `wrappedAdminRoot` (the admin-root seed hex) rides in the SAME bundle,
  // protected by the SAME relay AEAD seal as the UMK — the new device unwraps
  // it and stores it device-local to become a bare-root admin.
  const bundle = {
    umkSeedHex: toHex(seed),
    admit,
    admitSig: admitSigHex,
    ...(promoteAdmin && adminRootSeed ? { wrappedAdminRoot: toHex(adminRootSeed) } : {}),
  };
  await relay.seal(new TextEncoder().encode(JSON.stringify(bundle)));
  relay.close?.();
  return { outcome: "sealed", admit, admitSigHex, promotedAdmin: promoteAdmin };
}

/* ─────────────────────────────────────────────────────────────────────
 * INCOMING orchestrator — receive the sealed bundle, persist under a NEW
 * profile (never clobbering an existing one), verify, register, admit.
 * ───────────────────────────────────────────────────────────────────── */

/** Parse + validate a sealed bundle's plaintext. Returns the structured
 *  `{ seed, admit, admitSigHex, adminRootSeed }`. `adminRootSeed` is a 32-byte
 *  Uint8Array ONLY when the admin promoted the device (`wrappedAdminRoot`
 *  present, Slice D D-4), else null. Throws on a malformed bundle.
 *  @param {string|Uint8Array} plaintext
 *  @param {{ hexToBytes?: (hex: string) => Uint8Array }} [opts]
 *  @returns {{ seed: Uint8Array, admit: object, admitSigHex: string, adminRootSeed: Uint8Array|null }}
 */
export function parseSealedBundle(plaintext, opts = {}) {
  const hexToBytes = opts.hexToBytes || defaultHexToBytes;
  const text = typeof plaintext === "string"
    ? plaintext
    : new TextDecoder().decode(plaintext);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("sealed bundle is not valid JSON");
  }
  if (!parsed || typeof parsed.umkSeedHex !== "string" || !parsed.admit ||
      typeof parsed.admitSig !== "string") {
    throw new Error("sealed bundle missing fields");
  }
  if (!/^[0-9a-f]{64}$/i.test(parsed.umkSeedHex)) {
    throw new Error("sealed bundle umkSeed malformed");
  }
  const seed = hexToBytes(parsed.umkSeedHex.toLowerCase());
  if (seed.length !== 32) throw new Error("sealed bundle umkSeed must be 32 bytes");
  // Slice D (D-4): the OPTIONAL sealed admin root. Absent on a normal (non-admin)
  // join. When present it MUST be a well-formed 32-byte hex — a malformed one is
  // a corrupt/hostile bundle, not a silent non-admin fallback.
  let adminRootSeed = null;
  if (parsed.wrappedAdminRoot != null) {
    if (typeof parsed.wrappedAdminRoot !== "string" ||
        !/^[0-9a-f]{64}$/i.test(parsed.wrappedAdminRoot)) {
      throw new Error("sealed bundle wrappedAdminRoot malformed");
    }
    adminRootSeed = hexToBytes(parsed.wrappedAdminRoot.toLowerCase());
    if (adminRootSeed.length !== 32) {
      throw new Error("sealed bundle wrappedAdminRoot must be 32 bytes");
    }
  }
  return { seed, admit: parsed.admit, admitSigHex: parsed.admitSig, adminRootSeed };
}

/** Run the incoming side end-to-end once the relay has delivered the
 *  sealed bundle.
 *
 *  Steps:
 *    1. Parse the sealed bundle → { seed, admit, admitSig }.
 *    2. Resolve the account's CURRENT IRK pub and VERIFY the admit under
 *       it (reject a bad vouch BEFORE persisting anything).
 *    3. Mint this profile's FRESH device key — wrap the recovered UMK
 *       under the NEW profile's keystore record (per-profile keying;
 *       NEVER clobbers an existing profile).
 *    4. Derive this device's IRK pub (from the seed); the admit's
 *       `newDevicePubHex` MUST equal it (the admin vouched for THIS key).
 *    5. Register push (the incoming device's token) + POST
 *       /api/users/:u/devices/admit (server admits it QUARANTINED).
 *    6. addProfile(setActive) + return the quarantine surface.
 *
 *  All side-effecting collaborators injected → unit-testable.
 *
 *  @param {{
 *    bundlePlaintext: string|Uint8Array,
 *    deviceIrkPubHex: string,                    THIS profile's fresh device IRK pub hex
 *    setActiveKeystoreProfile?: (cloudName: string) => unknown,
 *    persistSeedForProfile: (seed: Uint8Array, cloudName: string, passphrase: string) => Promise<unknown>,
 *    persistAdminRootSeed?: (umkSeed: Uint8Array, adminSeed: Uint8Array) => Promise<void>,
 *    unlockSession: (seed: Uint8Array, username?: string) => Promise<void>|void,
 *    fetchAccountIrkPubHex?: (args: object) => Promise<string>,
 *    verifyAdmit?: (args: object) => Promise<boolean>,
 *    verifyEd25519: (pub: Uint8Array, sig: Uint8Array, bytes: Uint8Array) => Promise<boolean>,
 *    registerPush: (args: { username: string, deviceIrkPubHex: string }) => Promise<{ request: object, signatureHex: string }>,
 *    postDeviceAdmit?: (args: object) => Promise<object>,
 *    addProfile?: (profile: object, opts?: object) => unknown,
 *    setUsername?: (username: string) => void,
 *    bytesToHex?: (b: Uint8Array) => string,
 *    hexToBytes?: (hex: string) => Uint8Array,
 *    makePassphrase?: () => string,
 *    fetch?: typeof fetch,
 *    baseUrl?: string,
 *    now?: () => number,
 *  }} deps
 *  @returns {Promise<{ username: string, quarantine: object, admitResponse: object }>}
 */
export async function runIncomingJoin(deps) {
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const hexToBytes = deps.hexToBytes || defaultHexToBytes;
  const makePassphrase = deps.makePassphrase || randomLocalPassphrase;
  const now = deps.now ?? (() => Date.now());
  const fetchPub = deps.fetchAccountIrkPubHex || fetchAccountIrkPubHex;
  const verify = deps.verifyAdmit || verifyAdmit;
  const post = deps.postDeviceAdmit || postDeviceAdmit;

  // 1 — parse the sealed bundle (carries the OPTIONAL sealed admin root when
  // the admin promoted this device, Slice D D-4).
  const { seed, admit, admitSigHex, adminRootSeed } = parseSealedBundle(deps.bundlePlaintext, { hexToBytes });
  const username = admit?.username;
  if (!username) throw new Error("admit missing username");

  // 4 (checked early) — the admin must have vouched for THIS device's
  // freshly-minted key. Reject a bundle aimed at a different device.
  const myPub = String(deps.deviceIrkPubHex || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(myPub)) {
    throw new Error("incoming device key unavailable");
  }
  if (String(admit.newDevicePubHex).toLowerCase() !== myPub || admit.deviceId !== deps.deviceId) {
    throw new Error("admit is for a different device — refusing");
  }

  // 2 — resolve the account IRK pub + VERIFY the admit under it BEFORE
  // persisting anything. A bad vouch never touches the keystore.
  const irkPubHex = await fetchPub({
    username,
    fetch: deps.fetch,
    baseUrl: deps.baseUrl,
  });
  const ok = await verify({
    admit,
    admitSigHex,
    irkPubHex,
    verifyEd25519: deps.verifyEd25519,
    hexToBytes,
  });
  if (!ok) throw new Error("admit signature did not verify under the account key");

  // 3 — persist the recovered UMK under a NEW profile (per-profile
  // keying; NEVER clobbers an existing one). Point the keystore at this
  // cloud FIRST so the wrap lands under its own record.
  if (typeof deps.setActiveKeystoreProfile === "function") {
    deps.setActiveKeystoreProfile(username);
  }
  await deps.persistSeedForProfile(seed, username, makePassphrase());
  if (typeof deps.setUsername === "function") deps.setUsername(username);
  // Slice D (D-4): if the admin sealed the admin root into the bundle, store it
  // device-local (under THIS profile — active profile is now `username`) BEFORE
  // unlockSession, so unlockSession's loadAdminRootSeed picks it up and this
  // device is admin from the moment it opens. Absent → a plain non-admin join.
  if (adminRootSeed) {
    const persistAdminRoot = deps.persistAdminRootSeed || ksPersistAdminRootSeed;
    await persistAdminRoot(seed, adminRootSeed);
  }
  await deps.unlockSession(seed, username);

  // 5 — register THIS device's push token, then POST the admit (server
  // admits QUARANTINED; the registration signature rides for storage but
  // the admit is the IRK consent so the server doesn't verify it).
  const { request, signatureHex } = await deps.registerPush({
    username,
    deviceId: admit.deviceId,
    deviceIrkPubHex: myPub,
  });
  const admitResponse = await post({
    username,
    admit,
    admitSigHex,
    request,
    signatureHex,
    fetch: deps.fetch,
    baseUrl: deps.baseUrl,
  });

  // 6 — add the profile (set active) + surface the quarantine.
  if (typeof deps.addProfile === "function") {
    deps.addProfile({
      cloudName: username,
      cloudRootPubHex: irkPubHex,
      accountId: username,
      deviceId: admit.deviceId,
      accountDisplayName: null,
      deviceDisplayName: null,
      deviceCapability: null,
      demoServer: null,
    });
  }

  const quarantineUntil = typeof admitResponse?.quarantineUntil === "number"
    ? admitResponse.quarantineUntil
    : now() + QUARANTINE_MS;
  const quarantine = quarantineTimeline({ quarantineUntil }, now());

  return { username, quarantine, admitResponse, promotedAdmin: !!adminRootSeed };
}

/** Random URL-safe local at-rest wrap passphrase. Like the demo /
 *  takeover paths, the received-seed's local passphrase is generated, not
 *  typed — the SAS-verified relay + admit are the real gates. */
function randomLocalPassphrase() {
  const bytes = (globalThis.crypto || crypto).getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
