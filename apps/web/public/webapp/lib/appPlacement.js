// Where an app runs (docs/app-placement.md): which server a new app goes to,
// which servers an app is on, and copying an app to another server.
//
//   §1 the leader is the default target (it is also made the current server)
//   §2 every creation flow shows "Runs on" with a picker, defaulting to the
//      leader; started from a server's page the server is fixed
//   §3 a server's page lists its apps, greyed "Copying…" while one arrives
//   §4 "Runs on" on the app page asks every server's apps list: a server that
//      can't be reached is unknown, never ticked
//   §5 a copy is signed by the owner and sent to the TARGET box:
//
//        flagship/app-copy/v1|<sourceServer>|<targetServer>|<serviceId>|<issuedAt ms>
//
//      with the sensitive-order key; removing a copy is the existing signed
//      uninstall (`flagship/uninstall-service/v1`) to that box.
//   §6 an app's status pill: each server's state for the app, and the
//      services list's one pill combining every server the app is on
//
// Must pass packages/protocol/test-vectors/app-copy/vectors.json.

import { boxClient, currentPodFqdn, makeCurrentPod, sessionTokenForPod } from "./api.js";
import { currentServerOrder, rankPods } from "./serverOrder.js";
import { podShortName } from "./podSwitcher.js";
import { liveSync } from "./liveSync.js";
import { controlApex } from "./apex.js";
import { escapeHtml } from "./util.js";
import { accountReadFetch } from "./accountRead.js";

export const TAG_APP_COPY = "flagship/app-copy/v1";
export const TAG_UNINSTALL_SERVICE = "flagship/uninstall-service/v1";

export const RUNS_ON_TITLE = "Runs on";
export const RUNS_ON_NOTE = "Tick a server to copy this app there as it is now. Untick one to remove the app from it.";
export const RUNS_ON_UNKNOWN = "Can't reach this server, so it isn't known whether the app is there.";
export const RUNS_ON_LAST_COPY = "This is the app's only copy, so it can't be unticked.";
export const RUNS_ON_COMPANION = "Only the owner's devices can change where this app runs.";
export const RUNS_ON_ADMIN_ONLY = "Only an admin device can change where this app runs.";
export const COPYING = "Copying…";
export const COPY_NEEDS_UPDATE = "This server needs an update to receive copies.";
export const COPY_ALREADY = "This server already has this app, or is copying it now.";
export const COPY_REFUSED = "This server refused the copy.";
export const COPY_STARTED = "Copying the app. It appears on that server when it's ready.";
export const REMOVE_CONFIRM_TITLE = "Remove from this server?";
export const CREATE_APP_HERE = "Create app here";
export const SERVER_APPS_TITLE = "Apps";
export const SERVER_NO_APPS = "No apps on this server yet.";

const RECENT_REPORT_MS = 15 * 60_000;
const COPY_UNDERWAY = new Set(["copying", "installing"]);

// ---------------------------------------------------------------------------
// The account's servers
// ---------------------------------------------------------------------------

/** A `/pods` row's FQDN, lower-cased ("" when it names none). */
export function podFqdn(pod) {
  return String(pod?.serverDomain ?? pod?.fqdn ?? "").trim().toLowerCase();
}

/** Online by `.com`'s liveness; an older `.com` without it: a recent report. */
export function isPodOnline(pod, now = Date.now()) {
  if (pod?.liveness != null) return pod.liveness === "live";
  return pod?.lastReported != null && now - pod.lastReported <= RECENT_REPORT_MS;
}

/** The account's live (non-revoked) servers, one row each. */
export function accountPods(pods) {
  const list = pods instanceof Map ? [...pods.values()] : Array.isArray(pods) ? pods : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const fqdn = podFqdn(p);
    if (!fqdn || p?.revokedAt != null || seen.has(fqdn)) continue;
    seen.add(fqdn);
    out.push(p);
  }
  return out;
}

/** The leader: the first server in the owner's order that is online
 *  (docs/server-order.md); with none online, the first that ever came up. */
export function leaderOf(pods, order = currentServerOrder(), now = Date.now()) {
  const ranked = rankPods(accountPods(pods), order);
  const up = ranked.find((p) => isPodOnline(p, now))
    ?? ranked.find((p) => p?.lastReported != null || p?.currentCert != null);
  return up ? podFqdn(up) : "";
}

