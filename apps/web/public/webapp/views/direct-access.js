// The server page's "Direct access" (docs/direct-access-and-domains.md §5, §8):
// an admin device opts the server in (its home address becomes public in DNS),
// then gives each app one name on the direct domain. Every change is a signed
// sensitive order behind a fresh unlock: the direct-access order goes to the box
// and then to `.com`, a name order to `.com`, which publishes exactly what was
// signed. Other devices see the state only. Hidden on a box that doesn't serve
// direct access. Also the app page's "Link to share" once its direct name is
// published.
//
// MIRRORS: iOS DirectAccessViewModel.swift + DirectAccessCard.swift.

import { $ } from "../lib/router.js";
import { boxClient, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { isAdminDevice } from "../lib/memberRoles.js";
import { confirmFreshUnlock } from "../lib/freshUnlock.js";
import { toast } from "../lib/toast.js";
import { asSentence, boxErrorText } from "../lib/humanError.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { escapeHtml } from "../lib/util.js";
import { appDisplayName } from "../lib/appDisplayName.js";
import {
  DirectOrderRefused,
  directAccessOrderProblem,
  parseAddressList,
  parsePort,
  parsePrefixList,
  signDirectAccessOrder,
} from "../lib/directAccess.js";
import { DIRECT_APEX, derivedDirectName, directLabelOf, directNameOrderProblem, signDirectNameOrder } from "../lib/directName.js";
import {
  DirectAccessRefusal,
  directNameStateText,
  directProbeText,
  directReasonText,
  directRefusalText,
  fetchDirectState,
  nameStateOf,
  postDirectAccessOrder,
  postDirectNameOrder,
  probeDirectName,
  serverStateOf,
} from "../lib/directNames.js";

import { tr } from "../lib/i18n.js";

export const DIRECT_WARNING = tr("Turning this on puts this server's home IP address in public DNS. Anyone can look it up, and it stays in public DNS history even after you turn it off. The server then takes connections from the whole internet, attacks land on your home connection, and some internet providers don't allow running a server.");
export const DIRECT_ADMIN_ONLY = tr("Only an admin device can change direct access. This device can see it.");
export const DIRECT_OTHER_CREATOR = tr("This app was made by another account, so it can't have a direct name here.");
export const DIRECT_NOT_CHANGED = tr("Direct access wasn't changed.");

const VIEW_PATH = "/api/screens/direct-access";

// ---- state ---------------------------------------------------------------------------------------

/** What the section shows; one server page is open at a time. */
let current = null;

function freshState({ fqdn, username, canManage }) {
  return {
    fqdn: String(fqdn ?? "").toLowerCase(),
    username: String(username ?? "").toLowerCase(),
    canManage: !!canManage,
    supported: true,
    loaded: false,
    view: null,
    account: null,
    apps: [],
    busy: false,
    error: "",
    notice: "",
    editing: false,
    form: { addresses: "", prefixes: "", port: "443" },
    nameDraft: null,
  };
}

export function directApex(st) {
  return st?.account?.apex || DIRECT_APEX;
}

/** The box's own word first; `.com`'s record when the box can't say. */
export function directIsOn(st) {
  if (st?.view && typeof st.view.on === "boolean") return st.view.on;
  return serverStateOf(st?.account, st?.fqdn)?.on === true;
}

export function directAddresses(st) {
  return st?.view?.addresses ?? serverStateOf(st?.account, st?.fqdn)?.addresses ?? [];
}

export function directPrefixes(st) {
  return st?.view?.prefixes ?? serverStateOf(st?.account, st?.fqdn)?.prefixes ?? [];
}

export function directPort(st) {
  return st?.view?.port ?? serverStateOf(st?.account, st?.fqdn)?.port ?? 443;
}

/** Where the box says it can be reached now. */
export function directReported(st) {
  const eps = st?.view?.endpoints;
  if (Array.isArray(eps) && eps.length) return eps.map((e) => e.address);
  return serverStateOf(st?.account, st?.fqdn)?.boxAddresses ?? [];
}

/** One row per app on this server: its direct name (only when this account made it) and that name's state. */
export function directRows(st) {
  const apex = directApex(st);
  return (st?.apps ?? [])
    .filter((a) => a && typeof a.serviceId === "string" && !a.copying)
    .map((a) => {
      const own = String(a.creator ?? "").toLowerCase() === st.username;
      const fqdn = own ? derivedDirectName(a.slug, a.creator, apex) : null;
      const state = fqdn ? nameStateOf(st.account, fqdn) : null;
      return { serviceId: a.serviceId, appName: appDisplayName(a), fqdn, label: fqdn ? directLabelOf(fqdn, apex) : null, state, isOn: state?.enabled === true };
    });
}

// ---- loading -------------------------------------------------------------------------------------

/**
 * The box's view, `.com`'s state and the server's apps. `supported` is false on
 * a box that doesn't serve direct access (404). `deps` are test seams.
 */
export async function loadDirectAccess({ fqdn, username }, deps = {}) {
  const fetchJson = deps.fetchJson ?? ((path, init) => boxClient(fqdn).fetch(path, init));
  let view = null;
  try {
    view = await fetchJson(VIEW_PATH);
  } catch (e) {
    if (e instanceof ScreensError && e.status === 404) return { supported: false, view: null, account: null, apps: [] };
    if (e && typeof e === "object" && e.status === 404) return { supported: false, view: null, account: null, apps: [] };
  }
  const state = deps.fetchState ?? ((u) => fetchDirectState(u));
  const [account, apps] = await Promise.all([
    username ? state(username).catch(() => null) : Promise.resolve(null),
    fetchJson("/api/screens/apps-list").then((b) => (Array.isArray(b?.apps) ? b.apps : []), () => []),
  ]);
  return { supported: true, view: view && typeof view.on === "boolean" ? view : null, account, apps };
}

// ---- submitting ----------------------------------------------------------------------------------

/** A refusal's own sentence by its code, from `.com` or the box. */
export function directErrorText(e) {
  if (e instanceof DirectAccessRefusal) return e.message;
  if (e instanceof DirectOrderRefused) return directRefusalText(e.code);
  if (e && typeof e === "object" && e.body && typeof e.body === "object" && typeof e.body.code === "string") {
    const fallback = typeof e.body.error === "string" ? asSentence(e.body.error) : null;
    return directRefusalText(e.body.code, fallback);
  }
  return boxErrorText(e);
}

function gate(session) {
  if (!isAdminDevice(session)) return DIRECT_ADMIN_ONLY;
  if (!session?.umk) return tr("Unlock the webapp first.");
  return null;
}

function seams(fqdn, deps) {
  return {
    session: deps.session ?? getSession(),
    freshUnlock: deps.freshUnlock ?? confirmFreshUnlock,
    fetchJson: deps.fetchJson ?? ((path, init) => boxClient(fqdn).fetch(path, init)),
    postAccess: deps.postAccess ?? postDirectAccessOrder,
    postName: deps.postName ?? postDirectNameOrder,
    state: deps.fetchState ?? ((u) => fetchDirectState(u)),
    probe: deps.probe ?? probeDirectName,
    now: deps.now ?? Date.now,
  };
}

async function sendAccessOrder(order, { fqdn, username }, s, deps, unlockText) {
  const unlocked = await s.freshUnlock(unlockText, { session: s.session });
  if (!unlocked.ok) return unlocked.cancelled ? { ok: false, cancelled: true, error: DIRECT_NOT_CHANGED } : { ok: false, error: unlocked.error };
  let view = null;
  try {
    const signed = await signDirectAccessOrder(order, { umk: s.session.umk, sign: deps.sign });
    const res = await s.fetchJson(VIEW_PATH, { method: "POST", body: JSON.stringify(signed) });
    view = res?.directAccess ?? null;
    await s.postAccess(username, signed);
  } catch (e) {
    return { ok: false, error: directErrorText(e), view };
  }
  const account = await s.state(username).catch(() => null);
  return { ok: true, view, account };
}

/**
 * Turn on, or change the addresses: check the device and the form, ask (with
 * the privacy warning), sign once, send to the box, then to `.com`. Resolves to
 * `{ok: true, view, account, notice}`, `{ok: false, error, view?}` or
 * `{ok: false, cancelled: true, error}`. No DOM.
 */
export async function submitDirectAccess({ fqdn, username, addressesText, prefixesText, portText, wasOn }, deps = {}) {
  const s = seams(fqdn, deps);
  const refused = gate(s.session);
  if (refused) return { ok: false, error: refused };
  const addrs = parseAddressList(addressesText);
  if (!addrs.ok) return { ok: false, error: directRefusalText(addrs.code) };
  const prefs = parsePrefixList(prefixesText);
  if (!prefs.ok) return { ok: false, error: directRefusalText(prefs.code) };
  const port = parsePort(portText);
  if (port === null) return { ok: false, error: directRefusalText("bad-port") };
  const order = { serverDomain: String(fqdn).toLowerCase(), enabled: true, addresses: addrs.list, prefixes: prefs.list, port, issuedAt: s.now() };
  const problem = directAccessOrderProblem(order);
  if (problem) return { ok: false, error: directRefusalText(problem) };
  const r = await sendAccessOrder(order, { fqdn, username }, s, deps, {
    title: wasOn ? tr("Change direct access?") : tr("Turn on direct access?"),
    message: DIRECT_WARNING,
    okLabel: wasOn ? tr("Save") : tr("Turn on"),
  });
  return r.ok ? { ...r, notice: wasOn ? tr("Saved.") : tr("Direct access is on.") } : r;
}

/** Turn off: ask, sign the off order, send to the box, then to `.com`. Same result shape. */
export async function submitDirectAccessOff({ fqdn, username, port = 443 }, deps = {}) {
  const s = seams(fqdn, deps);
  const refused = gate(s.session);
  if (refused) return { ok: false, error: refused };
  const order = { serverDomain: String(fqdn).toLowerCase(), enabled: false, addresses: [], prefixes: [], port: Number(port) || 443, issuedAt: s.now() };
  const r = await sendAccessOrder(order, { fqdn, username }, s, deps, {
    title: tr("Turn off direct access?"),
    message: tr("Its names stop pointing at this server. The address stays in public DNS history."),
    okLabel: tr("Turn off"),
  });
  return r.ok ? { ...r, notice: tr("Direct access is off.") } : r;
}

/**
 * One name order: turn on with the defaults (`addressesText` empty, `caa` pin),
 * save its settings, or turn it off. Resolves to `{ok: true, account, notice}`
 * or the same failures as {@link submitDirectAccess}.
 */
export async function submitDirectName({ fqdn, username, apex = DIRECT_APEX, name, enabled, addressesText = "", caa = "pin" }, deps = {}) {
  const s = seams(fqdn, deps);
  const refused = gate(s.session);
  if (refused) return { ok: false, error: refused };
  let addresses = [];
  if (enabled) {
    const parsed = parseAddressList(addressesText);
    if (!parsed.ok) return { ok: false, error: directRefusalText(parsed.code) };
    addresses = parsed.list;
  }
  const order = { name, serverDomain: String(fqdn).toLowerCase(), enabled: !!enabled, addresses, caa: caa === "off" ? "off" : "pin", issuedAt: s.now() };
  const problem = directNameOrderProblem(order, apex);
  if (problem) return { ok: false, error: directRefusalText(problem) };
  const unlocked = await s.freshUnlock(
    {
      title: tr("Change a direct name?"),
      message: enabled ? tr("Visitors to {0} will go straight to this server.", name) : tr("{0} will stop pointing at this server.", name),
      okLabel: enabled ? tr("Save") : tr("Turn off"),
    },
    { session: s.session },
  );
  if (!unlocked.ok) return unlocked.cancelled ? { ok: false, cancelled: true, error: DIRECT_NOT_CHANGED } : { ok: false, error: unlocked.error };
  try {
    const signed = await signDirectNameOrder(order, { umk: s.session.umk, sign: deps.sign, apex });
    await s.postName(username, signed);
  } catch (e) {
    return { ok: false, error: directErrorText(e) };
  }
  const account = await s.state(username).catch(() => null);
  return { ok: true, account, notice: tr("Saved.") };
}

/** The outside check. Any device of the account may run it; it changes nothing. */
export async function submitDirectProbe({ username, label }, deps = {}) {
  const s = seams("", deps);
  try {
    const p = await s.probe(username, label);
    const account = await s.state(username).catch(() => null);
    return { ok: true, probe: p, account, notice: directProbeText(p) };
  } catch (e) {
    return { ok: false, error: directErrorText(e) };
  }
}

/** "Checked <time>: Reachable from outside." */
export function directProbeLine(p, now = Date.now()) {
  if (typeof p?.at !== "number") return directProbeText(p);
  return tr("Checked {0}: {1}", formatDateTime(p.at, now), directProbeText(p));
}

// ---- rendering -----------------------------------------------------------------------------------

/** The empty slot the server page puts after Debug access; `wireDirectAccess` fills it. */
export function directAccessSlotHtml(fqdn) {
  return `<div id="direct-access-slot" data-fqdn="${escapeHtml(String(fqdn ?? "").toLowerCase())}"></div>`;
}

function addressLinesHtml(st) {
  const lines = [];
  const a = directAddresses(st);
  const p = directPrefixes(st);
  const r = directReported(st);
  if (a.length) lines.push(`<p class="note small mono" id="sd-direct-access-addresses">${escapeHtml(tr("Addresses: {0}", a.join(", ")))}</p>`);
  if (p.length) lines.push(`<p class="note small mono" id="sd-direct-access-prefixes">${escapeHtml(tr("Address ranges: {0}", p.join(", ")))}</p>`);
  if (r.length) lines.push(`<p class="note small mono" id="sd-direct-access-reported">${escapeHtml(tr("This server reports: {0}", r.join(", ")))}</p>`);
  return lines.join("");
}

function formHtml(st) {
  const on = directIsOn(st);
  const dis = st.busy ? " disabled" : "";
  return `
      <p class="warn-text small mt-2" id="sd-direct-access-warning">${escapeHtml(DIRECT_WARNING)}</p>
      <label class="caption mt-2" for="sd-direct-access-addresses-field">${escapeHtml(tr("Public addresses (an IPv4 forwarded on your router, or a fixed IPv6), one per line"))}</label>
      <textarea id="sd-direct-access-addresses-field" class="full-width mono" rows="3" spellcheck="false" autocomplete="off" placeholder="81.2.69.142">${escapeHtml(st.form.addresses)}</textarea>
      <label class="caption mt-2" for="sd-direct-access-prefixes-field">${escapeHtml(tr("Address ranges this server may report its own address in (optional)"))}</label>
      <textarea id="sd-direct-access-prefixes-field" class="full-width mono" rows="2" spellcheck="false" autocomplete="off" placeholder="2a02:8010:6400::/48">${escapeHtml(st.form.prefixes)}</textarea>
      <label class="caption mt-2" for="sd-direct-access-port-field">${escapeHtml(tr("Port"))}</label>
      <input id="sd-direct-access-port-field" class="full-width mono" inputmode="numeric" autocomplete="off" placeholder="443" value="${escapeHtml(st.form.port)}" />
      <div class="row-2 mt-2">
        <button id="sd-direct-access-submit"${dis}>${escapeHtml(st.busy ? tr("Signing…") : on ? tr("Save") : tr("Turn on"))}</button>
        <button class="secondary" id="sd-direct-access-cancel"${dis}>${escapeHtml(tr("Cancel"))}</button>
      </div>`;
}

function nameDraftHtml(st, row) {
  const d = st.nameDraft;
  if (!d || d.serviceId !== row.serviceId) return "";
  const dis = st.busy ? " disabled" : "";
  return `
        <div class="mt-2" id="sd-direct-name-draft">
          <label class="caption"><input type="checkbox" id="sd-direct-name-caa"${d.pinCaa ? " checked" : ""} /> ${escapeHtml(tr("Only this server can get a certificate (CAA)"))}</label>
          <p class="note small">${escapeHtml(tr("Turn this off only if the name points at a host that gets its own certificate."))}</p>
          <label class="caption mt-2" for="sd-direct-name-addresses">${escapeHtml(tr("Point at other addresses (optional). Leave empty to follow this server's addresses."))}</label>
          <textarea id="sd-direct-name-addresses" class="full-width mono" rows="2" spellcheck="false" autocomplete="off" placeholder="203.0.114.7">${escapeHtml(d.addressesText)}</textarea>
          <div class="row-2 mt-2">
            <button id="sd-direct-name-save"${dis}>${escapeHtml(st.busy ? tr("Signing…") : tr("Save"))}</button>
            <button class="secondary" id="sd-direct-name-cancel"${dis}>${escapeHtml(tr("Cancel"))}</button>
          </div>
        </div>`;
}

function nameRowHtml(st, row, now) {
  const id = escapeHtml(row.serviceId);
  const head = `<p class="weight-600">${escapeHtml(row.appName)}</p>`;
  if (!row.fqdn) {
    return `<div class="mt-3" id="sd-direct-name-${id}">${head}<p class="note small">${escapeHtml(DIRECT_OTHER_CREATOR)}</p></div>`;
  }
  const s = row.state;
  const lines = [];
  if (s) {
    lines.push(`<p class="note small${s.state === "published" ? "" : " faint-sm"}" id="sd-direct-name-state-${id}">${escapeHtml(directNameStateText(s))}</p>`);
    const why = s.state === "pending" ? directReasonText(s.reason) : null;
    if (why) lines.push(`<p class="note small">${escapeHtml(why)}</p>`);
    if (s.caa === "off") lines.push(`<p class="note small">${escapeHtml(tr("Any host may get a certificate for this name (CAA off)."))}</p>`);
    if (Array.isArray(s.addresses) && s.addresses.length) lines.push(`<p class="note small mono">${escapeHtml(tr("Points at: {0}", s.addresses.join(", ")))}</p>`);
    if (s.probe) {
      lines.push(`<p class="note small${s.probe.reachable === false ? " err-text" : ""}" id="sd-direct-name-probe-${id}">${escapeHtml(directProbeLine(s.probe, now))}</p>`);
    }
  } else {
    lines.push(`<p class="note small" id="sd-direct-name-state-${id}">${escapeHtml(tr("Not turned on"))}</p>`);
  }
  const dis = st.busy ? " disabled" : "";
  const buttons = [];
  if (st.canManage) {
    if (row.isOn) {
      buttons.push(`<button class="secondary" id="sd-direct-name-edit-${id}" data-dn-edit="${id}"${dis}>${escapeHtml(tr("Settings"))}</button>`);
      buttons.push(`<button class="secondary" id="sd-direct-name-off-${id}" data-dn-off="${id}"${dis}>${escapeHtml(tr("Turn off"))}</button>`);
    } else if (directIsOn(st)) {
      buttons.push(`<button class="secondary" id="sd-direct-name-on-${id}" data-dn-on="${id}"${dis}>${escapeHtml(tr("Turn on"))}</button>`);
    }
  }
  if (s?.state === "published") {
    buttons.push(`<button class="secondary" id="sd-direct-name-probe-btn-${id}" data-dn-probe="${id}"${dis}>${escapeHtml(tr("Check from outside"))}</button>`);
  }
  return `
      <div class="mt-3" id="sd-direct-name-${id}">
        ${head}
        <p class="mono small truncate">${escapeHtml(row.fqdn)}</p>
        ${lines.join("")}
        ${buttons.length ? `<div class="row-2 mt-1">${buttons.join("")}</div>` : ""}
        ${nameDraftHtml(st, row)}
      </div>`;
}

function namesHtml(st, rows, now) {
  return `
      <hr class="mt-3" />
      <p class="weight-600 mt-3">${escapeHtml(tr("Direct names"))}</p>
      <p class="note small">${escapeHtml(tr("One name per app on fshp.app. Visitors go straight to this server and the relay never carries it."))}</p>
      ${rows.length ? rows.map((r) => nameRowHtml(st, r, now)).join("") : `<p class="note small">${escapeHtml(tr("No apps on this server yet."))}</p>`}`;
}

/** The "Direct access" section; "" on a box that doesn't serve it. */
export function directAccessHtml(st, now = Date.now()) {
  if (!st || !st.supported) return "";
  let content;
  if (!st.loaded) {
    content = `<p class="faint-sm">${escapeHtml(tr("Loading…"))}</p>`;
  } else {
    const on = directIsOn(st);
    const rows = directRows(st);
    const dis = st.busy ? " disabled" : "";
    const state = on
      ? `<p class="weight-600" id="sd-direct-access-state">${escapeHtml(tr("On. Visitors can reach this server's apps directly, without the relay."))}</p>${addressLinesHtml(st)}`
      : `<p class="note" id="sd-direct-access-state">${escapeHtml(tr("Off. Visitors reach this server's apps through the relay."))}</p>`;
    let controls;
    if (!st.canManage) {
      controls = `<p class="note small mt-2" id="sd-direct-access-admin-only">${escapeHtml(DIRECT_ADMIN_ONLY)}</p>`;
    } else if (st.editing) {
      controls = formHtml(st);
    } else {
      controls = `
      <div class="row-2 mt-2">
        <button id="${on ? "sd-direct-access-change" : "sd-direct-access-on"}"${dis}>${escapeHtml(on ? tr("Change") : tr("Turn on"))}</button>
        ${on ? `<button class="danger" id="sd-direct-access-off"${dis}>${escapeHtml(tr("Turn off"))}</button>` : ""}
      </div>`;
    }
    const names = on || rows.some((r) => r.state) ? namesHtml(st, rows, now) : "";
    const footer = st.error
      ? `<p class="err-text small mt-2" id="sd-direct-access-error" role="alert">${escapeHtml(st.error)}</p>`
      : st.notice
        ? `<p class="note small mt-2" id="sd-direct-access-notice" role="status">${escapeHtml(st.notice)}</p>`
        : "";
    content = `${state}${controls}${names}${footer}`;
  }
  return `
    <div id="sd-direct-access-section">
      <h2 class="mt-4">${escapeHtml(tr("Direct access"))}</h2>
      <div class="card" id="sd-direct-access">
        ${content}
      </div>
    </div>`;
}

// ---- wiring --------------------------------------------------------------------------------------

function paint() {
  const st = current;
  const slot = $("direct-access-slot");
  if (!st || !slot || slot.getAttribute("data-fqdn") !== st.fqdn) return;
  slot.innerHTML = directAccessHtml(st);
  wireButtons(st);
}

function readForm(st) {
  st.form = {
    addresses: $("sd-direct-access-addresses-field")?.value ?? st.form.addresses,
    prefixes: $("sd-direct-access-prefixes-field")?.value ?? st.form.prefixes,
    port: $("sd-direct-access-port-field")?.value ?? st.form.port,
  };
}

function readNameDraft(st) {
  if (!st.nameDraft) return;
  st.nameDraft = {
    ...st.nameDraft,
    pinCaa: $("sd-direct-name-caa")?.checked ?? st.nameDraft.pinCaa,
    addressesText: $("sd-direct-name-addresses")?.value ?? st.nameDraft.addressesText,
  };
}

async function run(st, go) {
  if (st.busy) return;
  st.error = "";
  st.notice = "";
  st.busy = true;
  paint();
  let r;
  try {
    r = await go();
  } catch (e) {
    r = { ok: false, error: directErrorText(e) };
  } finally {
    st.busy = false;
  }
  if (current !== st) return r;
  if (r.view) st.view = r.view;
  if (r.account) st.account = r.account;
  if (r.ok) {
    st.notice = r.notice ?? "";
    if (r.notice) toast(r.notice, "ok");
  } else {
    st.error = r.error ?? "";
  }
  paint();
  return r;
}

function rowById(st, serviceId) {
  return directRows(st).find((r) => r.serviceId === serviceId) ?? null;
}

function wireButtons(st) {
  const slot = $("direct-access-slot");
  if (!slot) return;
  const startEditing = () => {
    st.form = { addresses: directAddresses(st).join("\n"), prefixes: directPrefixes(st).join("\n"), port: String(directPort(st)) };
    st.error = "";
    st.notice = "";
    st.editing = true;
    paint();
  };
  $("sd-direct-access-on")?.addEventListener("click", startEditing);
  $("sd-direct-access-change")?.addEventListener("click", startEditing);
  $("sd-direct-access-cancel")?.addEventListener("click", () => {
    st.editing = false;
    paint();
  });
  $("sd-direct-access-submit")?.addEventListener("click", () => {
    readForm(st);
    const wasOn = directIsOn(st);
    void run(st, async () => {
      const r = await submitDirectAccess({ fqdn: st.fqdn, username: st.username, addressesText: st.form.addresses, prefixesText: st.form.prefixes, portText: st.form.port, wasOn });
      if (r.ok) st.editing = false;
      return r;
    });
  });
  $("sd-direct-access-off")?.addEventListener("click", () => {
    void run(st, async () => {
      const r = await submitDirectAccessOff({ fqdn: st.fqdn, username: st.username, port: directPort(st) });
      if (r.ok) st.editing = false;
      return r;
    });
  });
  slot.querySelectorAll("[data-dn-on]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rowById(st, btn.getAttribute("data-dn-on"));
      if (!row?.fqdn) return;
      void run(st, () => submitDirectName({ fqdn: st.fqdn, username: st.username, apex: directApex(st), name: row.fqdn, enabled: true, caa: "pin" }));
    });
  });
  slot.querySelectorAll("[data-dn-off]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rowById(st, btn.getAttribute("data-dn-off"));
      if (!row?.fqdn) return;
      void run(st, () =>
        submitDirectName({ fqdn: st.fqdn, username: st.username, apex: directApex(st), name: row.fqdn, enabled: false, caa: row.state?.caa === "off" ? "off" : "pin" }),
      );
    });
  });
  slot.querySelectorAll("[data-dn-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rowById(st, btn.getAttribute("data-dn-edit"));
      if (!row?.fqdn) return;
      st.nameDraft = { serviceId: row.serviceId, fqdn: row.fqdn, pinCaa: (row.state?.caa ?? "pin") !== "off", addressesText: (row.state?.addresses ?? []).join("\n") };
      st.error = "";
      st.notice = "";
      paint();
    });
  });
  $("sd-direct-name-cancel")?.addEventListener("click", () => {
    st.nameDraft = null;
    paint();
  });
  $("sd-direct-name-save")?.addEventListener("click", () => {
    readNameDraft(st);
    const d = st.nameDraft;
    if (!d) return;
    void run(st, async () => {
      const r = await submitDirectName({ fqdn: st.fqdn, username: st.username, apex: directApex(st), name: d.fqdn, enabled: true, addressesText: d.addressesText, caa: d.pinCaa ? "pin" : "off" });
      if (r.ok) st.nameDraft = null;
      return r;
    });
  });
  slot.querySelectorAll("[data-dn-probe]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rowById(st, btn.getAttribute("data-dn-probe"));
      if (!row?.label) return;
      void run(st, () => submitDirectProbe({ username: st.username, label: row.label }));
    });
  });
}

