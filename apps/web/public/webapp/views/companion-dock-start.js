import { $, registerView, setSubtitle, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { openRemoteRequest, redeemRemoteTicket } from "../lib/companionDockStart.js";

registerView("view-dock-start");

let activeRequest = null;
let runNumber = 0;
let onDocked = null;

export function initCompanionDockStartView({ onComplete } = {}) {
  onDocked = onComplete ?? null;
  $("dock-restart")?.addEventListener("click", () => void startRequest());
  $("dock-copy")?.addEventListener("click", copyApprovalLink);
}

export function enterCompanionDockStart() {
  setSubtitle("remote");
  show("view-dock-start");
  void startRequest();
}

async function startRequest() {
  const myRun = ++runNumber;
  activeRequest?.close();
  activeRequest = null;
  $("dock-restart")?.classList.add("hidden");
  $("dock-code-step")?.classList.add("hidden");
  setMessage("");
  try {
    const request = await openRemoteRequest({ onCode: (code) => myRun === runNumber && showCode(code) });
    if (myRun !== runNumber) { request.close(); return; }
    activeRequest = request;
    await renderQr(request.approvalUrl);
    const ticket = await request.delivered;
    if (myRun !== runNumber) return;
    setMessage("Approved. Connecting to your server…");
    const persisted = await redeemRemoteTicket(ticket);
    if (myRun !== runNumber) return;
    history.replaceState({}, "", "/");
    await onDocked?.(persisted);
  } catch (error) {
    if (myRun !== runNumber) return;
    if (error?.restart) return void startRequest();
    setMessage(error?.message ?? String(error), true);
    $("dock-restart")?.classList.remove("hidden");
  }
}

function showCode(code) {
  $("dock-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $("dock-code-step")?.classList.remove("hidden");
  setMessage("Waiting for approval on your phone…");
}

async function renderQr(url) {
  const host = $("dock-qr");
  if (!host) return;
  const { renderQrSvg } = await import("/qrEncoder.js");
  host.innerHTML = renderQrSvg(url, { size: 260, foreground: "#0A0A09", background: "#ffffff" });
}

async function copyApprovalLink() {
  if (!activeRequest?.approvalUrl) return;
  try {
    await navigator.clipboard.writeText(activeRequest.approvalUrl);
    toast("Link copied");
  } catch {
    toast("Copy isn't available in this browser", "err");
  }
}

function setMessage(message, isError = false) {
  const node = $("dock-status");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("err-text", isError);
}