/** The account's `/pods` rows: the live-sync snapshot, else one read. */
export async function loadAccountPods(username, deps = {}) {
  const snap = (deps.liveSync ?? liveSync).get?.();
  if (snap?.pods?.length) return snap.pods;
  if (!username) return [];
  try {
    const f = deps.fetch || fetch;
    const r = await accountReadFetch(`${deps.comBase || controlApex()}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" }, { fetch: f, baseUrl: deps.comBase || controlApex() });
    if (!r.ok) return [];
    const body = await r.json().catch(() => ({}));
    return Array.isArray(body?.pods) ? body.pods : [];
  } catch {
    return [];
  }
}

/** Every server this device has a session for (the account's servers plus
 *  the current one), as `{fqdn, baseUrl, token, fetchJson}`. */
export function sessionServers(pods, { current = currentPodFqdn(), clientFor = boxClient } = {}) {
  const fqdns = accountPods(pods).map(podFqdn);
  const cur = String(current ?? "").toLowerCase();
  if (cur && !fqdns.includes(cur)) fqdns.push(cur);
  return fqdns
    .map((fqdn) => {
      const c = clientFor(fqdn);
      return { fqdn, baseUrl: c.baseUrl, token: c.token(), fetchJson: c.fetch };
    })
    .filter((s) => s.token);
}

/** §1: when the leader is online and this device has a session for it, it is
 *  the current server. Resolves to whether the current server is the leader. */
export function preferLeaderAsCurrent(pods, deps = {}) {
  const leader = leaderOf(pods, deps.order, deps.now?.());
  if (!leader) return false;
  const pod = accountPods(pods).find((p) => podFqdn(p) === leader);
  const hasSession = deps.hasSession || ((fqdn) => !!sessionTokenForPod(fqdn));
  if (!pod || !isPodOnline(pod, deps.now?.()) || !hasSession(leader)) return false;
  return (deps.makeCurrentPod || makeCurrentPod)(leader);
}

// ---------------------------------------------------------------------------
// §2 Choosing where a new app runs
// ---------------------------------------------------------------------------

let creation = { fqdn: "", pinned: false };

/** Begin a creation flow: from a server's page `server` is fixed (`pinned`);
 *  otherwise the picker starts on the default. */
export function startCreation({ server = "", pinned = false } = {}) {
  const fqdn = typeof server === "string" ? server.trim().toLowerCase() : "";
  creation = { fqdn, pinned: !!fqdn && pinned === true };
}

/** `{fqdn, pinned}` of the flow under way ("" until one is resolved). */
export function creationTarget() {
  return { ...creation };
}

/** The owner picked another server; a pinned flow ignores it. */
export function chooseCreationServer(fqdn) {
  if (creation.pinned) return;
  creation = { fqdn: String(fqdn ?? "").trim().toLowerCase(), pinned: false };
}

/** The servers a new app could go to: the account's servers (plus the current
 *  one when `/pods` doesn't list it, e.g. the demo box), sorted by name. A
 *  server is selectable when it's online and this device has a session. */
export function creationServers(pods, deps = {}) {
  const hasSession = deps.hasSession || ((fqdn) => !!sessionTokenForPod(fqdn));
  const current = String(deps.current ?? currentPodFqdn()).toLowerCase();
  const now = deps.now?.() ?? Date.now();
  const leader = leaderOf(pods, deps.order, now);
  const rows = accountPods(pods).map((p) => ({ fqdn: podFqdn(p), online: isPodOnline(p, now) }));
  if (current && !rows.some((r) => r.fqdn === current)) rows.push({ fqdn: current, online: true });
  return rows
    .map((r) => {
      const session = hasSession(r.fqdn);
      return {
        fqdn: r.fqdn,
        name: podShortName(r.fqdn),
        online: r.online,
        hasSession: session,
        selectable: r.online && session,
        isLeader: r.fqdn === leader,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.fqdn.localeCompare(b.fqdn));
}

/** The default: the leader when it's selectable, else the current server,
 *  else the first selectable one. */
export function defaultCreationServer(servers, current = currentPodFqdn()) {
  const leader = servers.find((s) => s.isLeader && s.selectable);
  if (leader) return leader.fqdn;
  const cur = String(current ?? "").toLowerCase();
  const curRow = servers.find((s) => s.fqdn === cur && s.hasSession);
  if (curRow) return curRow.fqdn;
  return servers.find((s) => s.selectable)?.fqdn ?? cur;
}

/** Pick the flow's server now if it has none yet. Resolves to its FQDN. */
export function resolveCreationServer(servers, current = currentPodFqdn()) {
  if (!creation.fqdn) creation = { fqdn: defaultCreationServer(servers, current), pinned: false };
  return creation.fqdn;
}

/** What the picker shows: a fixed line when pinned or there's one server,
 *  else a select of every server (unselectable ones disabled, with why). */
export function creationPickerModel(servers, target = creationTarget()) {
  const selected = target.fqdn;
  const known = servers.some((s) => s.fqdn === selected);
  const options = (known || !selected ? servers : [...servers, { fqdn: selected, name: podShortName(selected), selectable: true, online: true, hasSession: true, isLeader: false }])
    .map((s) => ({
      fqdn: s.fqdn,
      name: s.name,
      selected: s.fqdn === selected,
      disabled: !s.selectable && s.fqdn !== selected,
      note: !s.online ? "offline" : !s.hasSession ? "not paired with this device" : s.isLeader ? "leader" : "",
    }));
  return {
    pinned: target.pinned,
    selected,
    selectedName: selected ? podShortName(selected) : "",
    options,
    choosable: !target.pinned && options.filter((o) => !o.disabled).length > 1,
  };
}

export function creationPickerHtml(model) {
  if (!model.selected) {
    return `<p class="note runs-on-line" data-runs-on>${escapeHtml(RUNS_ON_TITLE)}: no server you can build on is online.</p>`;
  }
  if (!model.choosable) {
    return `<p class="note runs-on-line" data-runs-on>${escapeHtml(RUNS_ON_TITLE)}: <strong>${escapeHtml(model.selectedName)}</strong></p>`;
  }
  const opts = model.options
    .map((o) =>
      `<option value="${escapeHtml(o.fqdn)}"${o.selected ? " selected" : ""}${o.disabled ? " disabled" : ""}>` +
      `${escapeHtml(o.name)}${o.note ? ` (${escapeHtml(o.note)})` : ""}</option>`)
    .join("");
  return `<label class="field runs-on-line" data-runs-on>
      <span class="field-label">${escapeHtml(RUNS_ON_TITLE)}</span>
      <select data-runs-on-select aria-label="${escapeHtml(RUNS_ON_TITLE)}">${opts}</select>
    </label>`;
}

/**
 * Paint the picker into `el` and keep the flow's server in step with it.
 * Resolves to the chosen FQDN; `onChange(fqdn)` fires when the owner picks
 * another server.
 */
export async function mountCreationPicker(el, { username = "", onChange = () => {}, deps = {} } = {}) {
  const pods = await loadAccountPods(username, deps);
  const servers = creationServers(pods, deps);
  const fqdn = resolveCreationServer(servers, deps.current ?? currentPodFqdn());
  if (!el) return fqdn;
  el.innerHTML = creationPickerHtml(creationPickerModel(servers));
  el.querySelector("[data-runs-on-select]")?.addEventListener("change", (e) => {
    chooseCreationServer(e.target.value);
    onChange(creationTarget().fqdn);
  });
  return fqdn;
}

// ---------------------------------------------------------------------------
// §5 Copying an app: the signed grant, sent to the target box
// ---------------------------------------------------------------------------

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fieldGuard(tag, name, v) {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${tag}: empty ${name}`);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error(`${tag}: bad character in ${name}`);
  }
}

