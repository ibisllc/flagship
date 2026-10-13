// P2.1 — server-detail view. Calls /api/screens/server-detail (P1.1).
// Also hosts the per-server "auto-unlock" toggle (auto_unlock_lease_design.md)
// and the P13 per-server kill-switch danger zone.

import { $, registerView, show } from "../lib/router.js";
import { ScreensError, boxClient } from "../lib/api.js";
import { appSandboxNotice, fetchServerApps, serverAppsHtml, anyCopying, watchWhileCopying } from "../lib/appPlacement.js";
import { isCompanionProfile } from "../lib/companionGuard.js";
import {
  enableLongLived,
  listLeases,
  revokeLease,
} from "../lib/leases.js";
import {
  countdownConfirm,
  revokeServer,
  unrevokeServer,
  REVOCATION_REASONS,
} from "../lib/revokeServer.js";
import {
  findPod,
  isListableRevocation,
  openDeleteServerDialog,
  serverLabelOf,
} from "../lib/deleteServer.js";
import { controlApex } from "../lib/apex.js";
import {
  sendPowerOff,
  setDeadManPolicy,
  affirmDeadMan,
  DEADMAN_WINDOW_PRESETS,
  DEADMAN_TIGHTEN_PRESET,
  DEADMAN_DEFAULT_PRESET,
  fmtRemaining,
} from "../lib/lockAndPower.js";
import { getPodBaseUrl } from "../lib/api.js";
import {
  getFrontPage,
  listFrontPageOptions,
  sendSetFrontPage,
} from "../lib/frontPage.js";
import {
  fetchJournal,
  JOURNAL_UNITS,
  JOURNAL_DEFAULT_UNIT,
  JOURNAL_DEFAULT_LINES,
} from "../lib/journal.js";
import { signWithIrk, bytesToHex } from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { setPreferredServer, isPreferredServer } from "../lib/setLeader.js";
import {
  clearPendingUpdate,
  describeLastUpdate,
  groupReleases,
  loadReleaseCatalog,
  orderServerUpdate,
  readPendingUpdate,
  reconcilePendingUpdate,
  renderPendingUpdate,
  COMMIT_SHA_RE,
  DOWNGRADE_WARNING,
  PENDING_UPDATE_POLL_MS,
} from "../lib/serverUpdate.js";
import {
  createTransferOffer,
  buildTransferLink,
  pollTransferClaim,
  depositRehomeAuth,
} from "../lib/serverTransfer.js";
import {
  runGiverAdminHandoff,
  watchClaimThenHandoff,
} from "../lib/adminRootTransfer.js";
import {
  resolveReplacementContext,
  preflightGate,
  runReplacement,
  DISK_DISPOSITIONS,
  DEFAULT_DISPOSITION,
} from "../lib/serverReplacement.js";
import {
  startMigration,
  fetchMigration,
  confirmMigrationReady,
  freezeMigration,
  abortMigration,
  setMigrationHold,
  clearMigrationHold,
  migrationSteps,
  migrationWaitCopy,
  MIGRATION_DISPOSITIONS,
  DEFAULT_MIGRATION_DISPOSITION,
} from "../lib/serverMigration.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { inlineConfirm } from "../lib/modal.js";
import { formatWhen } from "../lib/dateFormat.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { liveSync } from "../lib/liveSync.js";
import { serverHealthVerdict, healthForServer, renderHealthCard } from "../lib/serverHealth.js";

registerView("view-server-detail");

