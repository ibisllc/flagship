// Servers other accounts share with this one (docs/share-a-server.md §8):
// the "Shared with me" section on Home and the page for one shared server.
// The page shows only what the share's level reaches; the owner's own
// sections (power, transfer, updates, sharing, danger zone…) are not on it.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { toast } from "../lib/toast.js";
import { inlineConfirm } from "../lib/modal.js";
import { formatWhen } from "../lib/dateFormat.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";
import { listRow } from "../lib/uikit.js";
import { serverIcon } from "../lib/icons.js";
import { serverAppRows, appStatePillHtml } from "../lib/appPlacement.js";
import {
  ACCESS_LIST_HELP,
  ACCESS_PENDING_BADGE,
  ACCESS_SAVE,
  accessEditorState,
  accessErrorMessage,
  fetchServiceAccess,
  hasPendingInternetRequest,
  ruleCountText,
  sendAccessList,
} from "../lib/appAccess.js";
import {
  DATA_TITLE,
  LEVEL_TEXT,
  UNLOCK_TITLE,
  approveShareStartup,
  fetchShareStartups,
  leaveShare,
  loadSharedWithMe,
  shareBoxClient,
  shareErrorText,
  shareMemberSigner,
  signInToShare,
} from "../lib/serverShares.js";

registerView("view-shared-server", { tab: "home" });

const STARTUP_POLL_MS = 10_000;
const METRICS_POLL_MS = 15_000;

// ── Home: "Shared with me" ────────────────────────────────────────────

let homeSeq = 0;

function homeRowHtml(row) {
  const e = row.entry;
  const level = row.level ? LEVEL_TEXT[row.level] : "Shared with you";
  const pill =
    row.startups?.length > 0
      ? `<span class="pill warn">Waiting to start</span>`
      : row.status === "ready"
        ? `<span class="pill ok">Online</span>`
        : row.status === "waiting"
          ? `<span class="pill warn">Waiting for the owner</span>`
          : `<span class="pill">Can't reach</span>`;
  const approve = row.startups?.length > 0
    ? `<div class="row mt-2"><button class="full-width" data-shared-approve="${escapeHtml(e.shareId)}">Approve start-up</button></div>`
    : "";
  return `
      <div class="card server-card is-tappable" data-open-share="${escapeHtml(e.shareId)}">
        ${listRow({
          leading: { kind: "icon", svg: serverIcon, tone: row.status === "ready" ? "success" : "muted" },
          title: e.serverName || e.serverDomain,
          subtitle: `${level} · ${e.serverDomain}`,
          trailing: pill,
          trailingBelow: true,
        })}
        ${approve}
      </div>`;
}

/** The section's HTML for resolved rows. Pure, for tests and screenshots. */
export function sharedWithMeHtml(rows) {
  if (!rows.length) return "";
  return `
      <h2 class="mt-4">Shared with me</h2>
      ${rows.map(homeRowHtml).join("")}`;
}

export async function renderSharedWithMe() {
  const slot = $("shared-with-me");
  if (!slot) return;
  const my = ++homeSeq;
  if (!getSession()?.umk) {
    slot.innerHTML = "";
    return;
  }
  let rows;
  try {
    rows = await loadSharedWithMe();
  } catch {
    return;
  }
  await Promise.all(
    rows.map(async (r) => {
      if (r.status !== "ready" && r.unlockAtBoot) r.startups = await fetchShareStartups(r.entry).catch(() => []);
    }),
  );
  if (my !== homeSeq) return;
  slot.innerHTML = sharedWithMeHtml(rows);
  wireHome(slot, rows);
}

function wireHome(slot, rows) {
  slot.querySelectorAll("[data-open-share]").forEach((card) => {
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      const row = rows.find((r) => r.entry.shareId === card.getAttribute("data-open-share"));
      if (row) void enterSharedServer(row.entry);
    });
  });
  slot.querySelectorAll("[data-shared-approve]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rows.find((r) => r.entry.shareId === btn.getAttribute("data-shared-approve"));
      if (row) void enterSharedServer(row.entry);
    });
  });
}

// ── The shared server's page ──────────────────────────────────────────

let page = null;
let pageSeq = 0;
let startupTimer = null;
let metricsTimer = null;