function issuedAtGuard(tag, issuedAt) {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error(`${tag}: bad issuedAt`);
}

export function canonicalAppCopyBytes({ sourceServer, targetServer, serviceId, issuedAt }) {
  fieldGuard("app-copy", "sourceServer", sourceServer);
  fieldGuard("app-copy", "targetServer", targetServer);
  fieldGuard("app-copy", "serviceId", serviceId);
  issuedAtGuard("app-copy", issuedAt);
  return new TextEncoder().encode([TAG_APP_COPY, sourceServer, targetServer, serviceId, String(issuedAt)].join("|"));
}

/** Resolves to the POST body `{grant, signature}`. */
export async function signAppCopy({ sourceServer, targetServer, serviceId, issuedAt, umk, signWithIrk, bytesToHex = toHex }) {
  const grant = { sourceServer, targetServer, serviceId, issuedAt };
  const sig = await signWithIrk(umk, canonicalAppCopyBytes(grant));
  return { grant, signature: bytesToHex(sig) };
}

/** Sign the copy and POST it to the target box. Resolves to `{copyId}`. */
export async function requestAppCopy({ sourceServer, targetServer, serviceId, umk, signWithIrk, clientFor = boxClient, now = Date.now }) {
  if (!umk) throw new Error("unlock the webapp first");
  const body = await signAppCopy({ sourceServer, targetServer, serviceId, issuedAt: now(), umk, signWithIrk });
  const r = await clientFor(targetServer).fetch("/api/screens/services/copy", { method: "POST", body: JSON.stringify(body) });
  return { copyId: typeof r?.copyId === "string" ? r.copyId : null };
}