function fmtUptime(ms) {
  if (typeof ms !== "number" || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

function fmtDate(unixMs) {
  if (typeof unixMs !== "number") return "—";
  return formatWhen(unixMs);
}

// Short display form of the box-reported HEAD (or "—" while unknown —
// e.g. an un-reburned box whose daemon predates the currentCommit field).
function shortCommit(sha) {
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 8) : "—";
}

// Every read and order on this page goes to the server it shows, through that
// box's own session: viewing a server never moves the current one.
const fetchOn = (fqdn) => (...args) => boxClient(fqdn).fetch(...args);
const baseOf = (body) => boxClient(body?.serverFqdn ?? "").baseUrl;

/** The host of the active pod base URL, when the page was opened without an
 *  explicit server. */
function activePodFqdn() {
  try {
    const base = getPodBaseUrl();
    return base ? new URL(base).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** This server's `/pods` entry: the LiveSync snapshot when it has one, else a
 *  one-shot read. Null when `.com` can't be reached or doesn't list it. */
async function lookupPod(username, fqdn) {
  if (!fqdn) return null;
  const snapPods = liveSync.get?.()?.pods;
  const fromSnap = findPod(snapPods, fqdn);
  if (fromSnap) return fromSnap;
  if (!username) return null;
  try {
    const r = await fetch(`${controlApex()}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" });
    if (!r.ok) return null;
    const body = await r.json().catch(() => ({}));
    return findPod(body.pods, fqdn);
  } catch {
    return null;
  }
}

/** Revoked as lost / stolen / decommissioned, i.e. the state Un-revoke undoes.
 *  An older Worker sends no `revocationReason`; `.com` refuses (409) if it
 *  isn't restorable after all. */
export function isRestorableRevokedPod(pod) {
  if (pod?.revokedAt == null) return false;
  return pod.revocationReason === undefined || isListableRevocation(pod.revocationReason);
}

/**
 * The Danger zone card. None of its actions need the box, so it renders on the
 * offline / failed-to-load page too.
 *
 * @param {{ serverFqdn: string, username: string, revoked: boolean }} o
 */
export function renderDangerZoneCard({ serverFqdn, username, revoked }) {
  const label = serverLabelOf(serverFqdn);
  const revokeBlock = revoked
    ? `
        <p class="note">
          Revoked: this server can't connect or unlock until you un-revoke it.
          Its name stays reserved.
        </p>
        <button id="unrevoke-server-btn" class="full-width mt-2">Un-revoke server</button>`
    : `
        <p class="note">
          Locks this server out right away: it can't connect or unlock until you
          un-revoke it. Its name stays reserved. Use this if the box is lost or
          stolen.
        </p>
        <button id="revoke-server-btn" class="danger full-width mt-2">Revoke server (reversible)</button>`;
  return `
      <h2 class="mt-4">Danger zone</h2>
      <div class="card" id="danger-zone-card" data-server-fqdn="${escapeHtml(serverFqdn)}" data-username="${escapeHtml(username)}">
        ${revokeBlock}
        <p class="note mt-3">
          Deletes <strong>${escapeHtml(label)}</strong> for good. If the box is
          online it erases its data and powers off; if it's offline it can never
          come back online. The name becomes free to reuse.
        </p>
        <button id="delete-server-btn" class="danger full-width mt-2">Delete server</button>
      </div>`;
}

/** The page when the box's own screen didn't load (offline, never came online,
 *  revoked, or no paired session): what we know from `.com`, plus the actions
 *  that don't need the box. */
export function renderUnreachableDetail({ serverFqdn, username, revoked, message }) {
  const status = revoked
    ? "This server is revoked. It can't connect or unlock until you un-revoke it."
    : `Couldn't reach this server${message ? ` (${message})` : ""}. You can still revoke or delete it below.`;
  return `
      <div class="card">
        <div class="row"><span class="label">FQDN</span><span class="value">${escapeHtml(serverFqdn)}</span></div>
        <p class="${revoked ? "note" : "err-text"} mt-2" data-detail-unreachable>${escapeHtml(status)}</p>
      </div>
      ${renderDangerZoneCard({ serverFqdn, username, revoked })}`;
}

// Bumped on every render: a slow answer from the server shown before must not
// paint over the one now open.
let renderSeq = 0;

export async function renderServerDetail() {
  const seq = ++renderSeq;
  const root = $("server-detail-content");
  root.innerHTML = skeletonCards(2);
  startHealthWatch(detailFqdn);
  const session = getSession();
  const knownFqdn = detailFqdn || activePodFqdn();
  const titleEl = $("server-detail-title");
  if (titleEl) titleEl.textContent = (knownFqdn || "").split(".")[0] || "Server";
  const podPromise = lookupPod(session?.username, knownFqdn);
  let body;
  try {
    body = await fetchOn(knownFqdn)("/api/screens/server-detail");
  } catch (e) {
    if (seq !== renderSeq) return;
    if (!knownFqdn) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(e))}</p></div>`;
      return;
    }
    const pod = await podPromise;
    if (seq !== renderSeq) return;
    const username = session?.username || "";
    const revoked = isRestorableRevokedPod(pod);
    root.innerHTML = renderUnreachableDetail({
      serverFqdn: knownFqdn,
      username,
      revoked,
      message: e?.status === 0 ? "this device isn't paired with it yet" : e instanceof ScreensError ? e.message : humanError(e),
    });
    wireDangerZone(knownFqdn, username, { revoked, pod });
    return;
  }
  const lookedUp = await podPromise;
  if (seq !== renderSeq) return;
  try {
    // Only trust a `/pods` row for the box that answered.
    const detailPod = findPod(lookedUp ? [lookedUp] : [], body?.serverFqdn);
    if (!detailFqdn && body?.serverFqdn) startHealthWatch(body.serverFqdn);
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">FQDN</span><span class="value">${escapeHtml(body.serverFqdn)}</span></div>
        <div class="row"><span class="label">Username</span><span class="value">${escapeHtml(body.username)}</span></div>
        <div class="row"><span class="label">Daemon</span><span class="value">${escapeHtml(body.daemonVersion)}</span></div>
        <div class="row"><span class="label">Version</span><span class="value">${escapeHtml(shortCommit(body.currentCommit))}</span></div>
        <div class="row"><span class="label">Uptime</span><span class="value">${escapeHtml(fmtUptime(body.uptimeMs))}</span></div>
      </div>
      <h2 class="mt-4">Cert</h2>
      <div class="card">
        <div class="row"><span class="label">Not after</span><span class="value">${escapeHtml(fmtDate(body.certNotAfter))}</span></div>
        <div class="row"><span class="label">SANs</span><span class="value text-xs">${escapeHtml((body.certSans ?? []).join(", ") || "—")}</span></div>
      </div>
      <h2 class="mt-4">Counters</h2>
      <div class="card">
        <div class="row"><span class="label">Apps installed</span><span class="value">${body.serviceCount}</span></div>
        <div class="row"><span class="label">Paired sessions</span><span class="value">${body.pairedSessionCount}</span></div>
      </div>
      ${(() => {
        const n = appSandboxNotice(body.appSandbox);
        if (!n) return "";
        return n.tone === "danger"
          ? `<div class="card warning mt-4" id="app-sandbox-notice"><p class="warn-text">${escapeHtml(n.text)}</p></div>`
          : `<p class="note mt-4" id="app-sandbox-notice">${escapeHtml(n.text)}</p>`;
      })()}
      <div id="server-apps">${serverAppsHtml([], { loading: true, canCreate: !isCompanionProfile() })}</div>
      <h2 class="mt-4">Auto-unlock</h2>
      <div class="card" id="auto-unlock-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          Off by default — every reboot waits for you. Turn on a long-lived
          lease to let this server reboot freely (power blips, kernel
          updates) for up to a week. If you go offline longer than the
          lease, the next reboot waits for you again.
        </p>
        <div id="auto-unlock-status" class="row">
          <span class="label">Status</span>
          <span class="pill" id="auto-unlock-pill">checking…</span>
        </div>
        <div id="auto-unlock-leases-list" class="mt-1"></div>
        <button id="auto-unlock-enable" class="full-width mt-2">Enable for 7 days</button>
      </div>
      <h2 class="mt-4">Live metrics</h2>
      <div class="card" id="server-metrics-card">
        <div class="row"><span class="label">CPU</span><span class="value" id="metrics-cpu">…</span></div>
        <div class="row"><span class="label">Memory</span><span class="value" id="metrics-mem">…</span></div>
        <div class="row"><span class="label">Disk</span><span class="value" id="metrics-disk">…</span></div>
        <div class="row"><span class="label">Network</span><span class="value" id="metrics-net">…</span></div>
        <p class="note small" id="metrics-collected-at">Loading…</p>
      </div>
      <h2 class="mt-4">Recent install events</h2>
      ${(body.recentInstallEvents ?? []).length === 0
        ? '<div class="card placeholder">none</div>'
        : (body.recentInstallEvents ?? []).map((e) => `
          <div class="card">
            <div class="row">
              <span class="value">${escapeHtml(e.kind)}: ${escapeHtml(e.serviceId)}</span>
              <span class="pill">${escapeHtml(fmtDate(e.at))}</span>
            </div>
          </div>
        `).join("")}
      <h2 class="mt-4">Front page</h2>
      <div class="card" id="front-page-card">
        <p class="note">
          What visitors see at <code>${escapeHtml(body.serverFqdn)}</code>.
          Point it at one of your apps (the browser is redirected to the
          app's own address) or keep the default Flagship page.
        </p>
        <select id="front-page-select" class="full-width" disabled>
          <option value="">Default Flagship page</option>
        </select>
        <button id="front-page-save" class="full-width mt-2" disabled>Save</button>
        <p class="note small hidden" id="front-page-status"></p>
      </div>
      <h2 class="mt-4">${escapeHtml(isLuksBox(body) ? "Lock & power" : "Power")}</h2>
      <div class="card" id="lock-power-card">
        <p class="note">
          ${escapeHtml(isLuksBox(body)
            ? "Power the box down or restart it. Either drops the in-memory disk key, so the next boot waits for your approval to unlock."
            : "Power the box down or restart it.")}
        </p>
        <div class="row-2 mt-2">
          <button id="power-off-btn" class="danger" data-power-mode="off">${escapeHtml(powerLabel("off", body))}</button>
          <button id="power-restart-btn" class="danger" data-power-mode="restart">${escapeHtml(powerLabel("restart", body))}</button>
        </div>
        <p class="note small hidden" id="power-status"></p>
      </div>
      <h2 class="mt-4">Dead-man heartbeat-lock</h2>
      <div class="card" id="deadman-card">
        <p class="note">
          Off by default. When on, you must periodically affirm — an explicit
          tap that signs "keep this server unlocked?". If the window lapses with
          no affirmation, the box locks itself (${escapeHtml(isLuksBox(body) ? "turns off / restarts and waits for your approval to unlock" : "powers off / restarts")}).
          The phone apps own the real background reminders — this webapp can only
          show the countdown while it's open.
        </p>
        <div class="row mt-2">
          <span class="label">Status</span>
          <span class="pill" id="deadman-pill">off</span>
        </div>
        <label class="caption mt-2">Window</label>
        <select id="deadman-window" class="full-width">
          ${DEADMAN_WINDOW_PRESETS.map(
            (p) => `<option value="${escapeHtml(p.id)}"${p.id === DEADMAN_DEFAULT_PRESET.id ? " selected" : ""}>${escapeHtml(p.label)}</option>`,
          ).join("")}
        </select>
        <label class="caption mt-2">Lockout action</label>
        <select id="deadman-lockout" class="full-width">
          <option value="off" selected>Turn off (default)</option>
          <option value="restart">Restart</option>
        </select>
        <div class="row-2 mt-2">
          <button id="deadman-enable-btn" class="full-width">Enable</button>
          <button id="deadman-disable-btn" class="secondary full-width hidden">Disable</button>
        </div>
        <button id="deadman-tighten-btn" class="secondary full-width mt-2">Tighten now (${escapeHtml(DEADMAN_TIGHTEN_PRESET.label.replace(/\s*\(.*\)/, ""))})</button>
        <div id="deadman-affirm-block" class="mt-3 hidden">
          <div class="row">
            <span class="label">Time remaining</span>
            <span class="value" id="deadman-remaining">—</span>
          </div>
          <button id="deadman-affirm-btn" class="full-width mt-2">Keep ${escapeHtml(body.serverFqdn.split(".")[0] || "server")} unlocked</button>
          <p class="note small mt-1">
            Reminders fire on the phone apps, not here — keep an eye on the
            countdown above while this tab is open.
          </p>
        </div>
      </div>
      <h2 class="mt-4">Diagnostics</h2>
      <div class="card" id="journal-card">
        <p class="note">
          Read the recent system journal from the box — owner-only, signed with
          your key and fetched straight from the server (flagshipserver.com never
          sees it). Useful when a server is online but something isn't working.
        </p>
        <label class="caption mt-2">Unit</label>
        <select id="journal-unit" class="full-width">
          ${JOURNAL_UNITS.map(
            (u) => `<option value="${escapeHtml(u)}"${u === JOURNAL_DEFAULT_UNIT ? " selected" : ""}>${escapeHtml(u)}</option>`,
          ).join("")}
        </select>
        <label class="caption mt-2">Lines</label>
        <input id="journal-lines" class="full-width" type="number" min="1" max="500" value="${JOURNAL_DEFAULT_LINES}" />
        <button id="journal-fetch-btn" class="full-width mt-2">View journal</button>
        <p class="note small hidden" id="journal-status"></p>
        <pre id="journal-output" class="journal-output hidden" aria-label="journal output"></pre>
      </div>
      <h2 class="mt-4">Preferred server</h2>
      <div class="card" id="preferred-server-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          When several of your boxes run the same service, the highest-clout
          live one leads it. Setting <strong>${escapeHtml(body.serverFqdn)}</strong>
          as your preferred server makes it lead by default whenever it's online,
          and new apps go to it unless you pick another server.
        </p>
        <div class="row" id="preferred-server-status">
          <span class="label">Status</span>
          <span class="pill" id="preferred-server-pill">${isPreferredServer(body.serverFqdn) ? "preferred" : "not preferred"}</span>
        </div>
        <button id="set-preferred-btn" class="full-width mt-2"${isPreferredServer(body.serverFqdn) ? " disabled" : ""}>Set as preferred server</button>
      </div>

      <h2 class="mt-4">Transfer</h2>
      <div class="card" id="transfer-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          Hand <strong>${escapeHtml(body.serverFqdn)}</strong> and
          <strong>all its contents</strong> to another account. You will lose
          control of it. The other person scans the code from
          <em>Add a server → Pair an existing box</em>.
        </p>
        <button id="transfer-start-btn" class="full-width mt-2">Transfer to another account</button>
      </div>

      <h2 class="mt-4">Replace</h2>
      <div class="card" id="replace-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          Retire this box and burn a fresh one for
          <strong>${escapeHtml(body.serverFqdn)}</strong>. The old box flushes a
          final backup, releases the name, and powers off <em>before</em> the
          replacement can claim it — so the two never fight over the route.
        </p>
        <button id="replace-start-btn" class="full-width mt-2">Replace this server</button>
      </div>

      <h2 class="mt-4">Update</h2>
      <div class="card" id="update-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          Move <strong>${escapeHtml(body.serverFqdn)}</strong> to a different
          blessed release in place — no reburn, keys and data untouched. Two
          signatures are required: Flagship's maintainers must have blessed the
          release, and you must authorize applying it here. The box verifies
          both, and rolls back automatically if the new version fails to boot.
        </p>
        <div class="row mt-2">
          <span class="label">Running</span>
          <span class="value" id="update-current-commit">${escapeHtml(shortCommit(body.currentCommit))}</span>
        </div>
        <p class="note small mt-2 hidden" id="update-available"></p>
        <p class="note small mt-2${describeLastUpdate(body.lastUpdate) ? "" : " hidden"}" id="update-last-outcome">${escapeHtml(describeLastUpdate(body.lastUpdate) || "")}</p>
        <div class="mt-2 hidden" id="update-pending"></div>
        <button id="update-server-btn" class="danger full-width mt-2"${body.currentCommit ? "" : " disabled"}>Update this server</button>
        <p class="note small${body.currentCommit ? " hidden" : ""}" id="update-hint">
          Waiting for this server to report its current version — it can't be
          updated in place until it does.
        </p>
      </div>

      <h2 class="mt-4">Migrate</h2>
      <div class="card" id="migrate-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}">
        <p class="note">
          Move <strong>${escapeHtml(body.serverFqdn)}</strong> to new hardware —
          same name, same data, new box. The new box restores from backup while
          this one keeps serving; the name only moves once the restore is
          confirmed, and the old box is never wiped before the new one has taken
          over.
        </p>
        <button id="migrate-start-btn" class="full-width mt-2">Migrate to new hardware</button>
      </div>

      ${renderDangerZoneCard({
        serverFqdn: body.serverFqdn,
        username: body.username,
        revoked: isRestorableRevokedPod(detailPod),
      })}
    `;
    wireAutoUnlock(body.serverFqdn);
    wireFrontPage(body);
    wireLockPower(body);
    wireDeadMan(body);
    wireJournal(body);
    wirePreferredServer(body);
    wireServerApps(body.serverFqdn);
    wireTransfer(body);
    wireReplace(body);
    wireUpdate(body);
    wireMigrate(body);
    wireDangerZone(body.serverFqdn, body.username, {
      revoked: isRestorableRevokedPod(detailPod),
      pod: detailPod,
    });
    startMetricsPolling(body.serverFqdn);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

// ---- Box health (the box's own report, relayed on /pods) ---------------

let detailFqdn = "";
let healthUnsub = null;
let healthTimer = null;

function stopHealthWatch() {
  if (healthUnsub) { healthUnsub(); healthUnsub = null; }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

// Re-evaluated on every live-sync snapshot and every 30 s, so a report that
// stops arriving turns into "No health report for N min" on screen.
function startHealthWatch(fqdn) {
  stopHealthWatch();
  const el = $("server-health");
  if (!el) return;
  el.innerHTML = "";
  if (!fqdn) return;
  let pods = [];
  const paint = () => {
    if ($("view-server-detail")?.classList.contains("hidden")) {
      stopHealthWatch();
      return;
    }
    el.innerHTML = renderHealthCard(serverHealthVerdict(healthForServer(pods, fqdn), Date.now()));
  };
  healthUnsub = liveSync.subscribe((snap) => {
    pods = snap?.pods ?? [];
    paint();
  });
  healthTimer = setInterval(paint, 30_000);
}

// ---- The server's apps (docs/app-placement.md §3) -------------------------

let appsWatch = null;
let appsFor = "";

function wireServerApps(serverFqdn) {
  appsWatch?.();
  appsWatch = null;
  const fqdn = String(serverFqdn ?? "").toLowerCase();
  appsFor = fqdn;
  if (!$("server-apps") || !fqdn) return;
  const client = boxClient(fqdn);
  const canCreate = !isCompanionProfile();
  const active = () => appsFor === fqdn && !$("view-server-detail")?.classList.contains("hidden");
  const paint = (rows, opts = {}) => {
    const slot = $("server-apps");
    if (!slot || !active()) return;
    slot.innerHTML = serverAppsHtml(rows, { ...opts, canCreate });
    slot.querySelectorAll("[data-open-app]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { enterServiceDetail } = await import("./service-detail.js");
        await enterServiceDetail(btn.getAttribute("data-open-app"), { server: fqdn, from: "server" });
      });
    });
    $("server-create-app")?.addEventListener("click", async () => {
      const { enterBuildSource } = await import("./build-source.js");
      enterBuildSource({ server: fqdn });
    });
  };
  const load = () => fetchServerApps(client.fetch);
  load()
    .then((rows) => {
      paint(rows);
      if (active() && anyCopying(rows)) appsWatch = watchWhileCopying({ load, onRows: (r) => paint(r), active });
    })
    .catch((e) => paint([], { error: humanError(e) }));
}

function wirePreferredServer(body) {
  const btn = $("set-preferred-btn");
  const pill = $("preferred-server-pill");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Signing…";
    try {
      await setPreferredServer({ serverDomain: body.serverFqdn });
      if (pill) pill.textContent = "preferred";
      btn.textContent = "Set as preferred server";
      toast(`${body.serverFqdn} is now your preferred server`, "ok");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Set as preferred server";
      toast(humanError(e), "err");
    }
  });
}

function wireAutoUnlock(serverFqdn) {
  $("auto-unlock-enable")?.addEventListener("click", async () => {
    const btn = $("auto-unlock-enable");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Signing…";
    }
    try {
      const r = await enableLongLived(serverFqdn);
      toast(`Auto-unlock on; lease expires ${formatWhen(r.expiresAt)}`, "ok");
      await refreshLeases(serverFqdn);
    } catch (e) {
      toast(`Enable failed: ${e.message ?? e}`, "err");
    } finally {
      const b = $("auto-unlock-enable");
      if (b) {
        b.disabled = false;
        b.textContent = "Renew for 7 more days";
      }
    }
  });
  refreshLeases(serverFqdn).catch(() => { /* fall through silently */ });
}

