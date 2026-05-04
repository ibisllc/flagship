// Flagship Deck — desktop cast surface. Reads the paired sessionId from the
// URL or sessionStorage, fetches /api/me/servers, and renders the dashboard.
//
// The deck holds NO master keys. Sensitive operations are RPCs to the
// primary device over the encrypted relay (next iteration); for v1 the
// deck is read-only and simply lists the user's servers + apps.

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getSessionId() {
  const url = new URLSearchParams(location.search).get("session");
  if (url) {
    try { sessionStorage.setItem("flagship_session_id", url); } catch {}
    return url;
  }
  try { return sessionStorage.getItem("flagship_session_id"); } catch { return null; }
}

async function checkPaired(sid) {
  try {
    const r = await fetch("/api/desktop/pair/" + encodeURIComponent(sid) + "/status");
    const body = await r.json();
    return body.status === "paired";
  } catch {
    return false;
  }
}

function renderUnpaired(reason) {
  const line = $("session-line");
  line.classList.add("err");
  line.innerHTML = `${escapeHtml(reason)} — <a href="/login.html">connect a primary device</a>`;
  $("servers-grid").innerHTML = '<div class="card placeholder">No paired session.</div>';
}

async function renderServers(sid) {
  const grid = $("servers-grid");
  try {
    const r = await fetch("/api/me/servers?sessionId=" + encodeURIComponent(sid));
    if (!r.ok) {
      grid.innerHTML = `<div class="card placeholder">Failed to load servers (${r.status}).</div>`;
      return;
    }
    const body = await r.json();
    if (!body.servers.length) {
      grid.innerHTML = '<div class="card placeholder">No servers yet — order one from your primary device.</div>';
      return;
    }
    grid.innerHTML = "";
    for (const s of body.servers) {
      const card = document.createElement("div");
      card.className = "card";
      const status = s.revoked
        ? `<span class="pill err">revoked: ${escapeHtml(s.revoked.reason)}</span>`
        : '<span class="pill ok">active</span>';
      card.innerHTML = `
        <div class="id">${escapeHtml(s.serverId)}</div>
        <div class="meta">${status}<span>registered ${new Date(s.registeredAt).toLocaleDateString()}</span></div>
      `;
      grid.appendChild(card);
    }
  } catch (e) {
    grid.innerHTML = `<div class="card placeholder">${escapeHtml(String(e))}</div>`;
  }
}

async function boot() {
  const sid = getSessionId();
  if (!sid) {
    renderUnpaired("no paired session");
    return;
  }
  const ok = await checkPaired(sid);
  if (!ok) {
    renderUnpaired("session expired or revoked");
    return;
  }
  const line = $("session-line");
  line.classList.add("ok");
  line.textContent = "session " + sid.slice(0, 8) + "…";
  await renderServers(sid);
}

boot().catch((e) => {
  $("session-line").classList.add("err");
  $("session-line").textContent = String(e);
});