function stopTimers() {
  if (startupTimer) clearInterval(startupTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  startupTimer = null;
  metricsTimer = null;
}

const onPage = (my) => my === pageSeq && !$("view-shared-server")?.classList.contains("hidden");

function fmtUptime(ms) {
  if (typeof ms !== "number" || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return [d ? `${d}d` : "", h ? `${h}h` : "", `${m % 60}m`].filter(Boolean).slice(0, 2).join(" ");
}

function humanBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function startupCardHtml(name, startups) {
  if (!startups.length) return "";
  return `
      <div class="card warning" id="shared-startup-card">
        <p class="weight-600">${escapeHtml(name)} is starting. Unlock it?</p>
        <p class="note">Its disk stays locked until you or the owner approve.</p>
        <button class="full-width mt-2" id="shared-startup-approve">Approve start-up</button>
      </div>`;
}

function leaveHtml(name) {
  return `
      <h2 class="mt-4">Leave</h2>
      <div class="card" id="shared-leave-card">
        <p class="note">Stop using ${escapeHtml(name)}. You lose access right away; the owner can share it with you again.</p>
        <button class="danger full-width mt-2" id="shared-leave-btn">Leave ${escapeHtml(name)}</button>
      </div>`;
}

function appRowHtml(app, raw, canManage) {
  const wants = canManage && hasPendingInternetRequest(raw) ? ` <span class="pill warn">${escapeHtml(ACCESS_PENDING_BADGE)}</span>` : "";
  return `
        <div class="shared-app" data-shared-app="${escapeHtml(app.serviceId)}">
          <div class="shared-app-head">
            <span class="shared-app-name"><span class="weight-600">${escapeHtml(app.name)}</span>${appStatePillHtml(app.state)}${wants}</span>
            ${canManage ? `<button class="secondary btn-xs" data-access-open="${escapeHtml(app.serviceId)}">Internet access</button>` : ""}
          </div>
          ${app.url ? `<a class="muted-sm mono text-xs truncate" href="${escapeHtml(app.url)}" target="_blank" rel="noopener">${escapeHtml(app.url.replace(/^https?:\/\//, ""))}</a>` : ""}
          <div class="hidden mt-2" data-access-editor="${escapeHtml(app.serviceId)}"></div>
        </div>`;
}

/**
 * The page body for a share that signed in. `me` is `/api/shares/me`,
 * `detail` the server-detail answer, `apps` its apps list. Pure, so tests
 * can check that nothing of the owner's renders.
 */
export function sharedServerHtml({ entry, me, detail, apps, startups = [] }) {
  const name = entry.serverName || entry.serverDomain;
  const canManage = me.level === "manage";
  const allowed = [LEVEL_TEXT[me.level] ?? me.level];
  if (me.unlockAtBoot) allowed.push(UNLOCK_TITLE.replace("this server's", "its"));
  if (me.seeAppData) allowed.push(DATA_TITLE);
  const rows = serverAppRows(apps ?? [], []);
  const raw = new Map((apps ?? []).map((a) => [a?.serviceId, a]));
  return `
      ${startupCardHtml(name, startups)}
      <div class="card">
        <div class="row"><span class="label">Address</span><span class="value">${escapeHtml(entry.serverDomain)}</span></div>
        <div class="row"><span class="label">Version</span><span class="value">${escapeHtml(
          typeof detail?.currentCommit === "string" ? detail.currentCommit.slice(0, 8) : "—",
        )}</span></div>
        <div class="row"><span class="label">Uptime</span><span class="value">${escapeHtml(fmtUptime(detail?.uptimeMs))}</span></div>
        <div class="row"><span class="label">Apps</span><span class="value">${rows.length}</span></div>
        <p class="faint-sm mt-1" data-shared-allowed>You: ${escapeHtml(allowed.join(" · "))}</p>
      </div>
      <h2 class="mt-4">Live metrics</h2>
      <div class="card" id="shared-metrics-card">
        <div class="row"><span class="label">CPU</span><span class="value" id="sh-metrics-cpu">…</span></div>
        <div class="row"><span class="label">Memory</span><span class="value" id="sh-metrics-mem">…</span></div>
        <div class="row"><span class="label">Disk</span><span class="value" id="sh-metrics-disk">…</span></div>
        <div class="row"><span class="label">Network</span><span class="value" id="sh-metrics-net">…</span></div>
        <p class="note small" id="sh-metrics-at">Loading…</p>
      </div>
      <h2 class="mt-4">Apps</h2>
      <div class="card" id="shared-apps-card">
        ${rows.length ? rows.map((a) => appRowHtml(a, raw.get(a.serviceId), canManage)).join("") : `<p class="faint-sm">No apps on this server yet.</p>`}
      </div>
      ${leaveHtml(name)}`;
}

function unreachableHtml(entry, message, startups) {
  const name = entry.serverName || entry.serverDomain;
  return `
      ${startupCardHtml(name, startups)}
      <div class="card">
        <div class="row"><span class="label">Address</span><span class="value">${escapeHtml(entry.serverDomain)}</span></div>
        <p class="note mt-2">${escapeHtml(message)}</p>
      </div>
      ${leaveHtml(name)}`;
}

export async function enterSharedServer(entry) {
  stopTimers();
  page = entry;
  show("view-shared-server");
  await renderSharedServer();
}

async function renderSharedServer() {
  const entry = page;
  if (!entry) return;
  const my = ++pageSeq;
  const root = $("shared-server-content");
  if (!root) return;
  const name = entry.serverName || entry.serverDomain;
  const title = $("shared-server-title");
  if (title) title.textContent = name;
  const sub = $("shared-server-sub");
  if (sub) sub.textContent = "Shared with you";
  root.innerHTML = skeletonCards(2);

  const client = shareBoxClient(entry);
  let me;
  let detail;
  let apps;
  try {
    await signInToShare(entry);
    [me, detail, apps] = await Promise.all([
      client.fetch("/api/shares/me"),
      client.fetch("/api/screens/server-detail"),
      client.fetch("/api/screens/apps-list").then((b) => b?.apps ?? []),
    ]);
  } catch (e) {
    if (!onPage(my)) return;
    if (e?.code === "share-ended" || e?.body?.code === "share-ended") {
      root.innerHTML = `<div class="card"><p class="note">${escapeHtml(name)} isn't shared with you anymore.</p></div>`;
      return;
    }
    const message =
      e?.code === "not-shared"
        ? "The owner hasn't confirmed yet. Read them the code you were shown when you accepted."
        : `Couldn't reach ${name}. It may be off or starting.`;
    const startups = await fetchShareStartups(entry).catch(() => []);
    if (!onPage(my)) return;
    root.innerHTML = unreachableHtml(entry, message, startups);
    wirePage(entry, my, { canManage: false, startups });
    pollStartups(entry, my);
    return;
  }
  if (!onPage(my)) return;
  if (sub) sub.textContent = `Shared with you · ${LEVEL_TEXT[me.level] ?? me.level}`;
  const startups = me.unlockAtBoot ? await fetchShareStartups(entry).catch(() => []) : [];
  if (!onPage(my)) return;
  root.innerHTML = sharedServerHtml({ entry, me, detail, apps, startups });
  wirePage(entry, my, { canManage: me.level === "manage", startups, apps });
  startMetrics(entry, client, my);
  if (me.unlockAtBoot) pollStartups(entry, my);
}

function wirePage(entry, my, { canManage, startups, apps = [] }) {
  const name = entry.serverName || entry.serverDomain;
  $("shared-leave-btn")?.addEventListener("click", async (ev) => {
    const ok = await inlineConfirm({
      title: `Leave ${name}?`,
      message: "You lose access right away. The owner can share it with you again.",
      okLabel: "Leave",
      danger: true,
    });
    if (!ok) return;
    const btn = ev.currentTarget;
    if (btn) btn.disabled = true;
    try {
      await leaveShare(entry);
      toast(`You left ${name}`, "ok");
      const { enterHome } = await import("./home.js");
      await enterHome();
    } catch (e) {
      toast(shareErrorText(e), "err");
      if (btn) btn.disabled = false;
    }
  });
  wireStartup(entry, my, startups);
  if (!canManage) return;
  document.querySelectorAll("[data-access-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-access-open");
      const app = serverAppRows(apps, []).find((a) => a.serviceId === id);
      void toggleAccessEditor(entry, id, app?.name ?? id);
    });
  });
}

