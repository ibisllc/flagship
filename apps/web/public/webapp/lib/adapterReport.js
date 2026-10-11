// "Report a problem with this adaptation": the owner's note about a shared
// adaptation that doesn't work. It goes to Flagship's public store through
// the box with only the adaptation's id; three reports retire an adaptation
// so the next server's AI makes a better one.
//
// MIRRORS: iOS AdapterReportSheet (ServiceDetailScreen.swift), Android
// AdapterReportViewModel.kt.

import { ScreensError, boxReason } from "./api.js";
import { escapeHtml } from "./util.js";
import { alertCircleIcon } from "./icons.js";

export const MAX_LENGTH = 2000;
export const ROW_TITLE = "Report a problem with this adaptation";
export const TITLE = "Report a problem";
export const PROMPT = "What goes wrong? It helps fix the shared adaptation for everyone.";
export const WARNING =
  "Please don't include anything that identifies you, your server or your data: no names, addresses, emails or passwords.";
export const SENT = "Sent. Thank you.";
export const SENT_NEXT = "To fix it on your server now, use Edit this service to change it with AI.";

export function rowCaption(repo) {
  return `It was set up from a shared adaptation of ${repo}`;
}

export function counterText(detail) {
  return `${String(detail ?? "").length} / ${MAX_LENGTH}`;
}

export function canSend(detail, sending = false) {
  const d = String(detail ?? "");
  return !sending && d.trim().length > 0 && d.length <= MAX_LENGTH;
}

/** Send the trimmed note. Resolves to `{ok:true}` or `{ok:false, message}`
 *  with the box's reason when it gave one. */
export async function sendAdapterReport({ serviceId, detail, fetchJson }) {
  try {
    await fetchJson(`/api/screens/adapter-report/${encodeURIComponent(serviceId)}`, {
      method: "POST",
      body: JSON.stringify({ detail: String(detail ?? "").trim() }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: boxReason(e) ?? (e instanceof ScreensError ? e.message : String(e)) };
  }
}

/** The service page's row, shown when the box says where it was adapted from. */
export function renderReportRow(repo) {
  return `
      <button class="card full-width edit-row" id="sd-report-adapter">
        <span class="edit-row-icon" aria-hidden="true">${alertCircleIcon}</span>
        <span class="edit-row-body">
          <strong>${escapeHtml(ROW_TITLE)}</strong>
          <span class="note">${escapeHtml(rowCaption(repo))}</span>
        </span>
        <span class="build-resume-chevron" aria-hidden="true">›</span>
      </button>`;
}

/** Open the "Report a problem" dialog. Resolves when it closes. */
export function openAdapterReport({ serviceId, fetchJson, doc = globalThis.document }) {
  return new Promise((resolve) => {
    let host = doc.getElementById("flagship-modal-host");
    if (!host) {
      host = doc.createElement("div");
      host.id = "flagship-modal-host";
      doc.body.appendChild(host);
    }
    const overlay = doc.createElement("div");
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="modal-card" role="document">
        <h3 class="modal-title">${escapeHtml(TITLE)}</h3>
        <div data-report-form>
          <p class="modal-message">${escapeHtml(PROMPT)}</p>
          <p class="warn-text">⚠ ${escapeHtml(WARNING)}</p>
          <textarea id="adapter-report-text" class="modal-input" rows="6"></textarea>
          <p class="note" data-report-count>${escapeHtml(counterText(""))}</p>
          <p class="modal-error err-text hidden" data-report-error></p>
          <div class="row-2 mt-3">
            <button class="secondary" data-report-cancel>Cancel</button>
            <button id="adapter-report-send" data-report-send disabled>Send report</button>
          </div>
        </div>
        <div data-report-sent class="hidden">
          <p class="modal-message"><strong>${escapeHtml(SENT)}</strong></p>
          <p class="note">${escapeHtml(SENT_NEXT)}</p>
          <div class="row-2 mt-3"><button data-report-done>Done</button></div>
        </div>
      </div>`;
    host.appendChild(overlay);
    doc.body.classList.add("modal-open");

    const q = (sel) => overlay.querySelector(sel);
    const text = q("#adapter-report-text");
    const count = q("[data-report-count]");
    const errorEl = q("[data-report-error]");
    const send = q("[data-report-send]");
    let sending = false;

    const refresh = () => {
      count.textContent = counterText(text.value);
      count.classList.toggle("err-text", text.value.length > MAX_LENGTH);
      send.disabled = !canSend(text.value, sending);
      send.textContent = sending ? "Sending…" : "Send report";
    };
    const close = () => {
      if (sending) return;
      overlay.remove();
      doc.body.classList.remove("modal-open");
      doc.removeEventListener("keydown", onKey);
      resolve();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(); }
    };

    text.addEventListener("input", refresh);
    send.addEventListener("click", async () => {
      if (!canSend(text.value, sending)) return;
      sending = true;
      errorEl.classList.add("hidden");
      refresh();
      const r = await sendAdapterReport({ serviceId, detail: text.value, fetchJson });
      sending = false;
      if (r.ok) {
        q("[data-report-form]").classList.add("hidden");
        q("[data-report-sent]").classList.remove("hidden");
      } else {
        errorEl.textContent = r.message;
        errorEl.classList.remove("hidden");
        refresh();
      }
    });
    q("[data-report-cancel]").addEventListener("click", close);
    q("[data-report-done]").addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    doc.addEventListener("keydown", onKey);
    queueMicrotask(() => text.focus?.({ preventScroll: true }));
  });
}
