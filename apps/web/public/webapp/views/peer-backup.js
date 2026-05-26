// Task #27 — Peer-backup participation view.
//
// Router slot: section id `view-peer-backup`. Reached from
// Settings → Peer-backup. Calls into the daemon's P9 Screens-BFF
// endpoints (landed daemon-side in af9cbc7).
//
// Surfaces:
//   1. Participation toggle (POST /api/screens/peer-backup/toggle).
//      When off, the pod neither stores shards for peers nor places
//      its own data on peers — read-only "unenrolled" state.
//   2. Peers backing YOU up (the pod uploads encrypted shards there;
//      we hold the secret share, peer hosts the bytes).
//   3. Peers YOU are backing up (you host their shards; you can't
//      read them — they are encrypted to the owner's BAK).
//   4. Shard health summary: total shards, durable shards (≥k
//      replicas), at-risk shards (< k replicas).
//   5. Repair status: current and last-run repair daemon ticks.
//
// BFF endpoints consumed:
//   GET  /api/screens/peer-backup/status   → PeerBackupStatusResponse
//   POST /api/screens/peer-backup/toggle   { participate: boolean }
//
// Honest production-data gaps (per af9cbc7):
//   - per-shard byte size (PeerBackupShardSummary.bytes) is reported
//     as 0 until the my-shard layer tracks it. We render that as
//     "size not tracked" rather than "0 B" so it doesn't look like
//     the shard is empty.
//   - `stats.yourBytesStored` returns 0 for the same reason — surfaced
//     as a friendly placeholder.
//   - peer liveness (`online`) is best-effort based on last challenge
//     timestamp; the warning pill is informational, not authoritative.
//   - repair-tick counters are 0 until the daemon wraps RepairDaemon
//     in the accumulator.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-peer-backup");

function fmtBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function fmtDate(unixMs) {
  if (typeof unixMs !== "number" || unixMs <= 0) return "never";
  return new Date(unixMs).toLocaleString();
}

// Daemon-side honest-zero accounting for fields the my-shard layer
// doesn't yet track (per af9cbc7). Render a clearer string than "0 B"
// when a byte counter is structurally 0.
function fmtBytesOrUntracked(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n === 0) return "not yet tracked";
  return fmtBytes(n);
}

function shardPill(shard) {
  const replicas = shard.replicas ?? 0;
  const k = shard.minReplicas ?? 3;
  if (replicas >= k * 2) return '<span class="pill ok">redundant</span>';
  if (replicas >= k) return '<span class="pill ok">durable</span>';
  if (replicas > 0) return '<span class="pill warn">at risk</span>';
  return '<span class="pill err">lost</span>';
}

