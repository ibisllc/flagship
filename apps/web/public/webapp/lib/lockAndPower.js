// Lock & power-off — webapp client.
//
// Power the box off or restart it (docs/lock-and-poweroff.md). The signed
// order goes straight to the user's pod (NOT the .com relay):
//
//   power-off PhoneOrder   → admin-root-signed → POST <pod>/api/power
//
// Canonical bytes mirror @flagship/protocol canonicalPhoneOrder byte for byte;
// the pod verifies the signature against its pinned admin key before acting.
// The old dead-man switch (set-deadman-policy / deadman-affirm) is gone: the
// owner's one time limit is the serving policy (lib/servingAuthority.js).

// ---- Canonical-bytes tags — MUST match @flagship/protocol ----
export const TAG_ORDER_POWER_OFF = "flagship/order/power-off/v1";

/** Allowed power-off modes (canonical literals). */
export const POWER_OFF_MODES = ["off", "restart"];

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