function boxSays(e) {
  const reason = e?.body && typeof e.body === "object" ? e.body.error : null;
  return typeof reason === "string" && reason ? reason : null;
}

/** The owner-facing words for a refused copy. */
export function copyErrorMessage(e) {
  if (e?.status === 404) return COPY_NEEDS_UPDATE;
  if (e?.status === 409) return COPY_ALREADY;
  if (e?.status === 403) {
    const why = boxSays(e);
    return why ? `${COPY_REFUSED} ${why}` : `${COPY_REFUSED} Check this device's clock and try again.`;
  }
  if (e?.status === 400) return boxSays(e) ?? "This server couldn't read the copy request.";
  if (e?.status === 0) return "This device isn't paired with that server.";
  return boxSays(e) ?? (e instanceof Error ? e.message : String(e));
}

/** The copy's source: the server whose page this is when it has the app,
 *  else the first server that has it. */
export function chooseCopySource(rows, prefer = "") {
  const want = String(prefer ?? "").toLowerCase();
  const has = rows.filter((r) => r.state === "has");
  return (has.find((r) => r.fqdn === want) ?? has[0])?.fqdn ?? "";
}

// ---------------------------------------------------------------------------
// Removing a copy: the existing signed uninstall, to that box
// ---------------------------------------------------------------------------

/** `<creator>--<slug>` (docs/service-addressing-double-dash.md). */
export function splitServiceId(serviceId) {
  const id = String(serviceId ?? "");
  const at = id.indexOf("--");
  return at > 0 ? { creator: id.slice(0, at), slug: id.slice(at + 2) } : null;
}

export function canonicalUninstallServiceBytes({ serverId, creator, slug, issuedAt }) {
  fieldGuard("uninstall-service", "serverId", serverId);
  fieldGuard("uninstall-service", "creator", creator);
  fieldGuard("uninstall-service", "slug", slug);
  issuedAtGuard("uninstall-service", issuedAt);
  return new TextEncoder().encode([TAG_UNINSTALL_SERVICE, serverId, creator, slug, String(issuedAt)].join("|"));
}

export const REMOVE_APP_LABEL = "Remove app";
export const REMOVE_APP_BUSY = "Removing…";
export const REMOVE_APP_TITLE = "Remove this app?";

/** The confirmation's words: what goes, where, and what stays. */
export function removeAppMessage({ slug, server, otherCopies = 0 }) {
  const where = server ? ` from ${server}` : "";
  const rest = otherCopies > 0
    ? ` Your ${otherCopies === 1 ? "other server keeps its copy" : `other ${otherCopies} servers keep their copies`}.`
    : "";
  return `This uninstalls ${slug}${where} and deletes its data there. This can't be undone.${rest}`;
}

/** The owner-facing words for a refused uninstall. */
export function removeAppErrorMessage(e) {
  if (e?.status === 0) return "This device isn't paired with that server.";
  if (e?.status === 403) return boxSays(e) ?? "The server refused the request. Check this device's clock and try again.";
  return boxSays(e) ?? (e instanceof Error && e.message ? e.message : "Couldn't remove the app. Try again in a moment.");
}