async function refreshLeases(serverFqdn) {
  const pill = $("auto-unlock-pill");
  const list = $("auto-unlock-leases-list");
  if (!pill || !list) return;
  let leases = [];
  try {
    leases = await listLeases(serverFqdn);
  } catch (_e) {
    pill.textContent = "unreachable";
    list.innerHTML = "";
    return;
  }
  const longLived = leases.filter((l) => l.multiUse);
  if (longLived.length === 0) {
    pill.textContent = "off";
    list.innerHTML = "";
    return;
  }
  pill.textContent = "on";
  list.innerHTML = longLived.map((l) => `
    <div class="row mt-1">
      <span class="value text-xs">
        ${escapeHtml(l.leaseId.slice(0, 12))}…
        · until ${escapeHtml(fmtDate(l.expiresAt))}
      </span>
      <button class="danger btn-xs" data-action="revoke-lease" data-lease-id="${escapeHtml(l.leaseId)}">Revoke</button>
    </div>
  `).join("");
  list.querySelectorAll('[data-action="revoke-lease"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-lease-id");
      if (!id) return;
      const ok = await inlineConfirm({
        title: "Revoke auto-unlock lease?",
        message: "This server will need phone approval to unlock on its next boot. This can't be undone.",
        okLabel: "Revoke",
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await revokeLease(serverFqdn, id);
        toast(`Revoked lease ${id.slice(0, 8)}…`, "ok");
        await refreshLeases(serverFqdn);
      } catch (e) {
        console.error("lease revoke failed", e);
        toast(humanError(e), "err");
        btn.disabled = false;
      }
    });
  });
}

// Format bytes → human (1.4 GB / 312 KB / ...). Mirrors the
// `humanBytes` helper in iOS/Android ServerDetailScreen.
function humanBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  const k = 1024;
  if (n < k) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / k;
  let i = 0;
  while (v >= k && i < units.length - 1) { v /= k; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

let metricsTimer = null;
let metricsFor = "";
function startMetricsPolling(serverFqdn) {
  // Cancel any prior poller (back+forward navigation re-enters this).
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  metricsFor = serverFqdn;
  const tick = async () => {
    // Stop polling when the user navigates away.
    if ($("view-server-detail")?.classList.contains("hidden")) {
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
      return;
    }
    try {
      const m = await fetchOn(serverFqdn)(
        `/api/screens/server-metrics/${encodeURIComponent(serverFqdn)}`,
      );
      if (metricsFor !== serverFqdn) return;
      const cpu = $("metrics-cpu");
      const mem = $("metrics-mem");
      const disk = $("metrics-disk");
      const net = $("metrics-net");
      const at = $("metrics-collected-at");
      if (cpu) cpu.textContent = `${(m.cpuPercent ?? 0).toFixed(1)}%`;
      if (mem) mem.textContent = `${humanBytes(m.memUsedBytes)} / ${humanBytes(m.memTotalBytes)}`;
      if (disk) disk.textContent = `${humanBytes(m.diskUsedBytes)} / ${humanBytes(m.diskTotalBytes)}`;
      if (net) net.textContent =
        `↓ ${humanBytes(m.netRxBytesPerSec)}/s · ↑ ${humanBytes(m.netTxBytesPerSec)}/s`;
      if (at) at.textContent = `Collected ${formatWhen(m.collectedAt)}`;
    } catch (e) {
      if (metricsFor !== serverFqdn) return;
      const at = $("metrics-collected-at");
      if (at) at.textContent = `Couldn't reach daemon: ${e.message ?? e}`;
    }
  };
  void tick();
  metricsTimer = setInterval(tick, 15_000);
}

// ---- Front page (owner-assignable apex) --------------------------------

// Load current assignment + installed apps from the pod (both reads are
// unauthenticated), then let the owner pick + Save (IRK-signed set).
function wireFrontPage(body) {
  const select = $("front-page-select");
  const save = $("front-page-save");
  const status = $("front-page-status");
  if (!select || !save) return;

  const baseUrl = baseOf(body);
  if (!baseUrl) return; // not paired — leave the card disabled

  let current = "";
  void (async () => {
    try {
      const [fp, options] = await Promise.all([
        getFrontPage({ baseUrl }),
        listFrontPageOptions({ baseUrl }),
      ]);
      current = fp.label || "";
      for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o.urlLabel;
        opt.textContent = `${o.name || o.urlLabel} — ${o.urlLabel}.${body.serverFqdn}`;
        select.appendChild(opt);
      }
      // An assigned-but-uninstalled label still shows (marked), so the
      // owner can see and clear a stale assignment.
      if (current && !options.some((o) => o.urlLabel === current)) {
        const opt = document.createElement("option");
        opt.value = current;
        opt.textContent = `${current} (no longer installed)`;
        select.appendChild(opt);
      }
      select.value = current;
      select.disabled = false;
      save.disabled = false;
    } catch {
      if (status) {
        status.classList.remove("hidden");
        status.textContent = "Couldn't reach the server to load front-page settings.";
      }
    }
  })();

  save.addEventListener("click", async () => {
    const session = getSession();
    if (!session.umk) {
      toast("Unlock the webapp first", "err");
      return;
    }
    const label = select.value;
    save.disabled = true;
    const orig = save.textContent;
    save.textContent = "Saving…";
    try {
      await sendSetFrontPage({
        baseUrl,
        label,
        umk: session.umk,
        // Slice D: set-front-page is a SENSITIVE order (admin root when present).
        signWithIrk: sensitiveSigner(),
      });
      current = label;
      toast(label ? `Front page set to ${label}` : "Front page reset to default", "ok");
      if (status) {
        status.classList.remove("hidden");
        status.textContent = label
          ? `Visitors to ${body.serverFqdn} now land on ${label}.${body.serverFqdn}.`
          : `Visitors to ${body.serverFqdn} now see the default Flagship page.`;
      }
    } catch (e) {
      toast(humanError(e), "err");
      select.value = current;
    } finally {
      save.textContent = orig;
      save.disabled = false;
    }
  });
}

// ---- Diagnostics: journal ---------------------------------------------

function wireJournal(body) {
  const btn = $("journal-fetch-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    runJournalFetch(body, btn).catch((e) => toast(humanError(e), "err"));
  });
}