export async function renderPeerBackup() {
  const root = $("peer-backup-content");
  if (!root) return;
  root.innerHTML = '<div class="card placeholder">loading peer-backup status…</div>';

  let body;
  try {
    body = await screensFetch("/api/screens/peer-backup/status");
  } catch (e) {
    if (e instanceof ScreensError) {
      if (e.status === 404) {
        // Older daemon — pre-P9 (af9cbc7). The view is stable; the
        // server just needs a newer daemon image to expose the BFF.
        root.innerHTML = `
          <div class="card placeholder">
            Peer-backup isn't available on this server yet — its daemon
            is running an older build (pre-P9). Update the daemon to
            get participation, shard health, and repair status here.
          </div>
        `;
        return;
      }
      if (e.status === 503) {
        // Daemon is up but peer-backup hasn't been configured for this
        // server. This is normal for fresh installs that opted out
        // during the first-run wizard.
        root.innerHTML = `
          <div class="card placeholder">
            Peer-backup hasn't been configured for this server yet.
            Re-run the first-run wizard, or contact your server admin
            to enable the peer-backup pool.
          </div>
        `;
        return;
      }
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    throw e;
  }

  const participating = body.participating === true;
  const peersBackingYouUp = body.peersBackingYouUp ?? [];
  const peersYouBackUp = body.peersYouBackUp ?? [];
  const shards = body.shards ?? [];
  const repair = body.repair ?? null;
  const stats = body.stats ?? {};

  const participationCard = `
    <div class="card">
      <div class="row row-top">
        <div>
          <div class="weight-600">
            Peer-backup pool
            ${participating ? '<span class="pill ok">participating</span>' : '<span class="pill">unenrolled</span>'}
          </div>
          <div class="muted-sm">
            ${participating
              ? "you host shards for peers and they host yours — opt out to leave the pool"
              : "you're not in the peer-backup pool — enable to get started"}
          </div>
        </div>
        <button id="peer-backup-toggle" class="${participating ? "secondary" : ""}">
          ${participating ? "Opt out" : "Enable"}
        </button>
      </div>
    </div>
  `;

  // If unenrolled and the user has never participated, short-circuit
  // the rest of the view — there is nothing else to show yet.
  if (!participating && peersBackingYouUp.length === 0 && peersYouBackUp.length === 0) {
    root.innerHTML = participationCard + `
      <div class="card placeholder mt-2">
        you're not in the peer-backup pool — enable to get started.
        Once enrolled this view will show shard health (your data
        across peers) and repair status (how those shards are kept
        healthy under churn).
      </div>
    `;
    $("peer-backup-toggle")?.addEventListener("click", () => runToggle(true));
    return;
  }

  // Participating-but-warming-up — opted in but the matchmaker
  // hasn't paired this server with any peers yet, and no shards
  // have been placed. Make this explicit so the user knows the
  // system is healthy, just empty.
  const isWarmingUp = participating
    && peersBackingYouUp.length === 0
    && peersYouBackUp.length === 0
    && shards.length === 0;

  const warmingUpCard = isWarmingUp
    ? `
      <div class="card placeholder mt-2">
        You're in the peer-backup pool — the matchmaker hasn't paired
        this server with any peers yet. Once that happens you'll see
        peers and shard health populate below; nothing else for you
        to do here.
      </div>
    `
    : "";

  const statsCard = `
    <h3 class="mt-4">Shard health</h3>
    <div class="card">
      <div class="row"><span class="label">total shards</span><span class="value">${escapeHtml(String(stats.total ?? shards.length))}</span></div>
      <div class="row"><span class="label">durable</span><span class="value">${escapeHtml(String(stats.durable ?? 0))}</span></div>
      <div class="row"><span class="label">at risk</span><span class="value">${escapeHtml(String(stats.atRisk ?? 0))}</span></div>
      <div class="row"><span class="label">your bytes stored</span><span class="value">${escapeHtml(fmtBytesOrUntracked(stats.yourBytesStored))}</span></div>
      <div class="row"><span class="label">peer bytes hosted</span><span class="value">${escapeHtml(fmtBytes(stats.peerBytesHosted))}</span></div>
    </div>
  `;

  const peersBackingYouUpCard = `
    <h3 class="mt-4">Peers backing you up</h3>
    ${peersBackingYouUp.length === 0
      ? '<div class="card placeholder">No peers yet — the repair daemon will recruit some on its next tick.</div>'
      : peersBackingYouUp.map((p) => `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(p.peerFqdn)}</div>
              <div class="faint-sm">
                ${escapeHtml(String(p.shardsHosted ?? 0))} shard${p.shardsHosted === 1 ? "" : "s"}
                · last seen ${escapeHtml(fmtDate(p.lastSeenMs))}
                ${p.online ? '<span class="pill ok">online</span>' : '<span class="pill warn">offline</span>'}
              </div>
            </div>
          </div>
        </div>
      `).join("")}
  `;

  const peersYouBackUpCard = `
    <h3 class="mt-4">Peers you back up</h3>
    ${peersYouBackUp.length === 0
      ? '<div class="card placeholder">Not hosting any peer shards yet — the matchmaker hasn\'t paired you with anyone yet.</div>'
      : peersYouBackUp.map((p) => `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(p.peerFqdn)}</div>
              <div class="faint-sm">
                hosting ${escapeHtml(String(p.shardsHosted ?? 0))} shard${p.shardsHosted === 1 ? "" : "s"}
                · ${escapeHtml(fmtBytes(p.bytesHosted))}
                · last fetched ${escapeHtml(fmtDate(p.lastFetchedMs))}
              </div>
            </div>
          </div>
        </div>
      `).join("")}
  `;

  const shardsCard = shards.length === 0
    ? ""
    : `
      <h3 class="mt-4">Your shards</h3>
      ${shards.slice(0, 20).map((s) => `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="value text-xs">${escapeHtml(s.shardId ?? "?")}</div>
              <div class="faint-sm">
                ${escapeHtml(String(s.replicas ?? 0))}/${escapeHtml(String(s.minReplicas ?? 3))} replicas
                · ${escapeHtml(fmtBytesOrUntracked(s.bytes))}
              </div>
            </div>
            ${shardPill(s)}
          </div>
        </div>
      `).join("")}
      ${shards.length > 20 ? `<div class="card placeholder">+ ${shards.length - 20} more shards (not rendered)</div>` : ""}
    `;

  const repairCard = `
    <h3 class="mt-4">Repair status</h3>
    <div class="card">
      <div class="row"><span class="label">state</span><span class="value">${escapeHtml(repair?.state ?? "idle")}</span></div>
      <div class="row"><span class="label">last tick</span><span class="value">${escapeHtml(fmtDate(repair?.lastTickMs))}</span></div>
      <div class="row"><span class="label">repairs queued</span><span class="value">${escapeHtml(String(repair?.queued ?? 0))}</span></div>
      <div class="row"><span class="label">repairs done (24h)</span><span class="value">${escapeHtml(String(repair?.completed24h ?? 0))}</span></div>
      ${repair?.lastError ? `<div class="row"><span class="label">last error</span><span class="value err-text">${escapeHtml(repair.lastError)}</span></div>` : ""}
    </div>
  `;

  root.innerHTML = participationCard + warmingUpCard + statsCard
    + peersBackingYouUpCard + peersYouBackUpCard + shardsCard + repairCard;
  $("peer-backup-toggle")?.addEventListener("click", () => runToggle(!participating));
}

async function runToggle(nextParticipate) {
  const btn = $("peer-backup-toggle");
  if (btn) {
    btn.disabled = true;
    btn.textContent = nextParticipate ? "enabling…" : "opting out…";
  }
  try {
    await screensFetch("/api/screens/peer-backup/toggle", {
      method: "POST",
      body: JSON.stringify({ participate: nextParticipate }),
    });
    toast(nextParticipate ? "peer-backup enabled" : "peer-backup disabled");
    await renderPeerBackup();
  } catch (e) {
    toast(e.message ?? String(e), "err");
    if (btn) {
      btn.disabled = false;
      btn.textContent = nextParticipate ? "Enable" : "Opt out";
    }
  }
}

export function initPeerBackupView() {
  $("peer-backup-back")?.addEventListener("click", () => show("view-home"));
  $("peer-backup-refresh")?.addEventListener("click", () => {
    renderPeerBackup().catch((e) => toast(String(e), "err"));
  });
}

export async function enterPeerBackup() {
  show("view-peer-backup");
  await renderPeerBackup();
}