function wireStartup(entry, my, startups) {
  const btn = $("shared-startup-approve");
  if (!btn || !startups.length) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Approving…";
    try {
      for (const req of startups) await approveShareStartup(entry, req);
      toast(`${entry.serverName || entry.serverDomain} is unlocking`, "ok");
      $("shared-startup-card")?.remove();
    } catch (e) {
      toast(shareErrorText(e), "err");
      btn.disabled = false;
      btn.textContent = "Approve start-up";
    }
  });
}

function pollStartups(entry, my) {
  if (startupTimer) clearInterval(startupTimer);
  startupTimer = setInterval(async () => {
    if (!onPage(my)) return stopTimers();
    if ($("shared-startup-card")) return;
    const startups = await fetchShareStartups(entry).catch(() => []);
    if (!onPage(my) || !startups.length || $("shared-startup-card")) return;
    $("shared-server-content")?.insertAdjacentHTML("afterbegin", startupCardHtml(entry.serverName || entry.serverDomain, startups));
    wireStartup(entry, my, startups);
  }, STARTUP_POLL_MS);
}

function startMetrics(entry, client, my) {
  const tick = async () => {
    if (!onPage(my)) return stopTimers();
    try {
      const m = await client.fetch(`/api/screens/server-metrics/${encodeURIComponent(entry.serverDomain)}`);
      if (!onPage(my)) return;
      const set = (id, v) => {
        const el = $(id);
        if (el) el.textContent = v;
      };
      set("sh-metrics-cpu", `${(m.cpuPercent ?? 0).toFixed(1)}%`);
      set("sh-metrics-mem", `${humanBytes(m.memUsedBytes)} / ${humanBytes(m.memTotalBytes)}`);
      set("sh-metrics-disk", `${humanBytes(m.diskUsedBytes)} / ${humanBytes(m.diskTotalBytes)}`);
      set("sh-metrics-net", `↓ ${humanBytes(m.netRxBytesPerSec)}/s · ↑ ${humanBytes(m.netTxBytesPerSec)}/s`);
      set("sh-metrics-at", `Collected ${formatWhen(m.collectedAt)}`);
    } catch {
      const at = $("sh-metrics-at");
      if (at && onPage(my)) at.textContent = "Couldn't read metrics from this server.";
    }
  };
  void tick();
  metricsTimer = setInterval(tick, METRICS_POLL_MS);
}

