// A server's outbound proxy (docs/outbound-proxy.md).
//
// The owner can make a server reach the internet through an HTTP CONNECT or
// SOCKS5 proxy, so Flagship and the sites it reaches see the proxy's address.
// Which proxy is a sensitive order, signed with the admin master root when
// this account holds one, else the IRK:
//
//   flagship/box-proxy/v1|<serverDomain>|<kind>|<host>|<port>|<auth 1|0>|<fallbackDirect 1|0>|<issuedAt ms>|<nonce>
//
// Created with a server: the signed order rides in the recipe as the unsigned
// `outboundProxy` sibling. Changed later: POST /api/screens/outbound-proxy on
// the box. Credentials are never signed; they travel beside the order.
//
// Must pass packages/protocol/test-vectors/box-proxy/vectors.json.

import { bytesToHex } from "../keystore.js";

export const TAG_BOX_PROXY = "flagship/box-proxy/v1";
export const OUTBOUND_PROXY_PATH = "/api/screens/outbound-proxy";
export const BOX_PROXY_KINDS = ["none", "socks5", "http"];
export const DEFAULT_PROXY_PORT = { socks5: 1080, http: 3128 };

export const PROXY_EXPLAINER =
  "Send this server's internet traffic through a proxy, so Flagship and the sites it reaches see the proxy's address instead of yours.";
export const PROXY_CREDENTIALS_NOTE =
  "The username and password are saved in the setup file. Only give the file to people you trust.";
export const PROXY_FALLBACK_LABEL = "If the proxy stops working, connect directly";
export const PROXY_FALLBACK_NOTE =
  "If this is off and the proxy stops working, the server goes offline until the proxy is back or you change it from the same network.";

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Why `host` is not an acceptable proxy host, or null. Expects normalized input. */
export function boxProxyHostError(host) {
  if (host.length === 0) return "Enter the proxy's address.";
  if (host.length > 253) return "That address is too long.";
  if (host.includes(":")) {
    return IPV6.test(host) && host.split(":").length >= 3 ? null : "Use a host name or an IP address, without a scheme, path or port.";
  }
  if (IPV4.test(host)) return null;
  if (/^[0-9.]+$/.test(host)) return "That isn't a valid IPv4 address.";
  if (host.split(".").every((l) => HOSTNAME_LABEL.test(l))) return null;
  return "Use a host name or an IP address, without a scheme, path or port.";
}

