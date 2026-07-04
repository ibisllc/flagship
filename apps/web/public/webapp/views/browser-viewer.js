// P2.7 — Browser-viewer view.
//
// Streams a Chromium tab's framebuffer over WS (P1.11) and accepts
// pointer / keyboard input back. Used to drive a paired-app's
// browser-resident login flow from the user's webapp.
//
// #32 — only reachable from views/service-detail.js's "Open browser viewer"
// button (rendered when the manifest declares a browser bundle or the
// service already has open tabs). The legacy home-grid entry point — which
// fell back to a window.prompt() for the serviceId — is gone. Calling
// enterBrowserViewer() without an serviceId now toasts an error and bails
// instead of prompting.
//
// Lookup flow:
//   1. service-detail invokes enterBrowserViewer(serviceId).
//   2. We poll P1.10 for the app's tab list.
//   3. User picks a tab → we open a WS to P1.11 and start streaming.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError, getPodBaseUrl, getSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

registerView("view-browser-viewer");

let activeAppId = null;
let activeTabId = null;
let socket = null;

function closeSocket() {
  if (socket) {
    try { socket.close(); } catch (_e) { /* ignore */ }
    socket = null;
  }
}

async function renderTabs() {
  if (!activeAppId) return;
  const root = $("bv-tabs");
  root.innerHTML = skeletonCards(2);
  try {
    const body = await screensFetch(
      `/api/screens/browser-tabs/list/${encodeURIComponent(activeAppId)}`,
    );
    if (!body.tabs?.length) {
      root.innerHTML = '<div class="card placeholder">no tabs open for this app</div>';
      return;
    }
    root.innerHTML = body.tabs.map((t) => `
      <div class="card">
        <div class="row">
          <div>
            <div class="weight-600">${escapeHtml(t.title || t.tabId)}</div>
            ${t.currentUrl ? `<div class="value text-xs">${escapeHtml(t.currentUrl)}</div>` : ""}
          </div>
          <button data-action="open" data-tab-id="${escapeHtml(t.tabId)}">Stream</button>
        </div>
      </div>
    `).join("");
    root.querySelectorAll('[data-action="open"]').forEach((b) => {
      b.addEventListener("click", () => openStream(b.getAttribute("data-tab-id")));
    });
  } catch (e) {
    if (e instanceof ScreensError) {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
    } else {
      throw e;
    }
  }
}

function openStream(tabId) {
  closeSocket();
  activeTabId = tabId;
  const baseUrl = getPodBaseUrl();
  const tok = getSessionToken();
  if (!baseUrl || !tok) return toast("Not paired", "err");
  const wsBase = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const url = `${wsBase}/api/screens/browser-tabs/${encodeURIComponent(tabId)}/stream?sessionToken=${encodeURIComponent(tok)}`;
  let s;
  try {
    s = new WebSocket(url);
  } catch (e) {
    return toast(`Could not open stream: ${e.message}`, "err");
  }
  socket = s;
  $("bv-stream-status").textContent = "connecting…";

  const img = $("bv-frame");
  s.addEventListener("open", () => {
    $("bv-stream-status").textContent = `streaming tab ${tabId}`;
  });
  s.addEventListener("message", (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    if (frame.kind === "frame" && typeof frame.dataBase64 === "string") {
      img.src = `data:image/jpeg;base64,${frame.dataBase64}`;
    } else if (frame.kind === "error") {
      toast(frame.message ?? "stream error", "err");
    }
  });
  s.addEventListener("close", () => {
    if (socket === s) socket = null;
    $("bv-stream-status").textContent = "stream closed";
  });
  s.addEventListener("error", () => {
    $("bv-stream-status").textContent = "stream error";
  });

  bindInputForwarding(img, s);
}

function bindInputForwarding(img, s) {
  const sendInput = (input) => {
    if (s.readyState === s.OPEN) {
      s.send(JSON.stringify({ kind: "input", input }));
    }
  };
  // Mouse: translate page coords to image coords using the rendered size.
  const toImgCoords = (ev) => {
    const rect = img.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * (img.naturalWidth || rect.width);
    const y = ((ev.clientY - rect.top) / rect.height) * (img.naturalHeight || rect.height);
    return { x: Math.round(x), y: Math.round(y) };
  };
  img.onmousedown = (ev) => {
    const { x, y } = toImgCoords(ev);
    sendInput({ kind: "mouseDown", x, y, button: "left" });
    ev.preventDefault();
  };
  img.onmouseup = (ev) => {
    const { x, y } = toImgCoords(ev);
    sendInput({ kind: "mouseUp", x, y, button: "left" });
    ev.preventDefault();
  };
  img.onmousemove = (ev) => {
    if (ev.buttons === 0) return; // only forward drags
    const { x, y } = toImgCoords(ev);
    sendInput({ kind: "mouseMove", x, y });
  };
  img.onwheel = (ev) => {
    const { x, y } = toImgCoords(ev);
    sendInput({ kind: "scroll", x, y, deltaX: ev.deltaX, deltaY: ev.deltaY });
    ev.preventDefault();
  };
  // Keyboard: forward when the image has focus.
  img.tabIndex = 0;
  img.onkeydown = (ev) => {
    sendInput({ kind: "key", eventType: "keyDown", key: ev.key, code: ev.code });
    if (ev.key.length === 1) ev.preventDefault();
  };
  img.onkeyup = (ev) => {
    sendInput({ kind: "key", eventType: "keyUp", key: ev.key, code: ev.code });
  };
}

export function initBrowserViewerView() {
  $("browser-viewer-back")?.addEventListener("click", () => {
    closeSocket();
    show("view-home");
  });
  $("bv-refresh")?.addEventListener("click", () => {
    renderTabs().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterBrowserViewer(serviceId) {
  closeSocket();
  // #30 + #32 — serviceId must be provided by the caller (only reachable
  // from service-detail.js for services that declare a browser bundle). The
  // legacy window.prompt() fallback is gone.
  if (!serviceId) {
    toast("Open the browser viewer from a service's detail screen", "err");
    return;
  }
  activeAppId = serviceId;
  activeTabId = null;
  $("bv-app-id").textContent = activeAppId;
  $("bv-frame").src = "";
  $("bv-stream-status").textContent = "no tab selected";
  show("view-browser-viewer");
  await renderTabs();
}