async function runJournalFetch(body, btn) {
  const status = $("journal-status");
  const out = $("journal-output");
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const baseUrl = baseOf(body);
  if (!baseUrl) {
    toast("Not paired with this server", "err");
    return;
  }
  const unit = $("journal-unit")?.value || JOURNAL_DEFAULT_UNIT;
  const lines = Number($("journal-lines")?.value) || JOURNAL_DEFAULT_LINES;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Fetching…";
  if (status) {
    status.classList.remove("hidden");
    status.textContent = "Asking the server…";
  }
  try {
    const res = await fetchJournal({
      baseUrl,
      unit,
      lines,
      umk: session.umk,
      signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
    });
    if (out) {
      out.classList.remove("hidden");
      out.textContent = res.lines.length ? res.lines.join("\n") : "(journal is empty)";
    }
    if (status) status.textContent = `${res.lines.length} line${res.lines.length === 1 ? "" : "s"} from ${res.unit}.`;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ---- Lock & power -----------------------------------------------------

// The server-detail BFF (ServerDetailResponse) does NOT surface
// diskEncryption today, so the webapp can't reliably know whether a box is
// LUKS-from-phone. Default to the LUKS-assumed labels ("Lock and …") and the
// lock copy, and honor `body.diskEncryption === "none"` IF the model ever
// starts carrying it. GAP: wire a real diskEncryption flag through the BFF to
// drop the "Lock and " prefix on genuinely non-LUKS boxes.
function isLuksBox(body) {
  return body?.diskEncryption !== "none";
}

function powerLabel(mode, body) {
  const verb = mode === "restart" ? "restart" : "turn off";
  const cap = verb.charAt(0).toUpperCase() + verb.slice(1);
  return isLuksBox(body) ? `Lock and ${verb}` : cap;
}

function wireLockPower(body) {
  const status = $("power-status");
  const buttons = ["power-off-btn", "power-restart-btn"]
    .map((id) => $(id))
    .filter(Boolean);

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-power-mode");
      runPowerAction(body, mode, btn, buttons, status).catch((e) => {
        if (e?.code !== "cancelled") toast(humanError(e), "err");
      });
    });
  }
}

async function runPowerAction(body, mode, btn, allButtons, status) {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const baseUrl = baseOf(body);
  if (!baseUrl) {
    toast("Not paired with this server", "err");
    return;
  }
  const actionLabel = powerLabel(mode, body);
  // Reuse the most-destructive existing gate: the revoke ceremony's
  // confirm dialog + 3-second AbortSignal countdown (countdownConfirm).
  await openPowerConfirmDialog(body, mode, actionLabel, async (signal) => {
    for (const b of allButtons) b.disabled = true;
    const origLabel = btn.textContent;
    try {
      await countdownConfirm({
        signal,
        onTick: (s) => {
          btn.textContent = s > 0 ? `${actionLabel} in ${s}…` : `${actionLabel}…`;
        },
      });
      await sendPowerOff({
        baseUrl,
        mode,
        umk: session.umk,
        // Slice D: power-off/restart is a SENSITIVE order (admin root when present).
        signWithIrk: sensitiveSigner(),
      });
      if (status) {
        status.classList.remove("hidden");
        status.textContent =
          mode === "restart" ? "Restarting — the server will go offline briefly." : "Powering off — the server is going offline.";
      }
      toast(`${actionLabel} sent`, "ok");
    } finally {
      btn.textContent = origLabel;
      for (const b of allButtons) b.disabled = false;
    }
  });
}

// Minimal "Are you sure?" confirm dialog around the power action. Mirrors the
// revoke dialog's structure (dialog element, Escape/Cancel abort) but with the
// short copy the spec asks for. The actual destructive gate (countdown) runs
// inside `onConfirm(signal)`.
function openPowerConfirmDialog(body, mode, actionLabel, onConfirm) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", actionLabel);
  dlg.innerHTML = `
    <h3 class="modal-title">${escapeHtml(actionLabel)}?</h3>
    <p class="modal-message">${escapeHtml(body.serverFqdn)} will go offline.</p>
    <div class="row-2 mt-3">
      <button class="secondary" data-power-cancel>Cancel</button>
      <button class="danger" data-power-go>${escapeHtml(actionLabel)}</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const goBtn = dlg.querySelector("[data-power-go]");
  const cancelBtn = dlg.querySelector("[data-power-cancel]");
  let abort = null;
  const cleanup = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };

  return new Promise((resolve, reject) => {
    const onCancel = () => {
      if (abort) abort.abort();
      cleanup();
      reject({ code: "cancelled" });
    };
    const onEscape = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); onCancel(); }
    };
    dlg.addEventListener("close", onCancel, { once: true });
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onEscape);

    goBtn.addEventListener("click", async () => {
      abort = new AbortController();
      try {
        await onConfirm(abort.signal);
        document.removeEventListener("keydown", onEscape);
        dlg.removeEventListener("close", onCancel);
        cleanup();
        resolve();
      } catch (e) {
        if (e?.code === "cancelled") {
          // Bounce back to the picker so the user can re-confirm.
          abort = null;
          return;
        }
        document.removeEventListener("keydown", onEscape);
        dlg.removeEventListener("close", onCancel);
        cleanup();
        reject(e);
      }
    });
  });
}

// ---- Dead-man heartbeat-lock ------------------------------------------

let deadManCountdownTimer = null;

function selectedWindowPreset() {
  const id = $("deadman-window")?.value;
  return DEADMAN_WINDOW_PRESETS.find((p) => p.id === id) || DEADMAN_DEFAULT_PRESET;
}

function setDeadManEnabledUi(enabled, leaseExpiry) {
  const pill = $("deadman-pill");
  const disableBtn = $("deadman-disable-btn");
  const enableBtn = $("deadman-enable-btn");
  const affirmBlock = $("deadman-affirm-block");
  if (pill) pill.textContent = enabled ? "on" : "off";
  if (enableBtn) enableBtn.textContent = enabled ? "Update window" : "Enable";
  disableBtn?.classList.toggle("hidden", !enabled);
  affirmBlock?.classList.toggle("hidden", !enabled);
  if (enabled) startDeadManCountdown(leaseExpiry);
  else stopDeadManCountdown();
}

function startDeadManCountdown(leaseExpiry) {
  stopDeadManCountdown();
  const el = $("deadman-remaining");
  if (!el) return;
  const render = () => {
    if ($("view-server-detail")?.classList.contains("hidden")) {
      stopDeadManCountdown();
      return;
    }
    el.textContent =
      typeof leaseExpiry === "number"
        ? fmtRemaining(leaseExpiry, Date.now())
        : "affirm to start the lease";
  };
  render();
  if (typeof leaseExpiry === "number") {
    deadManCountdownTimer = setInterval(render, 1000);
  }
}

function stopDeadManCountdown() {
  if (deadManCountdownTimer) {
    clearInterval(deadManCountdownTimer);
    deadManCountdownTimer = null;
  }
}

async function applyDeadManPolicy(body, { enabled, preset, lockoutMode }) {
  const session = getSession();
  if (!session.umk) throw Object.assign(new Error("Unlock the webapp first"), { code: "400" });
  const baseUrl = baseOf(body);
  if (!baseUrl) throw Object.assign(new Error("Not paired with this server"), { code: "400" });
  return setDeadManPolicy({
    baseUrl,
    enabled,
    windowMs: preset.windowMs,
    graceMs: preset.graceMs,
    lockoutMode,
    umk: session.umk,
    // Slice D: set-dead-man-policy is a SENSITIVE order (admin root when present).
    signWithIrk: sensitiveSigner(),
  });
}

function wireDeadMan(body) {
  const enableBtn = $("deadman-enable-btn");
  const disableBtn = $("deadman-disable-btn");
  const tightenBtn = $("deadman-tighten-btn");
  const affirmBtn = $("deadman-affirm-btn");

  enableBtn?.addEventListener("click", async () => {
    const lockoutMode = $("deadman-lockout")?.value === "restart" ? "restart" : "off";
    enableBtn.disabled = true;
    enableBtn.textContent = "Signing…";
    try {
      await applyDeadManPolicy(body, { enabled: true, preset: selectedWindowPreset(), lockoutMode });
      setDeadManEnabledUi(true, null);
      toast("Dead-man lock enabled — affirm to start the lease", "ok");
    } catch (e) {
      toast(humanError(e), "err");
    } finally {
      enableBtn.disabled = false;
      if ($("deadman-pill")?.textContent !== "on") enableBtn.textContent = "Enable";
    }
  });

  disableBtn?.addEventListener("click", async () => {
    disableBtn.disabled = true;
    try {
      await applyDeadManPolicy(body, {
        enabled: false,
        preset: selectedWindowPreset(),
        lockoutMode: $("deadman-lockout")?.value === "restart" ? "restart" : "off",
      });
      setDeadManEnabledUi(false, null);
      toast("Dead-man lock disabled", "ok");
    } catch (e) {
      toast(humanError(e), "err");
    } finally {
      disableBtn.disabled = false;
    }
  });

  tightenBtn?.addEventListener("click", async () => {
    tightenBtn.disabled = true;
    const lockoutMode = $("deadman-lockout")?.value === "restart" ? "restart" : "off";
    try {
      await applyDeadManPolicy(body, { enabled: true, preset: DEADMAN_TIGHTEN_PRESET, lockoutMode });
      const sel = $("deadman-window");
      if (sel) sel.value = DEADMAN_TIGHTEN_PRESET.id;
      setDeadManEnabledUi(true, null);
      toast(`Tightened to ${DEADMAN_TIGHTEN_PRESET.label}`, "ok");
    } catch (e) {
      toast(humanError(e), "err");
    } finally {
      tightenBtn.disabled = false;
    }
  });

  affirmBtn?.addEventListener("click", async () => {
    const session = getSession();
    if (!session.umk) return toast("Unlock the webapp first", "err");
    const baseUrl = baseOf(body);
    if (!baseUrl) return toast("Not paired with this server", "err");
    affirmBtn.disabled = true;
    affirmBtn.textContent = "Affirming…";
    try {
      const r = await affirmDeadMan({
        baseUrl,
        umk: session.umk,
        // Slice D: dead-man affirmation is a SENSITIVE order (admin root when present).
        signWithIrk: sensitiveSigner(),
      });
      setDeadManEnabledUi(true, r.leaseExpiry);
      toast("Affirmed — lease renewed", "ok");
    } catch (e) {
      toast(humanError(e), "err");
    } finally {
      affirmBtn.disabled = false;
      affirmBtn.textContent = `Keep ${body.serverFqdn.split(".")[0] || "server"} unlocked`;
    }
  });
}

function wireTransfer(body) {
  $("transfer-start-btn")?.addEventListener("click", () => {
    openTransferDialog(body).catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("server transfer failed", e);
        toast(humanError(e), "err");
      }
    });
  });
}

// Slice D §9.8 — a failed admin-root hand-off deposit is RETRYABLE, never a
// transfer failure: ownership already moved when the claim landed.
export const TRANSFER_ADMIN_HANDOFF_WARNING =
  "Claimed — but the admin-key hand-off didn't go through yet. Retrying while " +
  "this dialog is open; a box with a pinned admin key will wait for this " +
  "hand-off before re-homing.";

// Giver "Transfer to another account": full irreversible warning + type-to-
// confirm the FQDN, then sign + deposit the offer and render the claim code the
// acquirer pastes into "Pair an existing box". The disk-key re-seal is a later
// giver-phone step (the box never holds the giver IRK) — surfaced as a note.
async function openTransferDialog(body) {
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const serverFqdn = body.serverFqdn;
  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Transfer this server");
  dlg.innerHTML = `
    <h3 class="modal-title">Transfer ${escapeHtml(serverFqdn)}?</h3>
    <p class="modal-message">
      This hands the box <strong>and all its contents</strong> to another
      account. <strong>You will lose control of it</strong> — this cannot be
      undone. Type the server's full name to confirm.
    </p>
    <input class="full-width mt-2" data-transfer-confirm placeholder="${escapeHtml(serverFqdn)}" autocomplete="off" />
    <p class="modal-error err-text hidden" data-transfer-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-transfer-cancel>Cancel</button>
      <button class="danger" data-transfer-go disabled>Create transfer code</button>
    </div>
    <div class="mt-3 hidden" data-transfer-result>
      <p class="note">Share this link with the other person — it expires soon.
      They can open it with their phone's camera, or paste it into
      <em>Take over a box</em>. After they claim it you'll be asked to finish
      handing over the disk key.</p>
      <textarea class="full-width" rows="4" readonly data-transfer-qr></textarea>
      <p class="note small hidden" data-transfer-handoff></p>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cleanup = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  const confirmEl = dlg.querySelector("[data-transfer-confirm]");
  const goBtn = dlg.querySelector("[data-transfer-go]");
  const cancelBtn = dlg.querySelector("[data-transfer-cancel]");
  const errEl = dlg.querySelector("[data-transfer-error]");
  const resultEl = dlg.querySelector("[data-transfer-result]");
  const qrEl = dlg.querySelector("[data-transfer-qr]");
  const handoffEl = dlg.querySelector("[data-transfer-handoff]");

  return new Promise((resolve, reject) => {
    const onCancel = () => { cleanup(); reject({ code: "cancelled" }); };
    dlg.addEventListener("close", onCancel, { once: true });
    cancelBtn.addEventListener("click", onCancel);

    confirmEl.addEventListener("input", () => {
      goBtn.disabled = confirmEl.value.trim().toLowerCase() !== serverFqdn.toLowerCase();
    });

    goBtn.addEventListener("click", async () => {
      errEl.classList.add("hidden");
      goBtn.disabled = true;
      goBtn.textContent = "Signing…";
      try {
        const out = await createTransferOffer({
          serverDomain: serverFqdn,
          username: session.username,
          umk: session.umk,
          irkPubHex: bytesToHex(session.irk.publicKey),
          // Slice D: the transfer OFFER order is signed with the admin root
          // (when present); the co-signed mailbox-auth stays the IRK — the
          // gated signer tag-routes both. Legacy accounts sign with the IRK.
          signWithIrk: sensitiveSigner(),
        });
        // Render the universal-link form (a phone Camera opens it straight
        // into the app; it doubles as the paste-able acquirer code).
        qrEl.value = buildTransferLink(out.qr);
        resultEl.classList.remove("hidden");
        goBtn.classList.add("hidden");
        confirmEl.disabled = true;
        cancelBtn.textContent = "Done";
        toast("Transfer code created", "ok");
        // Hand the box's AUTHORITY anchor to the acquirer at claim-received:
        // poll for the claim while this dialog stays open, then deposit the
        // giver-signed proof the box verifies against what IT already pins.
        //   • ADMIN-TIER (§9.8): the box pins the giver admin root ⇒ deposit the
        //     giver-root-signed AdminRootTransfer (acquirer root from the v2
        //     claim, "" = unpin).
        //   • LEGACY (v1-sec GAP 3): the box pins the giver OWNER IRK ⇒ deposit
        //     the giver-IRK-signed RehomeAuthorization. A box with no pinned
        //     admin root REFUSES to re-home without it, so this is NOT optional
        //     for a legacy transfer — it always runs.
        void watchClaimThenHandoff({
          poll: () =>
            pollTransferClaim({
              serverDomain: serverFqdn,
              username: session.username,
              umk: session.umk,
              irkPubHex: bytesToHex(session.irk.publicKey),
              signWithIrk,
            }),
          handoff: (claim) =>
            session.adminRootSeed
              ? runGiverAdminHandoff({
                  serverDomain: serverFqdn,
                  giverUsername: session.username,
                  acquirerUsername: claim.acquirerUsername,
                  acquirerAdminRootPub: claim.acquirerAdminRootPub || "",
                  transferNonce: out.qr.transferNonce,
                  adminRootSeed: session.adminRootSeed,
                  umkSeed: session.umk,
                })
              : depositRehomeAuth({
                  serverDomain: serverFqdn,
                  newServerDomain: claim.newServerDomain,
                  acquirerIrkPubHex: claim.acquirerIrkPub,
                  umk: session.umk,
                  signWithIrk,
                }).then(
                  () => ({ status: "deposited" }),
                  (e) => ({ status: "failed", error: (e && e.message) || String(e) }),
                ),
          isActive: () => dlg.open,
          onStatus: (res, claim) => {
            if (res.status === "failed") {
              handoffEl.textContent = TRANSFER_ADMIN_HANDOFF_WARNING;
              handoffEl.classList.add("err-text");
              handoffEl.classList.remove("hidden");
            } else if (res.status === "deposited") {
              handoffEl.textContent = session.adminRootSeed
                ? `Claimed by ${claim.acquirerUsername} — admin key handed off.`
                : `Claimed by ${claim.acquirerUsername} — re-home authorized.`;
              handoffEl.classList.remove("err-text");
              handoffEl.classList.remove("hidden");
            }
          },
        });
        resolve(out);
      } catch (e) {
        errEl.textContent = humanError(e);
        errEl.classList.remove("hidden");
        goBtn.disabled = false;
        goBtn.textContent = "Create transfer code";
      }
    });
  });
}