/** Load and fill the slot. `body` is the server-detail answer. */
export async function wireDirectAccess(body) {
  const fqdn = String(body?.serverFqdn ?? "").toLowerCase();
  if (!fqdn || !$("direct-access-slot")) return;
  const session = getSession();
  const username = String(session?.username || body?.username || "").toLowerCase();
  const st = freshState({ fqdn, username, canManage: isAdminDevice(session) });
  current = st;
  paint();
  const loaded = await loadDirectAccess({ fqdn, username });
  if (current !== st) return;
  Object.assign(st, loaded, { loaded: true });
  paint();
}

// ---- the app page's link to share ----------------------------------------------------------------

/** The app's published direct name, or null (another account's app, or not published). */
export function publishedDirectName(state, { slug, creator, username }) {
  if (!state || String(creator ?? "").toLowerCase() !== String(username ?? "").toLowerCase()) return null;
  const fqdn = derivedDirectName(slug, creator, state.apex || DIRECT_APEX);
  return fqdn && nameStateOf(state, fqdn)?.state === "published" ? fqdn : null;
}

/** The link the owner picked: the direct one, or the relay one when there is one. */
export function directShareUrl({ published, relayUrl, choice }) {
  return choice === "relay" && relayUrl ? relayUrl : `https://${published}`;
}

