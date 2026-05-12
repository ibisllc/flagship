// Inline async modal helpers (#30).
//
// Replaces `window.prompt()` + `window.confirm()` at all webapp call
// sites. Native prompts/confirms are blocked in installed PWAs on
// most platforms (no system UI), break on iOS standalone, and can't
// be styled to match the brand. Worse, every prompt() steals focus
// from the main thread so a subsequent paste auto-fills the wrong
// surface.
//
// The helpers below build a single-instance overlay, return a Promise,
// and respect Escape / backdrop-click to cancel. They never touch the
// DOM if the user is mid-IME composition (composition events are
// passed through).

const HOST_ID = "flagship-modal-host";

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (host) return host;
  host = document.createElement("div");
  host.id = HOST_ID;
  document.body.appendChild(host);
  return host;
}

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  return overlay;
}

/**
 * Inline prompt — opens an overlay with a single-line input + Cancel /
 * OK buttons. Resolves to the trimmed value on confirm, `null` on
 * cancel. The optional validate(value) callback can return a string
 * to display inline (truthy = error, falsy = OK). The optional type
 * parameter controls the underlying <input> (e.g. "password").
 */
export function inlinePrompt({
  title,
  message,
  placeholder = "",
  initial = "",
  type = "text",
  okLabel = "OK",
  cancelLabel = "Cancel",
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    const host = ensureHost();
    const overlay = buildOverlay();
    const inputId = `modal-input-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    overlay.innerHTML = `
      <div class="modal-card" role="document">
        ${title ? `<h3 class="modal-title">${escapeHtml(title)}</h3>` : ""}
        ${message ? `<p class="modal-message">${escapeHtml(message)}</p>` : ""}
        <input id="${inputId}" type="${type === "password" ? "password" : "text"}"
               placeholder="${escapeHtml(placeholder)}" autocomplete="${type === "password" ? "new-password" : "off"}"
               value="${escapeHtml(initial)}" class="modal-input" />
        <p class="modal-error err-text hidden" data-modal-error></p>
        <div class="row-2 mt-3">
          <button class="secondary" data-modal-cancel>${escapeHtml(cancelLabel)}</button>
          <button data-modal-ok>${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);
    document.body.classList.add("modal-open");

    const input = overlay.querySelector("input");
    const errorEl = overlay.querySelector("[data-modal-error]");
    const okBtn = overlay.querySelector("[data-modal-ok]");
    const cancelBtn = overlay.querySelector("[data-modal-cancel]");
    queueMicrotask(() => input?.focus({ preventScroll: true }));

    const close = (value) => {
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const submit = () => {
      const v = input.value.trim();
      if (validate) {
        const e = validate(v);
        if (e) {
          errorEl.textContent = e;
          errorEl.classList.remove("hidden");
          return;
        }
      }
      close(v);
    };
    const cancel = () => close(null);
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      if (ev.key === "Enter" && document.activeElement === input) { ev.preventDefault(); submit(); }
    };

    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", cancel);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) cancel();
    });
    document.addEventListener("keydown", onKey);
  });
}

/**
 * Inline confirm — opens an overlay with title/message + OK/Cancel.
 * Resolves to `true` on confirm, `false` on cancel. Useful for
 * destructive actions where the toast's auto-dismiss isn't suitable.
 */
export function inlineConfirm({
  title,
  message,
  okLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const host = ensureHost();
    const overlay = buildOverlay();
    overlay.innerHTML = `
      <div class="modal-card" role="document">
        ${title ? `<h3 class="modal-title">${escapeHtml(title)}</h3>` : ""}
        ${message ? `<p class="modal-message">${escapeHtml(message)}</p>` : ""}
        <div class="row-2 mt-3">
          <button class="secondary" data-modal-cancel>${escapeHtml(cancelLabel)}</button>
          <button class="${danger ? "danger" : ""}" data-modal-ok>${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);
    document.body.classList.add("modal-open");

    const okBtn = overlay.querySelector("[data-modal-ok]");
    const cancelBtn = overlay.querySelector("[data-modal-cancel]");
    queueMicrotask(() => okBtn?.focus({ preventScroll: true }));

    const close = (v) => {
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(false); }
      if (ev.key === "Enter") { ev.preventDefault(); close(true); }
    };
    okBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