// ---- Replace this server (graceful decommission) ----------------------

function wireReplace(body) {
  $("replace-start-btn")?.addEventListener("click", () => {
    openReplaceDialog(body).catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("server replace failed", e);
        toast(humanError(e), "err");
      }
    });
  });
}

const DISPOSITION_LABELS = {
  keep: "Keep the disk (power off, data intact)",
  "wipe-after-handoff": "Wipe after the replacement is proven (recommended)",
  "wipe-now": "Wipe now (irreversible — accepts the backup as the only copy)",
};

// "Replace this server": resolve the box's current STK + backup-enrollment, let
// the owner pick a disposition (with a HARD pre-flight gate when a wipe would
// lose un-backed-up data), then mint+sign+deposit the decommission order and
// retire the instance locally (L3) so the phone never re-approves this box.
async function openReplaceDialog(body) {
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const serverFqdn = body.serverFqdn;
  const username = session.username || body.username;

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Replace this server");
  dlg.innerHTML = `
    <h3 class="modal-title">Replace ${escapeHtml(serverFqdn)}?</h3>
    <p class="modal-message" data-replace-loading>Checking this server's backup…</p>
    <div class="hidden" data-replace-body>
      <p class="note" data-replace-backup></p>
      <label class="caption mt-2">What happens to the old disk?</label>
      <select class="full-width" data-replace-disposition>
        ${DISK_DISPOSITIONS.map(
          (d) => `<option value="${escapeHtml(d)}"${d === DEFAULT_DISPOSITION ? " selected" : ""}>${escapeHtml(DISPOSITION_LABELS[d])}</option>`,
        ).join("")}
      </select>
      <p class="note small err-text hidden" data-replace-gate></p>
      <p class="note small hidden" data-replace-warn></p>
    </div>
    <p class="modal-error err-text hidden" data-replace-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-replace-cancel>Cancel</button>
      <button class="danger" data-replace-go disabled>Retire and replace</button>
    </div>
    <div class="mt-3 hidden" data-replace-result>
      <p class="note">Server retiring — the old box will flush a final backup,
      release the name and power off. Burn a replacement when ready from
      <em>Add a server</em>; it claims the name once the old box has stepped down.</p>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cleanup = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  const loadingEl = dlg.querySelector("[data-replace-loading]");
  const bodyEl = dlg.querySelector("[data-replace-body]");
  const backupEl = dlg.querySelector("[data-replace-backup]");
  const dispoEl = dlg.querySelector("[data-replace-disposition]");
  const gateEl = dlg.querySelector("[data-replace-gate]");
  const warnEl = dlg.querySelector("[data-replace-warn]");
  const errEl = dlg.querySelector("[data-replace-error]");
  const goBtn = dlg.querySelector("[data-replace-go]");
  const cancelBtn = dlg.querySelector("[data-replace-cancel]");
  const resultEl = dlg.querySelector("[data-replace-result]");

  let ctx = { retiredStkPubHex: null, backupEnrolled: false };

  const refreshGate = () => {
    const disposition = dispoEl.value;
    const wipeNow = disposition === "wipe-now";
    const { blocked, reason } = preflightGate({
      disposition,
      backupEnrolled: ctx.backupEnrolled,
    });
    if (blocked) {
      gateEl.textContent = reason;
      gateEl.classList.remove("hidden");
      // wipe-now is the explicit "I accept data loss" escape hatch (§11.4): it
      // stays enabled (with the warning), every other wipe is hard-blocked.
      goBtn.disabled = !wipeNow || !ctx.retiredStkPubHex;
    } else {
      gateEl.classList.add("hidden");
      goBtn.disabled = !ctx.retiredStkPubHex;
    }
    if (wipeNow) {
      warnEl.textContent = "Wipe-now is irreversible — there is no fallback if the backup is incomplete.";
      warnEl.classList.remove("hidden");
    } else {
      warnEl.classList.add("hidden");
    }
  };

  return new Promise((resolve, reject) => {
    const onCancel = () => { cleanup(); reject({ code: "cancelled" }); };
    dlg.addEventListener("close", onCancel, { once: true });
    cancelBtn.addEventListener("click", onCancel);

    void (async () => {
      ctx = await resolveReplacementContext({ serverDomain: serverFqdn, username });
      loadingEl.classList.add("hidden");
      bodyEl.classList.remove("hidden");
      backupEl.textContent = ctx.backupEnrolled
        ? "Peer-backup is enrolled — the old box flushes a final backup before it steps down."
        : "No backup is enrolled for this server. Wiping will lose its data — set up backup first, or accept the loss with 'wipe-now'.";
      if (!ctx.retiredStkPubHex) {
        errEl.textContent = "Couldn't read this box's current key from the directory — is it online? It must be reachable to be replaced.";
        errEl.classList.remove("hidden");
      }
      dispoEl.addEventListener("change", refreshGate);
      refreshGate();
    })().catch((e) => {
      loadingEl.classList.add("hidden");
      errEl.textContent = humanError(e);
      errEl.classList.remove("hidden");
    });

    goBtn.addEventListener("click", async () => {
      errEl.classList.add("hidden");
      goBtn.disabled = true;
      const orig = goBtn.textContent;
      goBtn.textContent = "Signing…";
      try {
        await runReplacement({
          serverDomain: serverFqdn,
          username,
          retiredStkPubHex: ctx.retiredStkPubHex,
          disposition: dispoEl.value,
          backupEnrolled: ctx.backupEnrolled,
          umk: session.umk,
          irkPubHex: bytesToHex(session.irk.publicKey),
          // Slice D: the decommission order is signed with the admin root (when
          // present); the co-signed mailbox-auth stays the IRK (tag-routed).
          signWithIrk: sensitiveSigner(),
        });
        bodyEl.classList.add("hidden");
        resultEl.classList.remove("hidden");
        goBtn.classList.add("hidden");
        cancelBtn.textContent = "Done";
        toast("Server retiring — burn a replacement when ready", "ok");
        resolve({ ok: true });
      } catch (e) {
        errEl.textContent = humanError(e);
        errEl.classList.remove("hidden");
        goBtn.textContent = orig;
        refreshGate();
      }
    });
  });
}

// ---- Update this server (dual-signed in-place update) ------------------

// The card's state. A sent order is remembered on this device until
// server-detail shows its outcome; while one is pending the card shows it in
// place of the button and re-reads server-detail every 15 s.
let updateCard = null;

function stopPendingUpdatePoll(card) {
  if (card?.timer) { clearInterval(card.timer); card.timer = null; }
}

export function wireUpdate(body) {
  stopPendingUpdatePoll(updateCard);
  const card = { fqdn: body.serverFqdn, detail: body, latest: null, catalogFor: null, catalogLoaded: false, timer: null, polling: false };
  updateCard = card;
  $("update-server-btn")?.addEventListener("click", () => runUpdateDialog(card));
  paintUpdateCard(card);
}

function runUpdateDialog(card, opts) {
  openUpdateDialog(card.detail, opts)
    .catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("server update failed", e);
        toast(humanError(e), "err");
      }
    })
    .finally(() => paintUpdateCard(card));
}

function paintUpdateCard(card) {
  if (updateCard !== card) return;
  const pendingEl = $("update-pending");
  if (!pendingEl) return;
  const d = card.detail;
  const pending = reconcilePendingUpdate(card.fqdn, d);
  const running = $("update-current-commit");
  if (running) running.textContent = shortCommit(d.currentCommit);
  const lastEl = $("update-last-outcome");
  if (lastEl) {
    const last = describeLastUpdate(d.lastUpdate);
    lastEl.textContent = last || "";
    lastEl.classList.toggle("hidden", !last);
  }
  const btn = $("update-server-btn");
  const hint = $("update-hint");
  if (pending) {
    pendingEl.innerHTML = renderPendingUpdate(pending, { formatWhen, escapeHtml });
    pendingEl.classList.remove("hidden");
    pendingEl.querySelector("[data-update-send-again]")?.addEventListener("click", () => {
      runUpdateDialog(card, { sendAgain: true });
    });
    pendingEl.querySelector("[data-update-forget]")?.addEventListener("click", () => {
      clearPendingUpdate(card.fqdn);
      paintUpdateCard(card);
    });
    btn?.classList.add("hidden");
    hint?.classList.add("hidden");
    ensurePendingUpdatePoll(card);
  } else {
    pendingEl.innerHTML = "";
    pendingEl.classList.add("hidden");
    if (btn) {
      btn.classList.remove("hidden");
      btn.disabled = !d.currentCommit || btn.getAttribute("data-companion-unavailable") === "true";
    }
    hint?.classList.toggle("hidden", !!d.currentCommit);
    stopPendingUpdatePoll(card);
    refreshReleaseNote(card);
  }
  paintReleaseNote(card, !!pending);
}

function paintReleaseNote(card, pending) {
  const note = $("update-available");
  if (note) {
    note.textContent = card.latest ? `New release available: ${card.latest.tag}` : "";
    note.classList.toggle("hidden", pending || !card.latest);
  }
  const btn = $("update-server-btn");
  if (btn) btn.textContent = card.latest ? "Update to latest" : "Update this server";
}

function refreshReleaseNote(card) {
  const commit = card.detail.currentCommit;
  if (card.catalogLoaded && card.catalogFor === commit) return;
  card.catalogLoaded = true;
  card.catalogFor = commit;
  card.latest = null;
  loadReleaseCatalog({ fetchBox: fetchOn(card.fqdn), currentCommit: commit })
    .then((catalog) => {
      if (updateCard !== card || card.detail.currentCommit !== commit) return;
      card.latest = groupReleases(catalog).latest;
      paintReleaseNote(card, !!readPendingUpdate(card.fqdn));
    })
    .catch(() => {});
}

function ensurePendingUpdatePoll(card) {
  if (card.timer) return;
  card.timer = setInterval(async () => {
    if (updateCard !== card || !$("update-pending") || $("view-server-detail")?.classList.contains("hidden")) {
      stopPendingUpdatePoll(card);
      return;
    }
    if (document.visibilityState === "hidden" || card.polling) return;
    card.polling = true;
    try {
      const fresh = await fetchOn(card.fqdn)("/api/screens/server-detail");
      if (String(fresh?.serverFqdn || "").toLowerCase() === String(card.fqdn).toLowerCase()) card.detail = fresh;
    } catch {
      // Offline or restarting: keep the last reading; the order stays pending.
    } finally {
      card.polling = false;
    }
    paintUpdateCard(card);
  }, PENDING_UPDATE_POLL_MS);
}

// "Update this server": the box lists the releases it verified for itself.
// The main action is "Update to latest", other newer releases sit below, and
// going back to an older release (or pasting any commit) is under Advanced
// behind a warning and a confirmation. Whatever is picked, the UpdateOrder is
// signed for that one exact commit with the sensitive signer (admin master
// root when present) and deposited on `.com`'s update lane. The box only
// applies it if the commit is ALSO maintainer-endorsed.
//
// While an order this device sent is still pending the sheet opens on it
// instead of the picker; `sendAgain` skips that (the stale order's Send again).
export async function openUpdateDialog(body, { sendAgain = false } = {}) {
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const serverFqdn = body.serverFqdn;
  const currentCommit = body.currentCommit;
  if (!COMMIT_SHA_RE.test(String(currentCommit))) {
    toast("This server hasn't reported its current version yet", "err");
    return;
  }

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Update this server");
  dlg.innerHTML = `
    <h3 class="modal-title">Update ${escapeHtml(serverFqdn)}</h3>
    <div class="row mt-2">
      <span class="label">Running</span>
      <span class="value" data-update-running>${escapeHtml(shortCommit(currentCommit))}</span>
    </div>
    <div class="hidden" data-update-choose>
      <div class="mt-3" data-update-latest>
        <p class="note small">Checking for new releases…</p>
      </div>
      <p class="note small hidden" data-update-stale>The server couldn't reach GitHub, so this list may be out of date.</p>
      <div class="mt-3 hidden" data-update-others></div>
      <details class="advanced-disclosure mt-3" data-update-advanced>
        <summary>Advanced</summary>
        <p class="note small mt-2" data-update-warning>${escapeHtml(DOWNGRADE_WARNING)}</p>
        <div data-update-older></div>
        <label class="caption mt-2">Or enter any release (full commit)</label>
        <input class="full-width" data-update-target placeholder="40-character commit hash" autocomplete="off" spellcheck="false" />
        <p class="note small hidden" data-update-target-hint></p>
        <button class="danger full-width mt-2" data-update-go disabled>Order update</button>
      </details>
    </div>
    <p class="modal-error err-text hidden" data-update-error></p>
    <div class="mt-3 hidden" data-update-result></div>
    <div class="row-2 mt-3">
      <button class="secondary" data-update-cancel>Cancel</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const q = (sel) => dlg.querySelector(sel);
  const cleanup = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  const chooseEl = q("[data-update-choose]");
  const latestEl = q("[data-update-latest]");
  const staleEl = q("[data-update-stale]");
  const othersEl = q("[data-update-others]");
  const olderEl = q("[data-update-older]");
  const runningEl = q("[data-update-running]");
  const targetEl = q("[data-update-target]");
  const hintEl = q("[data-update-target-hint]");
  const errEl = q("[data-update-error]");
  const goBtn = q("[data-update-go]");
  const cancelBtn = q("[data-update-cancel]");
  const resultEl = q("[data-update-result]");
  const from = currentCommit.toLowerCase();

  let catalog = null;
  let catalogRequested = false;
  let working = false;
  let done = false;

  const orderButtons = () => dlg.querySelectorAll("[data-update-commit]");
  const setWorking = (on) => {
    working = on;
    orderButtons().forEach((b) => { b.disabled = on; });
    refreshTarget();
  };

  const releaseRows = (rows, label, action) => rows.map((r) => `
    <div class="row mt-2">
      <span class="value mono">${escapeHtml(r.tag)}</span>
      <button class="secondary btn-xs" data-update-commit="${escapeHtml(r.commit)}" data-update-action="${action}">${escapeHtml(label)}</button>
    </div>
  `).join("");

  const tagFor = (commit) => {
    const g = groupReleases(catalog);
    const all = [g.latest, ...g.otherNewer, ...g.older].filter(Boolean);
    return all.find((r) => r.commit === commit)?.tag || undefined;
  };

  const renderCatalog = () => {
    const g = groupReleases(catalog);
    if (g.currentTag) runningEl.textContent = g.currentTag;
    if (g.latest) {
      latestEl.innerHTML = `
        <div class="card">
          <p class="caption">Latest release</p>
          <p class="mono">${escapeHtml(g.latest.tag)}</p>
          <button class="full-width mt-2" id="update-latest-btn" data-update-commit="${escapeHtml(g.latest.commit)}" data-update-action="update">Update to latest</button>
          <p class="note small mt-2">The server rolls back by itself if the new version doesn't start.</p>
        </div>
      `;
    } else {
      latestEl.innerHTML = `
        <div class="row">
          <span class="value">This server is on the latest release.</span>
          <button class="secondary btn-xs" data-update-recheck>Check again</button>
        </div>
      `;
      q("[data-update-recheck]")?.addEventListener("click", () => loadCatalog(true));
    }
    staleEl.classList.toggle("hidden", !g.stale);
    othersEl.innerHTML = g.otherNewer.length
      ? `<p class="caption">Other new releases</p>${releaseRows(g.otherNewer, "Update", "update")}`
      : "";
    othersEl.classList.toggle("hidden", g.otherNewer.length === 0);
    olderEl.innerHTML = releaseRows(g.older, "Go back", "downgrade");
    orderButtons().forEach((b) => {
      b.disabled = working;
      b.addEventListener("click", () => order(b.getAttribute("data-update-commit")));
    });
  };

  const loadCatalog = async (refresh) => {
    const recheck = q("[data-update-recheck]");
    if (recheck) recheck.disabled = true;
    try {
      catalog = await loadReleaseCatalog({ fetchBox: fetchOn(body.serverFqdn), currentCommit, refresh });
      renderCatalog();
    } catch (e) {
      if (!catalog) {
        latestEl.innerHTML = `<p class="note small">Couldn't check for releases: ${escapeHtml(humanError(e))} You can still enter a release under Advanced.</p>`;
      } else if (recheck) {
        recheck.disabled = false;
      }
    }
  };

  const showChooser = () => {
    resultEl.classList.add("hidden");
    resultEl.innerHTML = "";
    chooseEl.classList.remove("hidden");
    cancelBtn.textContent = "Cancel";
    if (!catalogRequested) {
      catalogRequested = true;
      loadCatalog(false);
    }
  };

  // The post-send state: the order this device sent and is waiting on.
  const showSent = (pending) => {
    chooseEl.classList.add("hidden");
    resultEl.innerHTML = renderPendingUpdate(pending, { formatWhen, escapeHtml });
    resultEl.classList.remove("hidden");
    cancelBtn.textContent = "Done";
    resultEl.querySelector("[data-update-send-again]")?.addEventListener("click", showChooser);
    resultEl.querySelector("[data-update-forget]")?.addEventListener("click", () => {
      clearPendingUpdate(serverFqdn);
      showChooser();
    });
  };

  const targetValue = () => targetEl.value.trim().toLowerCase();
  function refreshTarget() {
    const t = targetValue();
    let problem = null;
    if (t.length > 0 && !COMMIT_SHA_RE.test(t)) {
      problem = "Enter the full 40-character commit hash of the blessed release.";
    } else if (t === from) {
      problem = "The server is already running this release.";
    }
    hintEl.textContent = problem || "";
    hintEl.classList.toggle("hidden", !problem);
    goBtn.disabled = working || problem !== null || t.length === 0;
  }

  async function order(targetCommit) {
    if (working || done) return;
    errEl.classList.add("hidden");
    setWorking(true);
    let sent;
    try {
      sent = await orderServerUpdate({
        serverDomain: serverFqdn,
        targetCommit,
        fromCommit: currentCommit,
        username: session.username || body.username,
        umk: session.umk,
        irkPubHex: bytesToHex(session.irk.publicKey),
        // Slice D: the update order is a SENSITIVE order — signed with the
        // admin root (when present); the co-signed mailbox-auth stays the
        // IRK (tag-routed by the gated signer).
        signWithIrk: sensitiveSigner(),
      }, { targetTag: tagFor(targetCommit) });
    } catch (e) {
      errEl.textContent = humanError(e);
      errEl.classList.remove("hidden");
      setWorking(false);
      return;
    }
    done = true;
    showSent(sent.pending);
    toast("Update ordered", "ok");
  }

  return new Promise((resolve, reject) => {
    const onClose = () => {
      cleanup();
      if (done) resolve({ ok: true });
      else reject({ code: "cancelled" });
    };
    dlg.addEventListener("close", onClose, { once: true });
    cancelBtn.addEventListener("click", () => dlg.close());
    targetEl.addEventListener("input", refreshTarget);
    goBtn.addEventListener("click", () => {
      const t = targetValue();
      if (goBtn.disabled || !COMMIT_SHA_RE.test(t) || t === from) return;
      order(t);
    });
    const pending = sendAgain ? null : reconcilePendingUpdate(serverFqdn, body);
    if (pending) showSent(pending);
    else showChooser();
  });
}