/** The empty slot the app page puts under Web domains; `loadDirectLinkShare` fills it. */
export function directLinkSlotHtml() {
  return `<div id="app-direct-link-slot"></div>`;
}

/** "Link to share" with the Direct / Through the relay choice; "" when the name isn't published. */
export function directLinkHtml({ published, relayUrl, choice = "direct" }) {
  if (!published) return "";
  const pick = choice === "relay" && relayUrl ? "relay" : "direct";
  const url = directShareUrl({ published, relayUrl, choice: pick });
  const btn = (id, label) =>
    `<button type="button" class="${pick === id ? "" : "secondary"}" data-dl-choice="${id}" aria-pressed="${pick === id}">${escapeHtml(label)}</button>`;
  const note =
    pick === "direct"
      ? tr("Goes straight to your server and uses none of your relay data. It works only while your server can be reached from outside.")
      : tr("Goes through the Flagship relay. It works even when your server can't be reached from outside.");
  return `
    <div id="app-direct-link">
      <h2 class="mt-4">${escapeHtml(tr("Link to share"))}</h2>
      <div class="card">
        <div class="row-2" role="group" aria-label="${escapeHtml(tr("Link to share"))}" id="app-direct-link-choice">
          ${btn("direct", tr("Direct"))}
          ${relayUrl ? btn("relay", tr("Through the relay")) : ""}
        </div>
        <p class="note small mt-2" id="app-direct-link-note">${escapeHtml(note)}</p>
        <p class="mono mt-2" id="app-direct-link-url">${escapeHtml(url.replace(/^https:\/\//, ""))}</p>
        <button type="button" class="full-width mt-2" id="app-direct-link-share" data-url="${escapeHtml(url)}">${escapeHtml(tr("Share link"))}</button>
      </div>
    </div>`;
}

async function shareLink(url) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({ url });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(tr("Copied."));
  } catch {
    toast(tr("Couldn't copy — long-press to copy manually."), "err");
  }
}

/** Fill the app page's slot once `.com` says the app's direct name is published. `isCurrent` guards a slow answer. */
export async function loadDirectLinkShare({ username, slug, creator, relayUrl = null, isCurrent = () => true }, deps = {}) {
  if (!username) return;
  const state = await (deps.fetchState ?? ((u) => fetchDirectState(u)))(username).catch(() => null);
  const published = publishedDirectName(state, { slug, creator, username });
  if (!published || !isCurrent()) return;
  let choice = "direct";
  const draw = () => {
    const slot = $("app-direct-link-slot");
    if (!slot) return;
    slot.innerHTML = directLinkHtml({ published, relayUrl, choice });
    slot.querySelectorAll("[data-dl-choice]").forEach((b) =>
      b.addEventListener("click", () => {
        choice = b.getAttribute("data-dl-choice");
        draw();
      }),
    );
    $("app-direct-link-share")?.addEventListener("click", (ev) => void shareLink(ev.currentTarget.getAttribute("data-url")));
  };
  draw();
}
