// The server page's GPU card (packages/server-daemon/src/gpu/http.ts): the words it shows for what
// GET /api/screens/accelerators answers. Pure, so every check reads the sentences the card does.
//
// MIRRORS: iOS AcceleratorsViewModel.swift (AcceleratorsCopy), Android AcceleratorsCopy.kt.

import { tr } from "./i18n.js";
import { formatBytes } from "./serverMonitoring.js";

export const ACCELERATORS_PATH = "/api/screens/accelerators";
export const ACCELERATORS_STOP_PATH = "/api/screens/accelerators/stop";

export const TITLE = tr("GPUs");
export const PAUSED_LINE = tr("New GPU work is paused on this server. Apps that already have a GPU keep it.");
export const WAITING_TITLE = tr("Waiting for a GPU");
export const SERVICE_ERROR = tr("The GPU service on this server didn't answer. Try again in a moment.");
export const STOP_LABEL = tr("Stop");
export const STOP_MESSAGE = tr("The app loses the GPU at once and may stop working until it is started again. The next app waiting gets the GPU.");

/** An app's name from its id: `<account>--<slug>` shows the slug as the app list does. */
export function appName(appId) {
  const id = String(appId ?? "");
  if (id === "flagship-local-ai") return tr("Local AI");
  const slug = id.split("--").pop() || id;
  return slug.replace(/(^|-)([a-z])/g, (_m, sep, c) => sep + c.toUpperCase());
}

export function deviceTitle(d) {
  return tr("GPU {0}: {1}", d?.id ?? "", d?.model ?? "");
}

export function stateLabel(state) {
  switch (state) {
    case "free":
      return tr("Free");
    case "in-use":
      return tr("In use");
    case "quarantined":
      return tr("Set aside after a fault");
    case "display":
      return tr("Drives the screen, so apps can't use it");
    default:
      return tr("Not qualified on this server");
  }
}

/** "24 GB · In use" */
export function deviceLine(d) {
  return `${formatBytes((d?.memoryMiB ?? 0) * 1024 * 1024)} · ${stateLabel(d?.state)}`;
}

export function holderLine(h) {
  const app = appName(h?.appId);
  switch (h?.state) {
    case "reserved":
    case "admitted":
    case "starting":
      return tr("Starting for {0}", app);
    case "releasing":
    case "stopping":
      return tr("{0} is giving it back", app);
    default:
      return tr("Used by {0}", app);
  }
}

export function waitingLine(q) {
  const app = appName(q?.appId);
  return (q?.waiting ?? 1) <= 1 ? tr("{0} is waiting", app) : tr("{0} is waiting ({1} jobs)", app, q.waiting);
}

export const stopTitle = (h) => tr("Stop {0} using the GPU?", appName(h?.appId));
export const stoppedLine = (h) => tr("{0} no longer has the GPU.", appName(h?.appId));

// ---- Approvals (flagship/gpu-approval/v1) ----

export const APPROVALS_PATH = "/api/screens/accelerators/approvals";
export const APPROVALS_WITHDRAW_PATH = "/api/screens/accelerators/approvals/withdraw";
export const APPROVE_LABEL = tr("Approve");
export const DECLINE_LABEL = tr("Decline");
export const WITHDRAW_LABEL = tr("Withdraw");
export const APPROVALS_ADMIN_ONLY = tr("Only an admin device can approve GPU use. This device can see it.");
export const OTHER_SERVER = tr("This request is for another server, so nothing was signed.");

const VENDOR = { "nvidia-cuda": "NVIDIA", "amd-rocm": "AMD", "intel-level-zero": "Intel" };
const CAP_ORDER = ["compute", "graphics", "video-encode", "video-decode"];

function capabilityLabel(c) {
  if (c === "compute") return tr("computing");
  if (c === "graphics") return tr("graphics");
  if (c === "video-encode") return tr("video encoding");
  if (c === "video-decode") return tr("video decoding");
  return c;
}

function policyLabel(p) {
  if (p === "exclusive") return tr("a GPU of its own");
  if (p === "partition") return tr("part of a GPU");
  if (p === "cooperative") return tr("a GPU shared with trusted apps");
  return p;
}

/** What the app gets: "1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps". */
export function termsLine(r) {
  const rank = (c) => (CAP_ORDER.includes(c) ? CAP_ORDER.indexOf(c) : 9);
  const parts = [tr("{0} × {1} GPU", r?.maxCount ?? 1, VENDOR[r?.backend] ?? r?.backend ?? "")];
  parts.push(...[...new Set(r?.caps ?? [])].sort((a, b) => rank(a) - rank(b)).map(capabilityLabel));
  parts.push(...[...new Set(r?.policies ?? [])].sort().map(policyLabel));
  parts.push(r?.isolation === "vm-passthrough" ? tr("in its own virtual machine") : tr("in the app sandbox"));
  if (r?.secrecy) parts.push(tr("kept apart from other apps"));
  return parts.join(", ");
}

export const asksLine = (r) => tr("{0} asks to use the GPU: {1}", appName(r?.appId), termsLine(r));
export const allowedLine = (r) => tr("{0} may use the GPU: {1}", appName(r?.appId), termsLine(r));
export const approvedLine = (r) => tr("{0} can use the GPU.", appName(r?.appId));
export const declinedLine = (r) => tr("{0} won't get a GPU.", appName(r?.appId));
export const withdrawnLine = (r) => tr("{0} can no longer use the GPU.", appName(r?.appId));
export const approvalKey = (r) => `${r?.appId}|${r?.installationId}|${r?.generation}`;

/** The card shows for a box that has, or had, GPU work to show; a box with no GPU stays quiet. */
export function showsCard(view) {
  if (!view || typeof view !== "object") return false;
  if ((view.devices ?? []).length || (view.queue ?? []).length || view.admissionPaused) return true;
  if ((view.pendingApprovals ?? []).length || (view.approvals ?? []).length) return true;
  return !(view.reason == null || view.reason === "no-accelerators" || view.reason === "no-gpu-service");
}