/** Sign the uninstall for `serverFqdn` and DELETE it there. */
export async function removeAppFromServer({ serverFqdn, serviceId, creator, slug, umk, signWithIrk, clientFor = boxClient, now = Date.now, bytesToHex = toHex }) {
  if (!umk) throw new Error("unlock the webapp first");
  const parts = creator && slug ? { creator, slug } : splitServiceId(serviceId);
  if (!parts) throw new Error("couldn't tell which app to remove");
  const request = { serverId: serverFqdn, creator: parts.creator, slug: parts.slug, issuedAt: now() };
  const signature = bytesToHex(await signWithIrk(umk, canonicalUninstallServiceBytes(request)));
  return clientFor(serverFqdn).fetch(`/api/services/${encodeURIComponent(serviceId)}`, {
    method: "DELETE",
    body: JSON.stringify({ request, signature }),
  });
}

// ---------------------------------------------------------------------------
// §4 Runs on, honestly
// ---------------------------------------------------------------------------

function readCopying(c) {
  if (!c || typeof c !== "object") return null;
  const state = typeof c.state === "string" ? c.state : "copying";
  if (!COPY_UNDERWAY.has(state)) return null;
  return { state, progress: typeof c.progress === "number" && Number.isFinite(c.progress) ? c.progress : null };
}

/**
 * Ask every server whether it has the app. Each row is `{fqdn, name, state}`:
 * "has", "missing", "copying" (with `copying`), or "unknown" when the server
 * couldn't be asked (no session here, offline, an error).
 */
