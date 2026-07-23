import { $, registerView, setSubtitle, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import {
  activateDockedBrowser,
  beginDockRequest,
  resolveDockServers,
  waitForDockApproval,
} from "../lib/companionDockStart.js";

registerView("view-dock-start");

let activeRequest = null;
let runNumber = 0;
let onDocked = null;

export function initCompanionDockStartView({ onComplete } = {}) {
  onDocked = onComplete ?? null;
  $("dock-find")?.addEventListener("click", findServers);
  $("dock-begin")?.addEventListener("click", beginSelectedDock);
  $("dock-restart")?.addEventListener("click", resetDockStart);
  $("dock-copy")?.addEventListener("click", copyApprovalLink);
  $("dock-username")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void findServers();
  });
}

export function enterCompanionDockStart() {
  setSubtitle("dock a browser");
  show("view-dock-start");
  resetDockStart();
}

async function findServers() {
  const button = $("dock-find");
  const username = $("dock-username")?.value ?? "";
  setBusy(button, true, "Looking…");
  setMessage("");
  try {
    const resolved = await resolveDockServers(username);
    const select = $("dock-server");
    if (!select) return;
    select.innerHTML = resolved.servers.map((server) => `
      <option value="${escapeHtml(server.fqdn)}">
        ${escapeHtml(server.name)}${server.online ? " — online" : ""}
      </option>
    `).join("");
    if (resolved.servers.length === 0) throw new Error("No servers are available for that cloud");
    $("dock-server-step")?.classList.remove("hidden");
    $("dock-begin")?.focus();
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  } finally {
    setBusy(button, false, "Find my server");
  }
}

async function beginSelectedDock() {
  const server = $("dock-server")?.value ?? "";
  if (!server) return;
  const button = $("dock-begin");
  setBusy(button, true, "Creating code…");
  setMessage("");
  const myRun = ++runNumber;
  try {
    activeRequest = await beginDockRequest(`https://${server}`);
    if (myRun !== runNumber) return;
    await renderApproval(activeRequest);
    $("dock-identify-step")?.classList.add("hidden");
    $("dock-server-step")?.classList.add("hidden");
    $("dock-approval-step")?.classList.remove("hidden");
    setMessage("Waiting for approval on your phone…");
    const approved = await waitForDockApproval(activeRequest);
    if (myRun !== runNumber) return;
    const persisted = activateDockedBrowser(approved);
    if (persisted.error) throw new Error(persisted.error);
    setMessage("Approved. Opening your companion…");
    history.replaceState({}, "", "/");
    await onDocked?.(persisted);
  } catch (error) {
    if (myRun !== runNumber) return;
    setMessage(error?.message ?? String(error), true);
    $("dock-restart")?.classList.remove("hidden");
  } finally {
    setBusy(button, false, "Show pairing QR");
  }
}

async function renderApproval(request) {
  const host = $("dock-qr");
  if (!host) return;
  const { renderQrSvg } = await import("/qrEncoder.js");
  host.innerHTML = renderQrSvg(request.approvalUrl, {
    size: 260,
    foreground: "#0A0A09",
    background: "#ffffff",
  });
  $("dock-link").textContent = request.approvalUrl;
}

async function copyApprovalLink() {
  if (!activeRequest?.approvalUrl) return;
  try {
    await navigator.clipboard.writeText(activeRequest.approvalUrl);
    toast("Pairing link copied");
  } catch {
    toast("Copy isn't available in this browser", "err");
  }
}

function resetDockStart() {
  runNumber += 1;
  activeRequest = null;
  $("dock-identify-step")?.classList.remove("hidden");
  $("dock-server-step")?.classList.add("hidden");
  $("dock-approval-step")?.classList.add("hidden");
  $("dock-restart")?.classList.add("hidden");
  setMessage("");
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function setMessage(message, isError = false) {
  const node = $("dock-status");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("err-text", isError);
}