// ---- Migrate to new hardware (docs/server-migration.md) ----------------

function wireMigrate(body) {
  $("migrate-start-btn")?.addEventListener("click", () => {
    openMigrateDialog(body).catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("server migration failed", e);
        toast(humanError(e), "err");
      }
    });
  });
}

const MIGRATION_DISPOSITION_LABELS = {
  keep: "Keep the old disk (manual fallback copy)",
  "wipe-after-handoff": "Wipe the old box after the new one takes over (recommended)",
};

// One dialog, two modes: no session yet → the admin-signed INITIATE ceremony;
// live session → the 8-step progress timeline with the phase-appropriate
// action (hand off / abort). Abort is offered at every pre-take-over step
// with honest copy — the old server stays active with all its data.
async function openMigrateDialog(body) {
  const session = getSession();
  if (!session.umk || !session.irk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const serverFqdn = body.serverFqdn;
  const username = session.username || body.username;
  const signerArgs = () => ({
    serverDomain: serverFqdn,
    username,
    umk: session.umk,
    irkPubHex: bytesToHex(session.irk.publicKey),
    // Slice D: the migration order/control sign with the admin root (when
    // present); the co-signed mailbox-auth stays the IRK (tag-routed).
    signWithIrk: sensitiveSigner(),
  });

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Migrate to new hardware");
  dlg.innerHTML = `
    <h3 class="modal-title">Migrate ${escapeHtml(serverFqdn)}</h3>
    <p class="modal-message" data-mig-loading>Checking for a migration in progress…</p>
    <div class="hidden" data-mig-init>
      <p class="note" data-mig-backup></p>
      <label class="caption mt-2">What happens to the old box's disk?</label>
      <select class="full-width" data-mig-disposition>
        ${MIGRATION_DISPOSITIONS.map(
          (d) => `<option value="${escapeHtml(d)}"${d === DEFAULT_MIGRATION_DISPOSITION ? " selected" : ""}>${escapeHtml(MIGRATION_DISPOSITION_LABELS[d])}</option>`,
        ).join("")}
      </select>
      <p class="note small err-text hidden" data-mig-gate></p>
      <p class="note small mt-2">The old box is wiped only <em>after</em> the new
      one has restored the data and taken over the name. If anything fails, the
      old box keeps serving with all its data.</p>
    </div>
    <div class="hidden" data-mig-progress>
      <ul class="mt-2" data-mig-steps style="list-style:none;padding-left:0"></ul>
      <p class="note" data-mig-wait></p>
    </div>
    <p class="modal-error err-text hidden" data-mig-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-mig-cancel>Close</button>
      <button class="danger hidden" data-mig-action></button>
    </div>
    <div class="mt-2 hidden" data-mig-abort-row>
      <button class="secondary full-width" data-mig-abort>Abort migration — old server stays active with all data</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const loadingEl = dlg.querySelector("[data-mig-loading]");
  const initEl = dlg.querySelector("[data-mig-init]");
  const backupEl = dlg.querySelector("[data-mig-backup]");
  const dispoEl = dlg.querySelector("[data-mig-disposition]");
  const gateEl = dlg.querySelector("[data-mig-gate]");
  const progressEl = dlg.querySelector("[data-mig-progress]");
  const stepsEl = dlg.querySelector("[data-mig-steps]");
  const waitEl = dlg.querySelector("[data-mig-wait]");
  const errEl = dlg.querySelector("[data-mig-error]");
  const actionBtn = dlg.querySelector("[data-mig-action]");
  const cancelBtn = dlg.querySelector("[data-mig-cancel]");
  const abortRow = dlg.querySelector("[data-mig-abort-row]");
  const abortBtn = dlg.querySelector("[data-mig-abort]");

  let ctx = { retiredStkPubHex: null, backupEnrolled: false };
  let pollTimer = null;
  const cleanup = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (dlg.open) dlg.close();
    dlg.remove();
  };

  const showError = (e) => {
    errEl.textContent = humanError(e);
    errEl.classList.remove("hidden");
  };

  // -- progress mode --------------------------------------------------------
  const renderProgress = (s) => {
    loadingEl.classList.add("hidden");
    initEl.classList.add("hidden");
    progressEl.classList.remove("hidden");
    stepsEl.innerHTML = migrationSteps(s, Date.now())
      .map((st) => {
        const mark = st.state === "done" ? "✓" : st.state === "active" ? "…" : "·";
        const cls = st.state === "done" ? "" : st.state === "active" ? "" : "dim";
        return `<li class="${cls}" style="padding:2px 0">${mark} ${escapeHtml(st.label)}</li>`;
      })
      .join("");
    waitEl.textContent = migrationWaitCopy(s, Date.now());

    // Phase-appropriate primary action. Confirm-ready + freeze are ONE guided
    // tap ("hand off"): the confirm is the health checkpoint the user is
    // looking at right now, and splitting them into two ceremonies adds a
    // signature prompt without adding safety (the machine still enforces
    // pre-seeded → ready → freezing server-side).
    actionBtn.classList.add("hidden");
    abortRow.classList.add("hidden");
    if (s.abortedAt == null && s.takenOverAt == null) {
      abortRow.classList.remove("hidden");
    }
    if (s.phase === "pre-seeded") {
      actionBtn.textContent = "Hand off to the new box now";
      actionBtn.disabled = false;
      actionBtn.classList.remove("hidden");
      actionBtn.onclick = () => runHandOff(s, /*confirmFirst*/ true);
    } else if (s.phase === "ready") {
      actionBtn.textContent = "Freeze old server and hand off";
      actionBtn.disabled = false;
      actionBtn.classList.remove("hidden");
      actionBtn.onclick = () => runHandOff(s, /*confirmFirst*/ false);
    }
    if (s.done || s.abortedAt != null) {
      clearMigrationHold(serverFqdn);
      cancelBtn.textContent = "Done";
    }
  };

  const poll = async () => {
    try {
      const s = await fetchMigration(serverFqdn);
      if (!dlg.open) return;
      if (s) renderProgress(s);
    } catch {
      /* transient — keep the last render */
    }
    if (dlg.open) pollTimer = setTimeout(poll, 5000);
  };

  const runHandOff = async (s, confirmFirst) => {
    errEl.classList.add("hidden");
    actionBtn.disabled = true;
    const orig = actionBtn.textContent;
    actionBtn.textContent = "Signing…";
    try {
      if (confirmFirst) await confirmMigrationReady(signerArgs());
      // Freeze = the graceful-decommission deposit, session-validated. If this
      // half fails after confirm-ready landed, the next poll renders the
      // `ready` phase and the button retries the freeze alone.
      await freezeMigration({ ...signerArgs(), session: s });
      toast("Handing off — the old server is freezing", "ok");
      await poll();
    } catch (e) {
      showError(e);
    } finally {
      actionBtn.disabled = false;
      actionBtn.textContent = orig;
    }
  };

  abortBtn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    abortBtn.disabled = true;
    const orig = abortBtn.textContent;
    abortBtn.textContent = "Aborting…";
    try {
      await abortMigration(signerArgs());
      clearMigrationHold(serverFqdn);
      toast("Migration aborted — your old server stays active", "ok");
      await poll();
    } catch (e) {
      showError(e);
    } finally {
      abortBtn.disabled = false;
      abortBtn.textContent = orig;
    }
  });

  // -- initiate mode --------------------------------------------------------
  const renderInitiate = () => {
    loadingEl.classList.add("hidden");
    initEl.classList.remove("hidden");
    backupEl.textContent = ctx.backupEnrolled
      ? "Peer-backup is enrolled — the new box restores from it while this one keeps serving."
      : "No backup is enrolled for this server. The migration moves data THROUGH backup — enable backup first, or choose to keep the old disk.";
    actionBtn.textContent = "Start migration";
    actionBtn.classList.remove("hidden");

    const refreshGate = () => {
      // The restore rides peer-backup, so a no-backup box can only migrate
      // with `keep` (the old disk remains the fallback copy). Same fail-closed
      // posture as the replace pre-flight gate.
      const wipes = dispoEl.value === "wipe-after-handoff";
      const blocked = wipes && !ctx.backupEnrolled;
      if (blocked) {
        gateEl.textContent =
          "This server has no backup — enable backup first, or keep the old disk as the fallback.";
        gateEl.classList.remove("hidden");
      } else {
        gateEl.classList.add("hidden");
      }
      actionBtn.disabled = blocked || !ctx.retiredStkPubHex;
    };
    dispoEl.addEventListener("change", refreshGate);
    refreshGate();

    actionBtn.onclick = async () => {
      errEl.classList.add("hidden");
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = "Signing…";
      try {
        await startMigration({
          ...signerArgs(),
          oldStkPubHex: ctx.retiredStkPubHex,
          disposition: dispoEl.value,
        });
        // The SWK hold makes the NEXT added pod's SWK deposit migration-aware
        // (lib/serverMigration.js migrationSwkServerId).
        setMigrationHold(serverFqdn);
        toast("Migration started — now add the new box", "ok");
        waitEl.textContent =
          "Next: burn/apply a recipe for the NEW box via Add a server (any name — it becomes " +
          serverFqdn +
          " at take-over). It attaches here automatically once online.";
        await poll();
      } catch (e) {
        showError(e);
        actionBtn.disabled = false;
        actionBtn.textContent = orig;
      }
    };
  };

  return new Promise((resolve, reject) => {
    const onCancel = () => {
      cleanup();
      resolve({ ok: true });
    };
    dlg.addEventListener("close", onCancel, { once: true });
    cancelBtn.addEventListener("click", onCancel);

    void (async () => {
      // An in-flight session wins — render its timeline. Otherwise initiate.
      const existing = await fetchMigration(serverFqdn).catch(() => null);
      if (existing && existing.abortedAt == null) {
        renderProgress(existing);
        pollTimer = setTimeout(poll, 5000);
        return;
      }
      ctx = await resolveReplacementContext({ serverDomain: serverFqdn, username });
      if (!ctx.retiredStkPubHex) {
        loadingEl.classList.add("hidden");
        showError(
          new Error(
            "Couldn't read this box's current key from the directory — is it online? It must be reachable to migrate.",
          ),
        );
        return;
      }
      renderInitiate();
    })().catch((e) => {
      loadingEl.classList.add("hidden");
      showError(e);
      reject(e);
    });
  });
}

function wireDangerZone(serverFqdn, username, { pod = null } = {}) {
  $("revoke-server-btn")?.addEventListener("click", () => {
    openRevokeDialog(serverFqdn, username)
      .then(() => refreshAfterRevocationChange())
      .catch((e) => {
        if (e?.code !== "cancelled") {
          console.error("server revoke failed", e);
          toast(humanError(e), "err");
        }
      });
  });
  $("unrevoke-server-btn")?.addEventListener("click", () => {
    void runUnrevoke(serverFqdn, username);
  });
  $("delete-server-btn")?.addEventListener("click", () => {
    const session = getSession();
    if (!session.umk) {
      toast("Unlock the webapp first", "err");
      return;
    }
    void openDeleteServerDialog(
      {
        serverDomain: serverFqdn,
        username: session.username || username,
        // undefined (no /pods row) lets the delete flow look the box key up.
        identityPubKey: pod ? (pod.identityPubKey ?? null) : undefined,
      },
      {
        session,
        // One sensitive signer for the whole flow (order + release).
        signer: sensitiveSigner(),
        irkPubHex: session.irk ? bytesToHex(session.irk.publicKey) : "",
        toast,
        humanError,
        onDeleted: async () => {
          void liveSync.refresh?.().catch(() => {});
          const { enterHome } = await import("./home.js");
          await enterHome();
        },
      },
    );
  });
}

/** Re-read `.com`'s view and repaint, so the Danger zone flips between Revoke
 *  and Un-revoke. */
async function refreshAfterRevocationChange() {
  await liveSync.refresh?.().catch(() => {});
  if ($("view-server-detail")?.classList.contains("hidden")) return;
  await renderServerDetail().catch((e) => console.error(e));
}

async function runUnrevoke(serverFqdn, username) {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }
  const btn = $("unrevoke-server-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Restoring…"; }
  try {
    const out = await unrevokeServer({
      username: session.username || username,
      serverDomain: serverFqdn,
      umk: session.umk,
      signWithIrk: sensitiveSigner(),
    });
    toast(
      out.body?.alreadyActive
        ? "This server isn't revoked."
        : "Server restored. If it unlocks on its own, approve its unlock once from your phone.",
      "ok",
    );
    await refreshAfterRevocationChange();
  } catch (e) {
    console.error("server un-revoke failed", e);
    toast(humanError(e), "err");
    if (btn) { btn.disabled = false; btn.textContent = "Un-revoke server"; }
  }
}

async function openRevokeDialog(serverFqdn, username) {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Revoke server");
  dlg.innerHTML = `
    <h3 class="modal-title">Revoke ${escapeHtml(serverFqdn)}?</h3>
    <p class="modal-message">
      Locks this server out right away: it can't connect or unlock until you
      un-revoke it. Its name stays reserved. Use this if the box is lost or
      stolen. Other servers on your account stay running.
    </p>
    <fieldset class="mt-3">
      <legend class="caption">Reason</legend>
      ${REVOCATION_REASONS.map((r, i) => `
        <label class="row">
          <input type="radio" name="revoke-reason" value="${escapeHtml(r)}" ${i === 0 ? "checked" : ""} />
          <span class="value">${escapeHtml(reasonLabel(r))}</span>
        </label>
      `).join("")}
    </fieldset>
    <p class="modal-error err-text hidden" data-revoke-error></p>
    <div class="row-2 mt-3">
      <button class="secondary" data-revoke-cancel>Cancel</button>
      <button class="danger" data-revoke-go>Revoke</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  const cleanup = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  const cancelBtn = dlg.querySelector("[data-revoke-cancel]");
  const goBtn = dlg.querySelector("[data-revoke-go]");
  const errEl = dlg.querySelector("[data-revoke-error]");
  let abort = null;

  return new Promise((resolve, reject) => {
    const onCancel = () => {
      if (abort) abort.abort();
      cleanup();
      reject({ code: "cancelled" });
    };
    const onEscape = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); onCancel(); }
    };
    dlg.addEventListener("close", onCancel, { once: true });
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onEscape);

    goBtn.addEventListener("click", async () => {
      const reason = dlg.querySelector('input[name="revoke-reason"]:checked')?.value;
      if (!REVOCATION_REASONS.includes(reason)) {
        errEl.textContent = "Pick a reason.";
        errEl.classList.remove("hidden");
        return;
      }
      // Enter the 3-second countdown. The button label becomes a
      // tick and the Cancel button is the abort.
      abort = new AbortController();
      goBtn.disabled = true;
      try {
        await countdownConfirm({
          signal: abort.signal,
          onTick: (s) => {
            goBtn.textContent = s > 0 ? `Revoking in ${s}…` : "Revoking…";
          },
        });
        const revokeOut = await revokeServer({
          userId: username,
          revokedServerId: serverFqdn,
          reason,
          umk: session.umk,
          signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
        });
        if (revokeOut && revokeOut.pending) {
          // P14 Phase 2 — companion profile: open the polling sheet.
          document.removeEventListener("keydown", onEscape);
          dlg.removeEventListener("close", onCancel);
          cleanup();
          const { showCompanionPendingSheet, outcomeToastCopy } = await import(
            "../lib/companionPendingSheet.js"
          );
          const result = await showCompanionPendingSheet(revokeOut);
          if (result.outcome === "approved") {
            toast("Server revoked. It can't connect or unlock until you un-revoke it.", "ok");
            resolve();
          } else {
            const { text, kind } = outcomeToastCopy(result.outcome);
            toast(text, kind);
            resolve();
          }
          return;
        }
        toast("Server revoked. It can't connect or unlock until you un-revoke it.", "ok");
        document.removeEventListener("keydown", onEscape);
        dlg.removeEventListener("close", onCancel);
        cleanup();
        resolve();
      } catch (e) {
        if (e?.code === "cancelled") {
          // Returned to the picker so the user can re-confirm.
          goBtn.disabled = false;
          goBtn.textContent = "Revoke";
          return;
        }
        document.removeEventListener("keydown", onEscape);
        dlg.removeEventListener("close", onCancel);
        cleanup();
        reject(e);
      }
    });
  });
}

function reasonLabel(r) {
  switch (r) {
    case "lost": return "Lost";
    case "stolen": return "Stolen";
    case "decommissioned": return "Decommissioned";
    default: return r;
  }
}

export function initServerDetailView() {
  $("server-detail-back")?.addEventListener("click", () => show("view-home"));
  $("server-detail-refresh")?.addEventListener("click", () => {
    renderServerDetail().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterServerDetail(fqdn) {
  detailFqdn = typeof fqdn === "string" ? fqdn.toLowerCase() : "";
  show("view-server-detail");
  await renderServerDetail();
}