export async function fetchRunsOn({ serviceId, pods, current = currentPodFqdn(), clientFor = boxClient, hasSession = (f) => !!sessionTokenForPod(f) }) {
  const fqdns = accountPods(pods).map(podFqdn);
  const cur = String(current ?? "").toLowerCase();
  if (cur && !fqdns.includes(cur)) fqdns.push(cur);
  const rows = await Promise.all(
    fqdns.map(async (fqdn) => {
      const row = { fqdn, name: podShortName(fqdn), state: "unknown", copying: null };
      if (!hasSession(fqdn)) return row;
      try {
        const body = await clientFor(fqdn).fetch("/api/screens/apps-list");
        const apps = Array.isArray(body?.apps) ? body.apps : null;
        if (!apps) return row;
        const app = apps.find((a) => a?.serviceId === serviceId);
        const copying = readCopying(app?.copying);
        if (copying) return { ...row, state: "copying", copying };
        if (app?.activity?.kind === "copying") return { ...row, state: "copying", copying: { state: "copying", progress: null } };
        return app ? { ...row, state: "has", appState: appServerState(app) } : { ...row, state: "missing" };
      } catch {
        return row;
      }
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.fqdn.localeCompare(b.fqdn));
}

/** What each checkbox shows. A companion only sees; the only copy can't be
 *  unticked; an unknown server is never ticked and can't be changed. */
export function runsOnModel(rows, { companion = false, busy = "", busyChecked = null } = {}) {
  const copies = rows.filter((r) => r.state === "has").length;
  return rows.map((r) => {
    const checked = r.fqdn === busy && typeof busyChecked === "boolean" ? busyChecked : r.state === "has" || r.state === "copying";
    let disabled = companion || r.state === "unknown" || r.state === "copying" || r.fqdn === busy;
    let note = "";
    if (r.state === "unknown") note = RUNS_ON_UNKNOWN;
    else if (r.state === "copying") note = copyingText(r.copying);
    else if (r.state === "has" && copies <= 1) {
      disabled = true;
      note = RUNS_ON_LAST_COPY;
    }
    return { ...r, checked, disabled, note };
  });
}

export function runsOnHtml(model, { companion = false, adminOnly = false, error = "" } = {}) {
  const rows = model
    .map((r) =>
      `<label class="inline-check runs-on-row${r.state === "unknown" ? " is-unknown" : ""}" data-runs-on-fqdn="${escapeHtml(r.fqdn)}">
        <input type="checkbox" data-runs-on-toggle="${escapeHtml(r.fqdn)}"${r.checked ? " checked" : ""}${r.disabled ? " disabled" : ""} />
        <span><strong>${escapeHtml(r.name)}</strong>${r.state === "unknown" ? ' <span class="pill">unknown</span>' : ""}${r.state === "has" ? appStatePillHtml(r.appState) : ""}
        ${r.note ? `<span class="faint-sm runs-on-note">${escapeHtml(r.note)}</span>` : ""}</span>
      </label>`)
    .join("");
  return `
      <h2 class="mt-4">${escapeHtml(RUNS_ON_TITLE)}</h2>
      <div class="card" id="sd-runs-on-card">
        <p class="note">${escapeHtml(companion ? RUNS_ON_COMPANION : adminOnly ? RUNS_ON_ADMIN_ONLY : RUNS_ON_NOTE)}</p>
        ${rows || '<p class="faint-sm">Checking your servers…</p>'}
        ${error ? `<p class="err-text mt-2" data-runs-on-error>${escapeHtml(error)}</p>` : ""}
      </div>`;
}

export const NO_COPY_SOURCE = "None of the servers with this app can be reached to copy it from.";

/**
 * The owner ticked or unticked `fqdn` on the app page. Ticking signs a copy
 * and sends it to that server; unticking (after `confirmRemove`) signs the
 * uninstall for it. The only copy is never removed. Resolves to the new rows
 * plus `message` / `error` for the owner.
 */
export async function changeRunsOn({ rows, fqdn, checked, app, current = currentPodFqdn(), umk, signWithIrk, clientFor = boxClient, confirmRemove = async () => true, now = Date.now }) {
  const row = rows.find((r) => r.fqdn === fqdn);
  if (!row) return { rows };
  const set = (state, copying = null) => rows.map((r) => (r.fqdn === fqdn ? { ...r, state, copying } : r));
  if (checked) {
    if (row.state === "has" || row.state === "copying") return { rows };
    const source = chooseCopySource(rows, current);
    if (!source) return { rows, error: NO_COPY_SOURCE };
    try {
      await requestAppCopy({ sourceServer: source, targetServer: fqdn, serviceId: app.serviceId, umk, signWithIrk, clientFor, now });
    } catch (e) {
      return { rows, error: copyErrorMessage(e) };
    }
    return { rows: set("copying", { state: "copying", progress: null }), message: COPY_STARTED };
  }
  if (row.state !== "has") return { rows };
  if (rows.filter((r) => r.state === "has").length <= 1) return { rows, error: RUNS_ON_LAST_COPY };
  if (!(await confirmRemove(row))) return { rows };
  try {
    await removeAppFromServer({ serverFqdn: fqdn, serviceId: app.serviceId, creator: app.creator, slug: app.slug, umk, signWithIrk, clientFor, now });
  } catch (e) {
    return { rows, error: boxSays(e) ?? (e instanceof Error ? e.message : String(e)) };
  }
  return { rows: set("missing"), message: `Removed from ${row.name}.` };
}

// ---------------------------------------------------------------------------
// §3 A server's apps, with the copies arriving on it
// ---------------------------------------------------------------------------

/** `GET /api/screens/services/copies` → the copies; [] on an older box. */
export async function fetchCopies(fetchJson) {
  try {
    const body = await fetchJson("/api/screens/services/copies");
    return (Array.isArray(body?.copies) ? body.copies : []).filter((c) => c && typeof c === "object" && typeof c.serviceId === "string");
  } catch (e) {
    if (e?.status === 404) return [];
    throw e;
  }
}

export function copyingText(copying) {
  const p = copying?.progress;
  if (typeof p !== "number" || !Number.isFinite(p)) return COPYING;
  const pct = Math.max(0, Math.min(100, Math.round(p <= 1 ? p * 100 : p)));
  return `${COPYING} ${pct}%`;
}

/** The server page's rows: its apps, and the copies still arriving (from the
 *  apps list's `copying`, or the copies list when the app isn't listed yet). */
export function serverAppRows(apps, copies = []) {
  const rows = [];
  const seen = new Set();
  for (const a of Array.isArray(apps) ? apps : []) {
    const id = typeof a?.serviceId === "string" ? a.serviceId : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      serviceId: id,
      name: a.slug || id,
      url: typeof a.url === "string" ? a.url : "",
      status: typeof a.status === "string" ? a.status : "",
      state: appServerState(a),
      copying: readCopying(a.copying),
    });
  }
  for (const c of copies) {
    const copying = readCopying(c);
    if (!copying || seen.has(c.serviceId)) continue;
    seen.add(c.serviceId);
    rows.push({ serviceId: c.serviceId, name: c.appName || c.serviceId, url: "", status: "", state: "copying", copying });
  }
  return rows;
}

