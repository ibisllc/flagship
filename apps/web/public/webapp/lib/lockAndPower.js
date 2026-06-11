// Lock & power-off + dead-man heartbeat-lock — webapp client.
//
// One shared daemon primitive (power off / restart the host) exposed two
// ways: manual buttons + an automatic dead-man heartbeat. Spec:
// docs/lock-and-poweroff.md. No feature-gating — all users.
//
// Three signed envelopes, all delivered directly to the user's pod (NOT
// the .com relay), mirroring the pattern in lib/podPair.js:
//
//   power-off PhoneOrder   → IRK-signed → POST <pod>/api/power
//   SetDeadManPolicy       → IRK-signed → POST <pod>/api/deadman/policy
//   DeadManAffirmation     → IRK-signed → POST <pod>/api/deadman/affirm
//
// Canonical bytes are built here to mirror @flagship/protocol byte-for-byte
// (canonicalPhoneOrder / canonicalSetDeadManPolicy / canonicalDeadManAffirmation).
// The pod verifies each signature against its config-pinned owner IRK pubkey
// before acting.
//
// NOTE on signing key: the webapp has no separate box-PSK; its phone-equivalent
// signing key IS the IRK (same as every other PhoneOrder the webapp sends — see
// podPair.js's add-paired-session). So "sign with the box PSK" maps to
// signWithIrk on this surface.

// ---- Canonical-bytes tags — MUST match @flagship/protocol ----
export const TAG_ORDER_POWER_OFF = "flagship/order/power-off/v1";
export const TAG_SET_DEADMAN_POLICY = "flagship/set-deadman-policy/v1";
export const TAG_DEADMAN_AFFIRM = "flagship/deadman-affirm/v1";

/** Allowed power-off modes (canonical literals). */
export const POWER_OFF_MODES = ["off", "restart"];
/** Allowed dead-man lockout actions (same vocabulary, named distinctly). */
export const DEADMAN_LOCKOUT_MODES = ["off", "restart"];

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// Canonical bytes (pure — mirror @flagship/protocol exactly)
// ---------------------------------------------------------------------------

/** flagship/order/power-off/v1|<serverId>|<mode>|<issuedAt> */
export function canonicalPowerOffBytes({ serverId, mode, issuedAt }) {
  if (mode !== "off" && mode !== "restart") {
    throw err(`invalid power-off mode: ${String(mode)}`, "400");
  }
  return new TextEncoder().encode([TAG_ORDER_POWER_OFF, serverId, mode, issuedAt].join("|"));
}

/** flagship/set-deadman-policy/v1|<serverId>|<enabled 0|1>|<windowMs>|<graceMs>|<lockoutMode>|<issuedAt> */
export function canonicalDeadManPolicyBytes({
  serverId,
  enabled,
  windowMs,
  graceMs,
  lockoutMode,
  issuedAt,
}) {
  if (lockoutMode !== "off" && lockoutMode !== "restart") {
    throw err(`invalid dead-man lockout mode: ${String(lockoutMode)}`, "400");
  }
  return new TextEncoder().encode(
    [
      TAG_SET_DEADMAN_POLICY,
      serverId,
      enabled ? "1" : "0",
      windowMs,
      graceMs,
      lockoutMode,
      issuedAt,
    ].join("|"),
  );
}

/** flagship/deadman-affirm/v1|<serverId>|<nonceHex>|<issuedAt> */
export function canonicalDeadManAffirmBytes({ serverId, nonceHex, issuedAt }) {
  return new TextEncoder().encode([TAG_DEADMAN_AFFIRM, serverId, nonceHex, issuedAt].join("|"));
}

// ---------------------------------------------------------------------------
// Sign + POST helpers
// ---------------------------------------------------------------------------

function podBase(baseUrl) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(b)) throw err("pod baseUrl must be https://", "400");
  return b;
}

