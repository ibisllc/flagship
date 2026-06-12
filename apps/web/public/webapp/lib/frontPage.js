// Owner-assignable apex ("front page") — webapp client.
//
// The box's root domain 302s to one of its installed services' tier-1
// canonical, or serves the default Flagship page when unassigned. One
// IRK-signed envelope, delivered directly to the user's pod (NOT the .com
// relay), mirroring lib/lockAndPower.js:
//
//   set-front-page PhoneOrder → IRK-signed → POST <pod>/api/front-page
//
// Reads ride two unauthenticated pod GETs: /api/front-page (current
// assignment) and /api/services (the picker options).
//
// Canonical bytes are built here to mirror @flagship/protocol byte-for-byte
// (canonicalPhoneOrder, case "set-front-page"). The pod verifies the
// signature against its config-pinned owner IRK before persisting.

// ---- Canonical-bytes tag — MUST match @flagship/protocol ----
export const TAG_ORDER_SET_FRONT_PAGE = "flagship/order/set-front-page/v1";

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

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

function podBase(baseUrl) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(b)) throw err("pod baseUrl must be https://", "400");
  return b;
}

/** flagship/order/set-front-page/v1|<serverId>|<label>|<issuedAt> — "" clears. */
export function canonicalSetFrontPageBytes({ serverId, label, issuedAt }) {
  if (typeof label !== "string" || label.includes("|")) {
    throw err(`invalid front-page label: ${String(label)}`, "400");
  }
  if (label !== "" && !DNS_LABEL.test(label)) {
    throw err(`invalid front-page label: ${label}`, "400");
  }
  return new TextEncoder().encode(
    [TAG_ORDER_SET_FRONT_PAGE, serverId, label, issuedAt].join("|"),
  );
}

/** GET the current assignment: `{ label: string|null, active: boolean }`. */
export async function getFrontPage({ baseUrl }, deps = {}) {
  const f = deps.fetch || fetch;
  const resp = await f(`${podBase(baseUrl)}/api/front-page`);
  if (!resp.ok) throw err(`request failed (${resp.status})`, String(resp.status));
  return resp.json();
}

/**
 * GET the picker options — the pod's installed services as
 * `[{ urlLabel, name }]`.
 */
export async function listFrontPageOptions({ baseUrl }, deps = {}) {
  const f = deps.fetch || fetch;
  const resp = await f(`${podBase(baseUrl)}/api/services`);
  if (!resp.ok) throw err(`request failed (${resp.status})`, String(resp.status));
  const body = await resp.json();
  return (body.apps || []).map((a) => ({ urlLabel: a.urlLabel, name: a.name }));
}

/**
 * IRK-sign + POST a `set-front-page` PhoneOrder to the pod. `label` is the
 * service url-label to front-page, or "" to restore the default page.
 *
 * @param {object} args
 * @param {string} args.baseUrl    the pod base URL (https://<server>.<user>.flagship.services)
 * @param {string} args.label
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?: typeof fetch, bytesToHex?: (b: Uint8Array) => string, now?: () => number }} [deps]
 */
export async function sendSetFrontPage(args, deps = {}) {
  const { baseUrl, label, umk, signWithIrk } = args;
  if (!umk || typeof signWithIrk !== "function") throw err("unlock the webapp first", "400");
  const base = podBase(baseUrl);
  const serverId = new URL(base).host;
  const issuedAt = (deps.now || Date.now)();
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const f = deps.fetch || fetch;
  const sig = await signWithIrk(umk, canonicalSetFrontPageBytes({ serverId, label, issuedAt }));
  const request = { type: "set-front-page", serverId, label, issuedAt };
  let resp;
  try {
    resp = await f(`${base}/api/front-page`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, signature: toHex(sig) }),
    });
  } catch {
    throw err("could not reach the server", "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw err(`request failed (${resp.status}): ${text}`.trim(), String(resp.status));
  }
  const body = await resp.json().catch(() => ({}));
  return { ok: true, serverId, label, body };
}