export const anyCopying = (rows) => rows.some((r) => r.copying);

export function serverAppsHtml(rows, { error = "", loading = false, canCreate = true } = {}) {
  const list = loading
    ? '<p class="faint-sm">Loading…</p>'
    : error
      ? `<p class="err-text">${escapeHtml(error)}</p>`
      : rows.length === 0
        ? `<p class="faint-sm">${escapeHtml(SERVER_NO_APPS)}</p>`
        : rows
            .map((r) =>
              r.copying
                ? `<div class="fs-listrow server-app-row is-copying" aria-disabled="true" data-copying-app="${escapeHtml(r.serviceId)}">
                    <span class="weight-600">${escapeHtml(r.name)}</span>
                    <span class="muted-sm">${escapeHtml(copyingText(r.copying))}</span>
                  </div>`
                : `<button type="button" class="fs-listrow server-app-row" data-open-app="${escapeHtml(r.serviceId)}">
                    <span class="weight-600">${escapeHtml(r.name)}</span>
                    ${r.url ? `<span class="muted-sm mono text-xs truncate">${escapeHtml(r.url.replace(/^https?:\/\//, ""))}</span>` : ""}
                    ${appStatePillHtml(r.state)}
                  </button>`)
            .join("");
  return `
      <h2 class="mt-4">${escapeHtml(SERVER_APPS_TITLE)}</h2>
      <div class="card" id="server-apps-card">
        <div id="server-apps-list">${list}</div>
        ${canCreate ? `<button id="server-create-app" class="full-width mt-2">${escapeHtml(CREATE_APP_HERE)}</button>` : ""}
      </div>`;
}

/** The server's rows: its apps list plus its copies. */
export async function fetchServerApps(fetchJson) {
  const [list, copies] = await Promise.all([fetchJson("/api/screens/apps-list"), fetchCopies(fetchJson).catch(() => [])]);
  return serverAppRows(list?.apps ?? [], copies);
}

/**
 * Re-read while a copy is under way and the page is on screen. `active()`
 * says whether the page is still showing; a hidden tab waits for visibility.
 * Returns stop().
 */
export function watchWhileCopying({ load, onRows, active, intervalMs = 3000, doc = globalThis.document, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let stopped = false;
  let waiting = null;
  const visible = () => !doc || doc.visibilityState !== "hidden";
  const stop = () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (waiting) doc?.removeEventListener?.("visibilitychange", waiting);
    waiting = null;
  };
  const tick = async () => {
    timer = null;
    if (stopped || !active()) return stop();
    if (!visible()) {
      waiting = () => {
        if (!visible()) return;
        doc.removeEventListener("visibilitychange", waiting);
        waiting = null;
        void tick();
      };
      doc.addEventListener?.("visibilitychange", waiting);
      return;
    }
    let rows;
    try {
      rows = await load();
    } catch {
      rows = null;
    }
    if (stopped || !active()) return stop();
    if (rows) onRows(rows);
    if (rows && !anyCopying(rows)) return stop();
    timer = setTimer(tick, intervalMs);
  };
  timer = setTimer(tick, intervalMs);
  return stop;
}

// ---------------------------------------------------------------------------
// §6 An app's status pill
// ---------------------------------------------------------------------------

export const APP_STATE_LABELS = {
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  deploying: "Deploying",
  copying: "Copying",
  editing: "Editing",
};
export const PILL_DEPLOYING = "Deploying";
export const PILL_EDITING = "Editing";
export const PILL_STOPPED = "Stopped";
export const PILL_UNREACHABLE = "Can't reach";
export const UNREACHABLE = "unreachable";

const ACTIVITY_KINDS = new Set(["deploying", "copying", "editing"]);
const RUN_STATES = new Set(["running", "starting", "stopped"]);

/** One server's state for an app, from its apps-list row or app-detail app:
 *  what's working on it (`activity`, or a copy still arriving), else its
 *  `status`. An older box sends only "unknown". */
export function appServerState(app) {
  const kind = app?.activity?.kind;
  if (ACTIVITY_KINDS.has(kind)) return kind;
  if (readCopying(app?.copying)) return "copying";
  return RUN_STATES.has(app?.status) ? app.status : "unknown";
}

/** "Running", "Deploying"…; "" for unknown. */
export function appStateLabel(state) {
  return APP_STATE_LABELS[state] ?? "";
}

function pillTone(state) {
  if (state === "running" || state === "on") return " ok";
  if (state === "deploying" || state === "copying" || state === "editing" || state === "starting") return " accent";
  return "";
}

/** One server's state as a pill ("" when unknown). */
export function appStatePillHtml(state) {
  const label = appStateLabel(state);
  return label ? ` <span class="pill${pillTone(state)}" data-app-state="${escapeHtml(state)}">${escapeHtml(label)}</span>` : "";
}

/**
 * The services list's pill for an app, from each server it's on: `states`
 * holds one `appServerState` per server that lists the app, or UNREACHABLE
 * for a server that couldn't be asked. Resolves to `{kind, label, count}`:
 *   any deploying/copying → Deploying; else any editing → Editing; else
 *   N running/starting → On N servers; else every answer stopped → Stopped;
 *   else nobody answered → Can't reach.
 * "unknown" (an older box) is on that server but not running; when no server
 * runs it and some say unknown, those are counted as "On N servers", never
 * read as stopped.
 */
export function combineAppStatus(states) {
  const list = (Array.isArray(states) ? states : []).filter((s) => s !== UNREACHABLE && s != null);
  if (list.some((s) => s === "deploying" || s === "copying")) return { kind: "deploying", label: PILL_DEPLOYING, count: 0 };
  if (list.includes("editing")) return { kind: "editing", label: PILL_EDITING, count: 0 };
  const running = list.filter((s) => s === "running" || s === "starting").length;
  const unknown = list.filter((s) => !RUN_STATES.has(s)).length;
  const count = running || unknown;
  if (count) return { kind: "on", label: count === 1 ? "On 1 server" : `On ${count} servers`, count };
  if (list.length) return { kind: "stopped", label: PILL_STOPPED, count: 0 };
  return { kind: "unreachable", label: PILL_UNREACHABLE, count: 0 };
}

export function appStatusPillHtml(status) {
  return `<span class="pill${pillTone(status.kind)}" data-app-status="${escapeHtml(status.kind)}">${escapeHtml(status.label)}</span>`;
}

/**
 * The services list's rows: one per app (the same serviceId on every server),
 * from each server's apps list `{fqdn, apps}` (`apps: null` when the server
 * couldn't be asked). Each row opens on the leader's copy when it has a
 * settled one, else on the first server that lists it; it carries that copy's
 * fields, `listedBy` (that server), `servers` (every server listing it) and
 * the combined `appStatus`.
 */
export function mergeAppsAcrossServers(lists, leader = "") {
  const want = String(leader ?? "").toLowerCase();
  const byId = new Map();
  for (const { fqdn, apps } of Array.isArray(lists) ? lists : []) {
    for (const app of Array.isArray(apps) ? apps : []) {
      const id = typeof app?.serviceId === "string" ? app.serviceId : "";
      if (!id) continue;
      const entry = byId.get(id) ?? byId.set(id, { copies: [] }).get(id);
      if (entry.copies.some((c) => c.fqdn === fqdn)) continue;
      entry.copies.push({ fqdn, app, state: appServerState(app) });
    }
  }
  return [...byId.values()].map(({ copies }) => {
    const settled = copies.filter((c) => !readCopying(c.app?.copying));
    const pick =
      settled.find((c) => c.fqdn === want) ?? settled[0] ?? copies.find((c) => c.fqdn === want) ?? copies[0];
    return {
      ...pick.app,
      listedBy: pick.fqdn,
      servers: copies.map((c) => c.fqdn),
      appStatus: combineAppStatus(copies.map((c) => c.state)),
    };
  });
}

/**
 * What the server page says about the sandbox apps run in (gVisor,
 * docs/app-runtimes.md §5.1), or null when there's nothing to say.
 */
export function appSandboxNotice(sandbox) {
  if (sandbox?.state === "unavailable") {
    return {
      tone: "danger",
      text: `Apps can't start on this server: the sandbox they run in isn't working (${sandbox.reason}). The server tries again every 10 minutes.`,
    };
  }
  if (sandbox?.state === "starting") {
    return { tone: "muted", text: "Setting up the sandbox apps run in. They start once it's ready." };
  }
  return null;
}