async function postEnvelope(url, request, signatureHex, f) {
  let resp;
  try {
    resp = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, signature: signatureHex }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`request failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  return resp.json().catch(() => ({}));
}

/**
 * IRK-sign + POST a `power-off` PhoneOrder to the pod.
 *
 * @param {object} args
 * @param {string} args.baseUrl    the pod base URL (https://<server>.<user>.flagship.services)
 * @param {"off"|"restart"} args.mode
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?: typeof fetch, bytesToHex?: (b: Uint8Array) => string, now?: () => number }} [deps]
 */
export async function sendPowerOff(args, deps = {}) {
  const { baseUrl, mode, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  if (mode !== "off" && mode !== "restart") throw err(`invalid power-off mode: ${String(mode)}`, "400");
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const issuedAt = (deps.now || Date.now)();
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const f = deps.fetch || fetch;
  const sig = await signWithIrk(umk, canonicalPowerOffBytes({ serverId, mode, issuedAt }));
  const request = { type: "power-off", serverId, mode, issuedAt };
  const body = await postEnvelope(`${base}/api/power`, request, toHex(sig), f);
  return { ok: true, serverId, mode, body };
}

/**
 * IRK-sign + POST a `SetDeadManPolicy` to the pod.
 *
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {boolean} args.enabled
 * @param {number} args.windowMs
 * @param {number} args.graceMs
 * @param {"off"|"restart"} args.lockoutMode
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 */
export async function setDeadManPolicy(args, deps = {}) {
  const { baseUrl, enabled, windowMs, graceMs, lockoutMode, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  if (typeof windowMs !== "number" || windowMs <= 0) throw err("windowMs must be > 0", "400");
  if (typeof graceMs !== "number" || graceMs < 0) throw err("graceMs must be >= 0", "400");
  if (lockoutMode !== "off" && lockoutMode !== "restart") {
    throw err(`invalid dead-man lockout mode: ${String(lockoutMode)}`, "400");
  }
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const issuedAt = (deps.now || Date.now)();
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const f = deps.fetch || fetch;
  const request = {
    serverId,
    enabled: Boolean(enabled),
    windowMs,
    graceMs,
    lockoutMode,
    issuedAt,
  };
  const sig = await signWithIrk(umk, canonicalDeadManPolicyBytes(request));
  const body = await postEnvelope(`${base}/api/deadman/policy`, request, toHex(sig), f);
  return { ok: true, serverId, body };
}

/**
 * IRK-sign + POST a fresh `DeadManAffirmation` to the pod. A new 16-byte
 * nonce is minted per call (the daemon rejects a replayed nonce). Resolves
 * with `{ leaseExpiry }` parsed from the pod's response so the UI can show
 * the renewed time-remaining.
 *
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?, bytesToHex?, now?, randomBytes?: (n:number)=>Uint8Array }} [deps]
 */
export async function affirmDeadMan(args, deps = {}) {
  const { baseUrl, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const issuedAt = (deps.now || Date.now)();
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const f = deps.fetch || fetch;
  const rand =
    deps.randomBytes ||
    ((n) => {
      const b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return b;
    });
  const nonce = rand(16);
  if (!(nonce instanceof Uint8Array) || nonce.length < 16) {
    throw err("affirmation nonce must be >= 16 bytes", "400");
  }
  const nonceHex = toHex(nonce);
  const request = { serverId, nonce: nonceHex, issuedAt };
  const sig = await signWithIrk(umk, canonicalDeadManAffirmBytes({ serverId, nonceHex, issuedAt }));
  const body = await postEnvelope(`${base}/api/deadman/affirm`, request, toHex(sig), f);
  return { ok: true, serverId, leaseExpiry: body && body.leaseExpiry, body };
}

// ---------------------------------------------------------------------------
// Window presets — shared by the dead-man section. "tighten now" maps to the
// shortest preset.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

export const DEADMAN_WINDOW_PRESETS = [
  { id: "24h", label: "24 hours", windowMs: 24 * HOUR, graceMs: 6 * HOUR },
  { id: "8h", label: "8 hours", windowMs: 8 * HOUR, graceMs: 2 * HOUR },
  { id: "1h", label: "1 hour", windowMs: 1 * HOUR, graceMs: 15 * MIN },
  { id: "15m", label: "15 minutes", windowMs: 15 * MIN, graceMs: 5 * MIN },
  { id: "5m", label: "5 minutes (tighten)", windowMs: 5 * MIN, graceMs: 2 * MIN },
];

/** The "tighten now" preset — the shortest window. */
export const DEADMAN_TIGHTEN_PRESET = DEADMAN_WINDOW_PRESETS[DEADMAN_WINDOW_PRESETS.length - 1];

export const DEADMAN_DEFAULT_PRESET = DEADMAN_WINDOW_PRESETS[0];

/** Human "Xh Ym Zs left" / "expired" for a unix-ms expiry vs now. */
export function fmtRemaining(expiryMs, nowMs) {
  if (typeof expiryMs !== "number") return "—";
  const ms = expiryMs - nowMs;
  if (ms <= 0) return "expired";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return `${parts.join(" ")} left`;
}
