// W10 — vibe-code session chat surface.
//
// Polls GET /api/screens/llm/sessions/<id> and surfaces the AI's
// pending tool request (talkToUser or requestEnvVar) with a reply
// affordance. The requestEnvVar path POSTs to
// /api/screens/services/<appId>/env/set FIRST (the path that actually
// carries the secret value), then finalizes the model-facing ack via
// POST /api/screens/llm/sessions/<id>/reply with envVarStatus="set".

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { signWithIrk, bytesToHex } from "../keystore.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { canonicalSetServiceEnv } from "./service-env.js";

registerView("view-vibecode-chat");

const POLL_INTERVAL_MS = 1500;
const TERMINAL = new Set(["ready-to-deploy", "deployed", "failed", "cancelled"]);

let currentSessionId = null;
let currentServerFqdn = null;
let pollHandle = null;
let lastState = null;

export async function enterVibeCodeChat(sessionId, serverFqdn) {
  currentSessionId = sessionId;
  currentServerFqdn = serverFqdn;
  show("view-vibecode-chat");
  await reload();
  startPolling();
}

export function initVibeCodeChatView() {
  $("vibecode-chat-back")?.addEventListener("click", () => {
    stopPolling();
    show("view-services-list");
  });
}

function stopPolling() {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
}

function startPolling() {
  stopPolling();
  pollHandle = setTimeout(async () => {
    try {
      await reload();
    } catch {
      // ignore — keep polling
    }
    if (!lastState || !TERMINAL.has(lastState.status)) {
      startPolling();
    }
  }, POLL_INTERVAL_MS);
}

async function reload() {
  try {
    const body = await screensFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(currentSessionId)}`,
    );
    lastState = body;
    render(body);
  } catch (e) {
    if (e instanceof ScreensError) toast(e.message, "err");
  }
}

function statusLabel(status) {
  switch (status) {
    case "streaming": return "Generating…";
    case "awaiting-tool-response": return "AI is asking you something";
    case "ready-to-deploy": return "Ready to deploy";
    case "deploying": return "Deploying…";
    case "deployed": return "Deployed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

function render(state) {
  $("vibecode-chat-status").textContent = statusLabel(state.status);
  $("vibecode-chat-id").textContent = state.id;
  $("vibecode-chat-appid").textContent = state.appId ?? "(pre-manifest)";

  const messages = state.messages ?? [];
  const m = $("vibecode-chat-messages");
  if (messages.length === 0) {
    m.innerHTML = '<div class="card placeholder">No messages yet.</div>';
  } else {
    m.innerHTML = messages
      .map(
        (msg) => `
        <div class="card">
          <div class="label">${msg.role === "user" ? "YOU" : "AI"}</div>
          <div class="value">${escapeHtml(msg.text)}</div>
        </div>
      `,
      )
      .join("");
  }

  const pendingBox = $("vibecode-chat-pending");
  if (!state.pendingRequest) {
    pendingBox.classList.add("hidden");
    pendingBox.innerHTML = "";
    return;
  }
  pendingBox.classList.remove("hidden");
  if (state.pendingRequest.kind === "talkToUser") {
    pendingBox.innerHTML = `
      <div class="card">
        <div class="label">AI asked:</div>
        <p class="value">${escapeHtml(state.pendingRequest.payload.message)}</p>
        <textarea id="vibecode-talk-reply" rows="3" placeholder="Type your reply"></textarea>
        <button id="vibecode-talk-send" class="full-width mt-2">Send</button>
      </div>
    `;
    $("vibecode-talk-send").addEventListener("click", () => sendTalkReply(state));
  } else {
    // requestEnvVar
    const p = state.pendingRequest.payload;
    pendingBox.innerHTML = `
      <div class="card">
        <h3>AI needs <code>${escapeHtml(p.name)}</code></h3>
        <p class="value">${escapeHtml(p.description ?? "")}</p>
        <p class="note">Why: ${escapeHtml(p.why ?? "")}</p>
        ${p.example ? `<p class="note">Example: <code>${escapeHtml(p.example)}</code></p>` : ""}
        <input id="vibecode-envvar-value" type="password" placeholder="paste your value" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <p class="note mt-2">Sent once to your server. Not saved in this browser.</p>
        <button id="vibecode-envvar-send" class="full-width mt-2">Send value</button>
        <button id="vibecode-envvar-decline" class="secondary full-width mt-2">Decline</button>
      </div>
    `;
    $("vibecode-envvar-send").addEventListener("click", () => sendEnvVar(state));
    $("vibecode-envvar-decline").addEventListener("click", () => declineEnvVar());
  }
}

async function sendTalkReply(state) {
  const el = $("vibecode-talk-reply");
  const text = el?.value?.trim() ?? "";
  if (!text) return toast("Type a reply first", "err");
  try {
    await screensFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(state.id)}/reply`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    el.value = "";
    await reload();
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}

async function sendEnvVar(state) {
  const el = $("vibecode-envvar-value");
  const value = el?.value ?? "";
  if (!value) return toast("Paste a value first", "err");
  if (!state.appId) return toast("Session has no app id yet", "err");
  const session = getSession();
  if (!session?.umk) return toast("Sign in first.", "err");

  // appId = "<creator>-<slug>" single-dash. Creator is hyphen-free,
  // so the first '-' is the boundary.
  const dashIdx = state.appId.indexOf("-");
  if (dashIdx <= 0) return toast("Invalid app id shape", "err");
  const creator = state.appId.slice(0, dashIdx);
  const slug = state.appId.slice(dashIdx + 1);
  const name = state.pendingRequest.payload.name;

  // Step 1: push the secret VALUE through /env/set (the only path
  // that carries it).
  const issuedAt = Date.now();
  const envelope = {
    serverId: currentServerFqdn,
    creator,
    slug,
    env: { [name]: value },
    issuedAt,
  };
  let signature;
  try {
    const canon = canonicalSetServiceEnv(
      envelope.serverId,
      envelope.creator,
      envelope.slug,
      envelope.env,
      envelope.issuedAt,
    );
    const sig = await signWithIrk(session.umk, canon);
    signature = bytesToHex(sig);
  } catch (e) {
    return toast(`Sign failed: ${e.message ?? e}`, "err");
  }
  try {
    await screensFetch(
      `/api/screens/services/${encodeURIComponent(state.appId)}/env/set`,
      {
        method: "POST",
        body: JSON.stringify({ name, value, request: envelope, signature }),
      },
    );
  } catch (e) {
    return toast(
      e instanceof ScreensError ? e.message : String(e),
      "err",
    );
  }
  // Step 2: finalize the model-facing ack via /reply.
  try {
    await screensFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(state.id)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ envVarStatus: "set" }),
      },
    );
  } catch (e) {
    return toast(
      e instanceof ScreensError ? e.message : String(e),
      "err",
    );
  }
  // Clear from DOM.
  el.value = "";
  toast("Sent");
  await reload();
}

async function declineEnvVar() {
  if (!lastState) return;
  try {
    await screensFetch(
      `/api/screens/llm/sessions/${encodeURIComponent(lastState.id)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ envVarStatus: "declined" }),
      },
    );
    await reload();
  } catch (e) {
    toast(e instanceof ScreensError ? e.message : String(e), "err");
  }
}
