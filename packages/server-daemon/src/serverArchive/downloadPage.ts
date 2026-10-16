/**
 * The page a backup's download link opens in a browser (docs/server-backup-
 * and-clone.md, "Download in a browser"). Served by the box itself, self-
 * contained (no remote assets, like the knock page), `noindex`.
 *
 * It shows a QR for the owner's Flagship app and a 6-digit code; the app shows
 * the same code, asks for Face ID and signs the approval to the box. The page
 * polls until the box has a valid signature for its request, then starts the
 * download of the one `.flagship` file (straight to disk, resumable) and keeps
 * a button to start it again.
 */
import { renderQrSvg } from "../qrSvg.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderDownloadPage(a: {
  appLink: string;
  code: string;
  fileName: string;
  sizeText: string;
  statusUrl: string;
  fileUrl: string;
  expiresText: string;
}): string {
  const qr = renderQrSvg(a.appLink, { size: 220, foreground: "#0f172a" });
  const cfg = JSON.stringify({ statusUrl: a.statusUrl, fileUrl: a.fileUrl }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Download a server backup — Flagship</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#f8fafc; color:#0f172a; }
  @media (prefers-color-scheme: dark){ body{ background:#0b1220; color:#e2e8f0 } .card{ background:#111a2e !important } .muted{ color:#94a3b8 !important } }
  .card { background:#fff; max-width:400px; width:calc(100% - 32px); border-radius:16px; padding:28px 24px;
    box-shadow:0 10px 40px rgba(2,6,23,.12); text-align:center; }
  h1 { font-size:19px; margin:0 0 6px; }
  .muted { color:#475569; font-size:14px; margin:0 0 14px; }
  .qr { width:220px; height:220px; margin:8px auto 10px; background:#fff; border-radius:8px; padding:6px; }
  .code { font:600 28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.18em; margin:6px 0 14px; }
  .btn { display:inline-block; width:100%; box-sizing:border-box; padding:12px 16px; border:0; border-radius:12px;
    background:#14b8a6; color:#fff; font-weight:600; font-size:15px; cursor:pointer; text-decoration:none; }
  .hidden { display:none; }
  .err { color:#dc2626; font-size:14px; }
</style>
</head>
<body>
<main class="card">
  <h1>Download a server backup</h1>
  <p class="muted">${esc(a.fileName)} (${esc(a.sizeText)})</p>
  <div id="ask">
    <p class="muted">Scan this with the Flagship app on your phone and approve with Face ID. The app shows the same code:</p>
    <div class="qr" aria-label="QR code for the Flagship app">${qr}</div>
    <div class="code" aria-label="Approval code">${esc(a.code)}</div>
    <p class="muted">Only approve if the code in the app matches this one.</p>
  </div>
  <div id="go" class="hidden">
    <p class="muted">Approved. The download should start now. If it stops, start it again here; it picks up where it left off.</p>
    <a class="btn" id="dl" href="#">Download the backup</a>
  </div>
  <p class="muted">This link works until ${esc(a.expiresText)}. The backup opens with its passcode or on your own devices.</p>
  <p class="err hidden" id="err"></p>
</main>
<script>
(function () {
  var cfg = ${cfg};
  var started = false;
  document.getElementById("dl").href = cfg.fileUrl;
  function fetchTo(url) {
    var f = document.createElement("iframe");
    f.style.display = "none";
    f.src = url;
    document.body.appendChild(f);
  }
  function show(approved) {
    document.getElementById("ask").classList.toggle("hidden", approved);
    document.getElementById("go").classList.toggle("hidden", !approved);
    if (approved && !started) { started = true; fetchTo(cfg.fileUrl); }
  }
  function fail(msg) { var e = document.getElementById("err"); e.textContent = msg; e.classList.remove("hidden"); }
  function poll() {
    fetch(cfg.statusUrl, { cache: "no-store" }).then(function (r) {
      if (r.status === 404) { fail("This link has expired or was replaced by a newer backup."); return null; }
      return r.json();
    }).then(function (b) {
      if (!b) return;
      show(!!b.approved);
      if (!b.approved) setTimeout(poll, 2000);
    }).catch(function () { setTimeout(poll, 4000); });
  }
  poll();
})();
</script>
</body>
</html>`;
}