async function toggleAccessEditor(entry, serviceId, appName) {
  const slot = document.querySelector(`[data-access-editor="${CSS.escape(serviceId)}"]`);
  if (!slot) return;
  if (!slot.classList.contains("hidden")) {
    slot.classList.add("hidden");
    slot.innerHTML = "";
    return;
  }
  slot.classList.remove("hidden");
  slot.innerHTML = `<p class="faint-sm">Loading…</p>`;
  const client = shareBoxClient(entry);
  let access;
  try {
    access = await fetchServiceAccess(serviceId, client.fetch);
  } catch (e) {
    slot.innerHTML = `<p class="err-text">${escapeHtml(accessErrorMessage(e))}</p>`;
    return;
  }
  if (!access) {
    slot.innerHTML = `<p class="err-text">This server doesn't support access lists yet.</p>`;
    return;
  }
  let saved = access.list;
  slot.innerHTML = `
      <p class="note">${escapeHtml(ACCESS_LIST_HELP)}</p>
      <textarea class="access-editor" rows="8" spellcheck="false" autocapitalize="off" autocomplete="off"
        aria-label="${escapeHtml(appName)} access list">${escapeHtml(access.list)}</textarea>
      <div data-access-errors aria-live="polite"></div>
      <p class="muted-sm mt-1" data-access-count></p>
      <button class="full-width mt-2" data-access-save disabled>${escapeHtml(ACCESS_SAVE)}</button>`;
  const ta = slot.querySelector("textarea");
  const save = slot.querySelector("[data-access-save]");
  const paint = () => {
    const st = accessEditorState(ta.value, saved);
    slot.querySelector("[data-access-errors]").innerHTML = st.errors
      .map((e) => `<p class="err-text text-sm"><span class="mono">Line ${e.line}</span>: ${escapeHtml(e.message)}</p>`)
      .join("");
    slot.querySelector("[data-access-count]").textContent = st.errors.length ? "" : ruleCountText(st.rules);
    save.disabled = !st.canSave;
  };
  ta.addEventListener("input", paint);
  paint();
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const next = await sendAccessList({
        serverDomain: entry.serverDomain,
        serviceId,
        list: ta.value,
        umk: getSession().umk,
        signWithIrk: await shareMemberSigner(entry),
        fetchJson: client.fetch,
      });
      saved = next.list;
      ta.value = next.list;
      toast("Access list saved", "ok");
    } catch (e) {
      toast(accessErrorMessage(e), "err");
    } finally {
      save.textContent = ACCESS_SAVE;
      paint();
    }
  });
}

export function initSharedServerView() {
  $("shared-server-back")?.addEventListener("click", async () => {
    stopTimers();
    const { enterHome } = await import("./home.js");
    await enterHome();
  });
  $("shared-server-refresh")?.addEventListener("click", () => {
    void renderSharedServer();
  });
}