/** Trim, lowercase and drop IPv6 brackets and a trailing dot. */
export function normalizeBoxProxyHost(raw) {
  let h = String(raw ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Why the credentials can't be used, or null. SOCKS5 caps both at 255 bytes. */
export function boxProxyCredentialsError(c) {
  if (typeof c?.username !== "string" || typeof c?.password !== "string") return "Enter a username and password.";
  const enc = new TextEncoder();
  const bad = (s) => [...s].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  const u = enc.encode(c.username).length;
  const p = enc.encode(c.password).length;
  if (u === 0 || p === 0) return "Enter a username and password.";
  if (u > 255 || p > 255) return "The username and password can be at most 255 bytes each.";
  if (c.username.includes(":")) return "The username can't contain a colon.";
  if (bad(c.username) || bad(c.password)) return "The username and password can't contain control characters.";
  return null;
}

/** The canonical bytes; throws on anything the protocol refuses. */
export function canonicalBoxProxy(p) {
  const d = p?.serverDomain;
  if (typeof d !== "string" || d.length === 0 || d !== d.toLowerCase() || /[|\x00-\x1f\x7f]/.test(d)) {
    throw new Error("serverDomain must be non-empty and lowercase");
  }
  if (!BOX_PROXY_KINDS.includes(p.kind)) throw new Error("kind must be none, socks5 or http");
  if (typeof p.auth !== "boolean" || typeof p.fallbackDirect !== "boolean") {
    throw new Error("auth and fallbackDirect must be booleans");
  }
  if (p.kind === "none") {
    if (p.host !== "" || p.port !== 0 || p.auth || p.fallbackDirect) {
      throw new Error("kind none carries no host, port, auth or fallback");
    }
  } else {
    if (typeof p.host !== "string" || normalizeBoxProxyHost(p.host) !== p.host) {
      throw new Error("host must be normalized (lowercase, no brackets, no trailing dot)");
    }
    const why = boxProxyHostError(p.host);
    if (why) throw new Error(`host: ${why}`);
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error("port must be 1..65535");
  }
  if (typeof p.nonce !== "string" || !HEX64.test(p.nonce)) throw new Error("nonce must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(p.issuedAt) || p.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return new TextEncoder().encode(
    [
      TAG_BOX_PROXY,
      p.serverDomain,
      p.kind,
      p.host,
      p.port,
      p.auth ? "1" : "0",
      p.fallbackDirect ? "1" : "0",
      p.issuedAt,
      p.nonce,
    ].join("|"),
  );
}

/** Sign an order with `sign(umk, bytes)`; resolves to the signature hex. */
export async function signBoxProxy(p, umk, sign) {
  return bytesToHex(await sign(umk, canonicalBoxProxy(p)));
}

/**
 * Check what the owner typed. Returns `{ok: true, value}` with
 * `value = {kind, host, port, fallbackDirect, credentials|null}`, or
 * `{ok: false, error, field}`.
 */
export function readProxyForm({ kind, host, port, username, password, fallbackDirect }) {
  if (kind !== "socks5" && kind !== "http") return { ok: true, value: { kind: "none" } };
  const h = normalizeBoxProxyHost(host);
  const hostErr = boxProxyHostError(h);
  if (hostErr) return { ok: false, error: hostErr, field: "host" };
  const portText = String(port ?? "").trim();
  const n = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: "The port must be a number from 1 to 65535.", field: "port" };
  const u = String(username ?? "");
  const pw = String(password ?? "");
  let credentials = null;
  if (u !== "" || pw !== "") {
    if (u === "" || pw === "") return { ok: false, error: "Enter both a username and a password, or neither.", field: "credentials" };
    credentials = { username: u, password: pw };
    const why = boxProxyCredentialsError(credentials);
    if (why) return { ok: false, error: why, field: "credentials" };
  }
  return { ok: true, value: { kind, host: h, port: n, fallbackDirect: !!fallbackDirect, credentials } };
}

function randomNonceHex() {
  const n = new Uint8Array(32);
  crypto.getRandomValues(n);
  return bytesToHex(n);
}

/**
 * Build the signed order for `serverDomain` from a checked form value.
 * `auth` is true when credentials are sent, or when `keepAuth` (an edit that
 * keeps the box's stored credentials).
 */
export async function buildSignedBoxProxy({ serverDomain, value, keepAuth = false }, { umk, sign, now = Date.now, nonceHex } = {}) {
  if (!umk || typeof sign !== "function") throw new Error("Unlock the webapp first");
  const on = value.kind === "socks5" || value.kind === "http";
  const proxy = {
    serverDomain: String(serverDomain).toLowerCase(),
    kind: on ? value.kind : "none",
    host: on ? value.host : "",
    port: on ? value.port : 0,
    auth: on ? !!value.credentials || keepAuth : false,
    fallbackDirect: on ? !!value.fallbackDirect : false,
    issuedAt: now(),
    nonce: nonceHex ?? randomNonceHex(),
  };
  return { proxy, signature: await signBoxProxy(proxy, umk, sign) };
}

/** The recipe siblings for a new server, or {} for no proxy. */
export async function recipeProxySiblings({ serverDomain, value }, deps) {
  if (!value || (value.kind !== "socks5" && value.kind !== "http")) return {};
  const outboundProxy = await buildSignedBoxProxy({ serverDomain, value }, deps);
  return {
    outboundProxy,
    ...(value.credentials ? { outboundProxyCredentials: { ...value.credentials } } : {}),
  };
}

// ── The server page ────────────────────────────────────────────────────

const KIND_LABEL = { socks5: "SOCKS5", http: "HTTP" };

/** "Off", or "SOCKS5 · host:port · needs a password". */
export function proxySummaryText(summary) {
  const p = summary?.proxy;
  if (!p) return "Off";
  const host = p.host.includes(":") ? `[${p.host}]` : p.host;
  return `${KIND_LABEL[p.kind] ?? p.kind} · ${host}:${p.port}${p.auth ? " · needs a password" : ""}`;
}

/** The status line, or "" when there's nothing to say. */
export function proxyStatusText(summary) {
  const s = summary?.status;
  if (!summary?.proxy || !s) return "";
  if (s.state === "ok") return "Working";
  if (s.state === "failing") return `Not working: ${s.lastError ?? "Can't reach the proxy."}`;
  if (s.state === "fallback") return "Using a direct connection: the proxy isn't answering";
  return "";
}

/**
 * Sign and send a change to the box. `fetchJson` is the page's paired-session
 * fetch for this server. Credentials are sent only when typed; an unchanged
 * proxy with none typed keeps the box's.
 */
export async function sendBoxProxy({ serverDomain, value, current, fetchJson }, deps) {
  const p = current?.proxy ?? null;
  const same = !!p && p.kind === value.kind && p.host === value.host && p.port === value.port;
  const keepAuth = !value.credentials && same && !!p.auth && !!current?.hasCredentials;
  const wire = await buildSignedBoxProxy({ serverDomain, value, keepAuth }, deps);
  const body = { ...wire, ...(value.credentials ? { credentials: value.credentials } : {}) };
  return fetchJson(OUTBOUND_PROXY_PATH, { method: "POST", body: JSON.stringify(body) });
}

// ── The form (create-server and the server page share it) ──────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The proxy fields, ids prefixed with `prefix`. `init` prefills an edit:
 * `{kind, host, port, fallbackDirect, hasCredentials}`.
 */
export function proxyFieldsHtml(prefix, init = {}) {
  const kind = init.kind === "socks5" || init.kind === "http" ? init.kind : "none";
  const opt = (v, label) => `<option value="${v}"${kind === v ? " selected" : ""}>${label}</option>`;
  return `
    <label for="${prefix}-kind">Type</label>
    <select id="${prefix}-kind">${opt("none", "None")}${opt("socks5", "SOCKS5")}${opt("http", "HTTP")}</select>
    <div id="${prefix}-fields"${kind === "none" ? ' class="hidden"' : ""}>
      <label for="${prefix}-host">Proxy address</label>
      <input id="${prefix}-host" type="text" autocomplete="off" autocapitalize="none" spellcheck="false"
             placeholder="proxy.example.net or 192.168.1.20" value="${esc(init.host ?? "")}" />
      <label for="${prefix}-port">Port</label>
      <input id="${prefix}-port" type="number" min="1" max="65535" inputmode="numeric"
             value="${esc(init.port ?? (kind === "none" ? "" : DEFAULT_PROXY_PORT[kind]))}" />
      <label for="${prefix}-username">Username (optional)</label>
      <input id="${prefix}-username" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" />
      <label for="${prefix}-password">Password (optional)</label>
      <input id="${prefix}-password" type="password" autocomplete="new-password"${init.hasCredentials ? ' placeholder="Unchanged"' : ""} />
      <p id="${prefix}-cred-note" class="faint-sm hidden">${esc(PROXY_CREDENTIALS_NOTE)}</p>
      <label class="inline-check mt-2">
        <input type="checkbox" id="${prefix}-fallback"${init.fallbackDirect ? " checked" : ""} /> ${esc(PROXY_FALLBACK_LABEL)}
      </label>
      <p class="faint-sm">${esc(PROXY_FALLBACK_NOTE)}</p>
      <p id="${prefix}-error" class="note err hidden" role="alert"></p>
    </div>`;
}

/** Read the fields as the raw form (for `readProxyForm`). */
export function readProxyFields(prefix, doc = globalThis.document) {
  const v = (id) => doc.getElementById(`${prefix}-${id}`);
  return {
    kind: v("kind")?.value ?? "none",
    host: v("host")?.value ?? "",
    port: v("port")?.value ?? "",
    username: v("username")?.value ?? "",
    password: v("password")?.value ?? "",
    fallbackDirect: !!v("fallback")?.checked,
  };
}

/**
 * Show or hide the fields with the type, prefill the port, and check as the
 * owner types. `credentialsNote` false hides the setup-file note (an edit
 * sends the password to the box, not into a file).
 */
export function wireProxyFields(prefix, { credentialsNote = true } = {}, doc = globalThis.document) {
  const v = (id) => doc.getElementById(`${prefix}-${id}`);
  const kindEl = v("kind");
  if (!kindEl) return;
  let lastKind = kindEl.value;
  const check = () => {
    const raw = readProxyFields(prefix, doc);
    const note = v("cred-note");
    if (note) note.classList.toggle("hidden", !credentialsNote || (raw.username === "" && raw.password === ""));
    const err = v("error");
    if (!err) return;
    const touched = raw.host !== "" || raw.username !== "" || raw.password !== "";
    const r = readProxyForm(raw);
    const msg = !r.ok && touched ? r.error : "";
    err.textContent = msg;
    err.classList.toggle("hidden", msg === "");
  };
  kindEl.addEventListener("change", () => {
    const kind = kindEl.value;
    v("fields")?.classList.toggle("hidden", kind === "none");
    const port = v("port");
    if (port && (kind === "socks5" || kind === "http")) {
      const prev = lastKind === "socks5" || lastKind === "http" ? String(DEFAULT_PROXY_PORT[lastKind]) : "";
      if (port.value === "" || port.value === prev) port.value = String(DEFAULT_PROXY_PORT[kind]);
    }
    lastKind = kind;
    check();
  });
  for (const id of ["host", "port", "username", "password"]) v(id)?.addEventListener("input", check);
}
