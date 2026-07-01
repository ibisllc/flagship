// P2.1 — server-detail view. Calls /api/screens/server-detail (P1.1).
// Also hosts the per-server "auto-unlock" toggle (auto_unlock_lease_design.md)
// and the P13 per-server kill-switch danger zone.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import {
  enableLongLived,
  listLeases,
  revokeLease,
} from "../lib/leases.js";
import {
  countdownConfirm,
  revokeServer,
  REVOCATION_REASONS,
} from "../lib/revokeServer.js";
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
import { setPreferredServer, isPreferredServer } from "../lib/setLeader.js";
import { createTransferOffer, buildTransferLink } from "../lib/serverTransfer.js";
import {
  resolveReplacementContext,
  preflightGate,
  runReplacement,
  DISK_DISPOSITIONS,
  DEFAULT_DISPOSITION,
} from "../lib/serverReplacement.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

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
  return new Date(unixMs).toLocaleString();
}

export async function renderServerDetail() {
  const root = $("server-detail-content");
  root.innerHTML = skeletonCards(2);
  try {
    const body = await screensFetch("/api/screens/server-detail");
    root.innerHTML = `
      <div class="card">
        <div class="row"><span class="label">FQDN</span><span class="value">${escapeHtml(body.serverFqdn)}</span></div>
        <div class="row"><span class="label">Username</span><span class="value">${escapeHtml(body.username)}</span></div>
        <div class="row"><span class="label">Daemon</span><span class="value">${escapeHtml(body.daemonVersion)}</span></div>
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
          as your preferred server makes it lead by default whenever it's online.
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

      <h2 class="mt-4">Danger zone</h2>
      <div class="card" id="danger-zone-card" data-server-fqdn="${escapeHtml(body.serverFqdn)}" data-username="${escapeHtml(body.username)}">
        <p class="note">
          Revoke this server when the box is lost, stolen, or being
          decommissioned. The box will refuse to boot on the next reboot —
          this cannot be undone.
        </p>
        <button id="revoke-server-btn" class="danger full-width mt-2">Revoke this server</button>
      </div>
    `;
    wireAutoUnlock(body.serverFqdn);
    wireFrontPage(body);
    wireLockPower(body);
    wireDeadMan(body);
    wireJournal(body);
    wirePreferredServer(body);
    wireTransfer(body);
    wireReplace(body);
    wireDangerZone(body.serverFqdn, body.username);
    startMetricsPolling(body.serverFqdn);
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
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
      toast(`auto-unlock on; lease expires ${new Date(r.expiresAt).toLocaleString()}`, "ok");
      await refreshLeases(serverFqdn);
    } catch (e) {
      toast(`enable failed: ${e.message ?? e}`, "err");
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
      <button class="secondary btn-xs" data-action="revoke-lease" data-lease-id="${escapeHtml(l.leaseId)}">Revoke</button>
    </div>
  `).join("");
  list.querySelectorAll('[data-action="revoke-lease"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-lease-id");
      if (!id) return;
      btn.disabled = true;
      try {
        await revokeLease(serverFqdn, id);
        toast(`revoked lease ${id.slice(0, 8)}…`, "ok");
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
function startMetricsPolling(serverFqdn) {
  // Cancel any prior poller (back+forward navigation re-enters this).
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  const tick = async () => {
    // Stop polling when the user navigates away.
    if ($("view-server-detail")?.classList.contains("hidden")) {
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
      return;
    }
    try {
      const m = await screensFetch(
        `/api/screens/server-metrics/${encodeURIComponent(serverFqdn)}`,
      );
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
      if (at) at.textContent = `Collected ${new Date(m.collectedAt).toLocaleTimeString()}`;
    } catch (e) {
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

  const baseUrl = getPodBaseUrl();
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
        signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
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
  const baseUrl = getPodBaseUrl();
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
  const baseUrl = getPodBaseUrl();
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
        signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
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
  const baseUrl = getPodBaseUrl();
  if (!baseUrl) throw Object.assign(new Error("Not paired with this server"), { code: "400" });
  return setDeadManPolicy({
    baseUrl,
    enabled,
    windowMs: preset.windowMs,
    graceMs: preset.graceMs,
    lockoutMode,
    umk: session.umk,
    signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
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
    const baseUrl = getPodBaseUrl();
    if (!baseUrl) return toast("Not paired with this server", "err");
    affirmBtn.disabled = true;
    affirmBtn.textContent = "Affirming…";
    try {
      const r = await affirmDeadMan({
        baseUrl,
        umk: session.umk,
        signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
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
          signWithIrk,
        });
        // Render the universal-link form (a phone Camera opens it straight
        // into the app; it doubles as the paste-able acquirer code).
        qrEl.value = buildTransferLink(out.qr);
        resultEl.classList.remove("hidden");
        goBtn.classList.add("hidden");
        confirmEl.disabled = true;
        cancelBtn.textContent = "Done";
        toast("Transfer code created", "ok");
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
          signWithIrk: (umk, bytes) => signWithIrk(umk, bytes),
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

function wireDangerZone(serverFqdn, username) {
  $("revoke-server-btn")?.addEventListener("click", () => {
    openRevokeDialog(serverFqdn, username).catch((e) => {
      if (e?.code !== "cancelled") {
        console.error("server revoke failed", e);
        toast(humanError(e), "err");
      }
    });
  });
}

async function openRevokeDialog(serverFqdn, username) {
  const session = getSession();
  if (!session.umk) {
    toast("Unlock the webapp first", "err");
    return;
  }

  const dlg = document.createElement("dialog");
  dlg.className = "modal-card";
  dlg.setAttribute("aria-label", "Revoke this server");
  dlg.innerHTML = `
    <h3 class="modal-title">Revoke this server?</h3>
    <p class="modal-message">
      Bricks the box on next boot — this cannot be undone.
      ${escapeHtml(serverFqdn)} will refuse to start, even with the
      correct passphrase. Other servers on your account stay running.
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
            toast("Server revoked. It will refuse to boot next time.", "ok");
            resolve();
          } else {
            const { text, kind } = outcomeToastCopy(result.outcome);
            toast(text, kind);
            resolve();
          }
          return;
        }
        toast("Server revoked. It will refuse to boot next time.", "ok");
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

export async function enterServerDetail() {
  show("view-server-detail");
  await renderServerDetail();
}
