// The page an app invite link lands on: https://<box>/invite#<secret>&a=&i=&s=.
//
// The link stays on the owner's server (it says whose invite it is, and our
// own sites never see that someone opened one). The page hands the invite to
// the Flagship app: its button is the app link https://<control apex>/invite#…,
// which a tap from this page opens in the installed app; without the app it
// lands on the site's get-the-app page. The web app can accept it too. Both
// links are built in the browser from this page's fragment, so the invite's
// secret is never sent to any server.

import type { HttpRequest, HttpResponse } from "./runtime.js";

export interface InvitePageOptions {
  /** The box fqdn; the page answers only on the box's own host, never an app's. */
  serverId: string;
  /** The control apex. Default https://flagshipserver.com. */
  controlBaseUrl?: string;
}

export function buildInvitePage(opts: InvitePageOptions) {
  const control = new URL(opts.controlBaseUrl ?? "https://flagshipserver.com");
  const appLinkBase = `${control.origin}/invite`;
  const webappBase = `${control.protocol}//webapp.${control.host}/invite`;
  const html = renderInvitePage(appLinkBase, webappBase);

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    const path = req.path.split("?")[0];
    if (path !== "/invite" && path !== "/invite/") return null;
    const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
    if (host !== opts.serverId.toLowerCase()) return null;
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
      },
      body: method === "HEAD" ? "" : html,
    };
  };
}

/**
 * The invite's fragment (`<secret>&a=&i=&s=`, or the older `k=<secret>&…`)
 * rewritten for an app link: `server=<box>&k=<secret>&a=&i=&s=`. Null when the
 * fragment carries no 64-hex secret. Exported for tests; the page inlines it.
 */
export function inviteAppLinkFragment(hash: string, server: string): string | null {
  const h = hash.replace(/^#/, "");
  const m = h.match(/^([0-9a-f]{64})(?:&|$)/i) || h.match(/(?:^|&)k=([0-9a-f]{64})(?:&|$)/i);
  if (!m) return null;
  const out = new URLSearchParams({ server, k: m[1]!.toLowerCase() });
  for (const key of ["a", "i", "s"]) {
    const v = h.match(new RegExp(`(?:^|&)${key}=([^&]*)`));
    if (v && v[1]) out.set(key, decodeURIComponent(v[1]));
  }
  return out.toString();
}

function renderInvitePage(appLinkBase: string, webappBase: string): string {
  const fragmentFn = inviteAppLinkFragment.toString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>You're invited — Flagship</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#f8fafc; color:#0f172a; }
  @media (prefers-color-scheme: dark){ body{ background:#0b1220; color:#e2e8f0 } .card{ background:#111a2e !important } .muted{color:#94a3b8 !important} }
  .card { background:#fff; max-width:380px; width:calc(100% - 32px); border-radius:16px;
    padding:28px 24px; box-shadow:0 10px 40px rgba(2,6,23,.12); text-align:center; }
  h1 { font-size:20px; margin:0 0 6px; }
  .muted { color:#475569; font-size:14px; margin:0 0 20px; }
  .btn { display:block; box-sizing:border-box; width:100%; padding:14px 16px; border-radius:12px;
    background:#14b8a6; color:#fff; font-weight:600; font-size:16px; text-decoration:none; }
  .btn:active { background:#0d9488; }
  .alt { margin:16px 0 0; font-size:13px; }
  .alt a { color:#0d9488; }
  .err { color:#dc2626; font-size:14px; }
</style>
</head>
<body>
  <main class="card">
    <h1>You're invited</h1>
    <p class="muted" id="lede">Someone invited you to an app on their Flagship server. Open the invite in the Flagship app to accept it.</p>
    <a class="btn" id="open" href="${appLinkBase}">Open in the Flagship app</a>
    <p class="alt" id="web">No app? <a id="web-link" href="${webappBase}">Accept in the web app</a></p>
  </main>
<script>
(function(){
  var inviteAppLinkFragment = ${fragmentFn};
  var frag = inviteAppLinkFragment(location.hash, location.hostname);
  if (!frag) {
    document.getElementById("lede").className = "err";
    document.getElementById("lede").textContent = "This invite link is incomplete. Ask for a new one.";
    document.getElementById("open").style.display = "none";
    document.getElementById("web").style.display = "none";
    return;
  }
  document.getElementById("open").href = ${JSON.stringify(appLinkBase)} + "#" + frag;
  document.getElementById("web-link").href = ${JSON.stringify(webappBase)} + "#" + frag;
})();
</script>
</body>
</html>`;
}
