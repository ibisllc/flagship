// P2.9 — Debug send-order panel.
//
// Builds a canonical PhoneOrder envelope, IRK-signs it, base64-encodes,
// and POSTs to /api/screens/orders/send (P1.14). The 12 order types
// share a "tag | serverId | ...args | issuedAt" canonical-bytes
// shape; this panel exposes a select for the kind + dynamic field
// inputs for each one. Useful for development and recovery scenarios
// where the user needs to send a specific order without going through
// the dedicated UI.

import { bytesToHex, signWithIrk } from "../keystore.js";
import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError, getPodBaseUrl } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-orders-debug");

// (kind → { tag, fields: [{name, type}] })
const ORDER_SHAPES = {
  noop: { tag: "flagship/order/noop/v1", fields: [] },
  "shut-down": { tag: "flagship/order/shut-down/v1", fields: [] },
  "set-backup-policy": {
    tag: "flagship/order/set-backup-policy/v1",
    fields: [{ name: "enabled", type: "bool" }],
  },
  "revoke-self": {
    tag: "flagship/order/revoke-self/v1",
    fields: [{ name: "reason", type: "string" }],
  },
  "add-paired-session": {
    tag: "flagship/order/add-paired-session/v1",
    fields: [
      { name: "token", type: "string" },
      { name: "label", type: "string" },
    ],
  },
  "remove-paired-session": {
    tag: "flagship/order/remove-paired-session/v1",
    fields: [{ name: "token", type: "string" }],
  },
  "add-subscriber": {
    tag: "flagship/order/add-subscriber/v1",
    fields: [
      { name: "appId", type: "string" },
      { name: "fqdn", type: "string" },
    ],
  },
  "remove-subscriber": {
    tag: "flagship/order/remove-subscriber/v1",
    fields: [
      { name: "appId", type: "string" },
      { name: "fqdn", type: "string" },
    ],
  },
  "backup-app": {
    tag: "flagship/order/backup-app/v1",
    fields: [
      { name: "creator", type: "string" },
      { name: "slug", type: "string" },
      { name: "includeUserData", type: "bool" },
      { name: "password", type: "string" },
    ],
  },
};

function renderFields() {
  const kind = $("od-kind").value;
  const shape = ORDER_SHAPES[kind];
  const root = $("od-fields");
  if (!shape || shape.fields.length === 0) {
    root.innerHTML = '<p class="note">no extra fields</p>';
    return;
  }
  root.innerHTML = shape.fields.map((f) => `
    <label>${escapeHtml(f.name)}</label>
    ${f.type === "bool"
      ? `<select id="od-${escapeHtml(f.name)}">
          <option value="false">false</option>
          <option value="true">true</option>
        </select>`
      : `<input id="od-${escapeHtml(f.name)}" type="text" placeholder="${escapeHtml(f.name)}" />`}
  `).join("");
}

function readFields() {
  const kind = $("od-kind").value;
  const shape = ORDER_SHAPES[kind];
  if (!shape) throw new Error("unknown order kind");
  const out = { type: kind };
  for (const f of shape.fields) {
    const el = $(`od-${f.name}`);
    if (!el) continue;
    if (f.type === "bool") {
      out[f.name] = el.value === "true";
    } else {
      const v = el.value.trim();
      if (v) out[f.name] = v;
    }
  }
  return { shape, request: out };
}

function canonicalForOrder(serverId, request, shape) {
  const issuedAt = Date.now();
  const fullRequest = { ...request, serverId, issuedAt };
  // Build canonical-bytes per @flagship/protocol's
  // canonicalPhoneOrder. The order is: tag | serverId | (fields in
  // declaration order) | issuedAt. Booleans → "1"/"0". Optional
  // strings missing → empty string.
  const args = shape.fields.map((f) => {
    const v = fullRequest[f.name];
    if (f.type === "bool") return v ? "1" : "0";
    return v ?? "";
  });
  const canonical = new TextEncoder().encode(
    [shape.tag, serverId, ...args, issuedAt].join("|"),
  );
  return { fullRequest, canonical };
}

async function sendOrder() {
  const session = getSession();
  if (!session.umk) return toast("unlock first", "err");
  const baseUrl = getPodBaseUrl();
  if (!baseUrl) return toast("not paired with a pod yet", "err");
  const serverId = new URL(baseUrl).host;

  let parsed;
  try {
    parsed = readFields();
  } catch (e) {
    return toast(e.message, "err");
  }
  const { shape, request } = parsed;
  const { fullRequest, canonical } = canonicalForOrder(serverId, request, shape);
  const sig = await signWithIrk(session.umk, canonical);
  const envelopeBytes = new TextEncoder().encode(
    JSON.stringify({ request: fullRequest, signature: bytesToHex(sig) }),
  );
  const envelopeB64 = btoa(String.fromCharCode(...envelopeBytes));

  const resultEl = $("od-result");
  resultEl.textContent = "sending…";
  try {
    const r = await screensFetch("/api/screens/orders/send", {
      method: "POST",
      body: JSON.stringify({
        envelope: envelopeB64,
        kind: fullRequest.type,
      }),
    });
    resultEl.innerHTML = `<pre class="json-block">${escapeHtml(JSON.stringify(r, null, 2))}</pre>`;
  } catch (e) {
    if (e instanceof ScreensError) {
      resultEl.innerHTML = `<p class="err-text">${escapeHtml(e.message)}</p>`;
    } else {
      resultEl.innerHTML = `<p class="err-text">${escapeHtml(String(e))}</p>`;
    }
  }
}

export function initOrdersDebugView() {
  $("od-kind")?.addEventListener("change", renderFields);
  $("od-send")?.addEventListener("click", sendOrder);
  $("orders-debug-back")?.addEventListener("click", () => show("view-home"));
}

export function enterOrdersDebug() {
  show("view-orders-debug");
  renderFields();
  $("od-result").innerHTML = "";
}
